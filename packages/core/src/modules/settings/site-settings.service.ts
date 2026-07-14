// src/modules/settings/site-settings.service.ts
// DB operations for admin site settings (header, footer, theme, SEO, etc.).
// Cache invalidation is intentionally NOT here — it stays in the route handlers
// which have access to KV from the Hono context.

import {
  orders,
  products,
  siteSettings,
  settings,
  themeSettings,
} from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { upsertSetting } from "../payments/gateway-settings";
import {
  normalizeSupportedCurrencyCode,
  type SupportedCurrencyCode,
} from "@scalius/shared/currency";
import {
  listInvalidStorefrontThemeSettingsEntries,
  parseStorefrontThemeSettings,
  sanitizeStorefrontThemeSettings,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";
import {
  mergeSeoDiscoverySettings,
  parseSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  mergeSeoReturnPolicySettings,
  parseSeoReturnPolicySettings,
  type SeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";
import {
  parseNavigationConfig,
  readPersistedNavigationConfig,
} from "../navigation/navigation.validation";
import { resolveNavigationConfigs } from "../navigation/navigation.resolver";

const MEDIA_SETTINGS_CATEGORY = "media";
const IMAGE_OPTIMIZATION_KEY = "image_optimization";
const SEO_SETTINGS_CATEGORY = "seo";
const DISCOVERY_SETTINGS_KEY = "discovery";
const RETURN_POLICY_SETTINGS_KEY = "return_policy";
const THEME_SETTINGS_ID = "default";
const THEME_SETTINGS_CATEGORY = "theme";
const THEME_COLORS_KEY = "storefront_colors";

export interface ThemeSettingsDocument {
  theme: StorefrontThemeSettings;
  revision: number;
}

function parseAuthoritativeThemeSettings(value: string): StorefrontThemeSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ServiceUnavailableError(
      "Published storefront style is unreadable. Re-save it before editing.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServiceUnavailableError(
      "Published storefront style is unreadable. Re-save it before editing.",
    );
  }
  const record = parsed as Record<string, unknown>;
  // Flat color maps are the pre-semantic versioned document and are upgraded
  // on read. Fully semantic documents must remain exact and fail closed.
  const isSemanticDocument = [
    "colors",
    "typography",
    "cornerStyle",
    "density",
    "containerWidth",
    "components",
  ].some((key) => key in record);
  if (isSemanticDocument) {
    const invalid = listInvalidStorefrontThemeSettingsEntries(record);
    const missingRequiredSection = !("colors" in record);
    if (missingRequiredSection || invalid.length > 0) {
      throw new ServiceUnavailableError(
        "Published storefront style contains unsupported values. Re-save it before editing.",
      );
    }
  }
  return sanitizeStorefrontThemeSettings(record);
}

type PartialSeoDiscoverySettings = {
  [Section in keyof SeoDiscoverySettings]?: Partial<SeoDiscoverySettings[Section]>;
};
type PartialSeoReturnPolicySettings = Partial<SeoReturnPolicySettings>;

export interface MediaOptimizationSettings {
  enabled: boolean;
  canonicalCdnUrl: string;
  allowedImageHosts: string[];
  canonicalHostAliases: string[];
}

export function normalizeMediaHost(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/\s/.test(raw)) return "";

  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return "";
    if (parsed.pathname && parsed.pathname !== "/") return "";
    const host = parsed.hostname.toLowerCase();
    if (!isValidMediaHost(host)) return "";
    return host;
  } catch {
    return "";
  }
}

export function isValidMediaHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253) return false;
  if (host === "localhost") return true;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[a-z0-9-]+$/.test(label);
  });
}

export function isValidMediaHostInput(value: string): boolean {
  return !value.trim() || normalizeMediaHost(value) !== "";
}

function normalizeHostList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeMediaHost).filter(Boolean))];
}

export function parseMediaOptimizationSettings(
  value: string | null | undefined,
): MediaOptimizationSettings {
  if (!value) {
    return {
      enabled: true,
      canonicalCdnUrl: "",
      allowedImageHosts: [],
      canonicalHostAliases: [],
    };
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      enabled: parsed.enabled !== false,
      canonicalCdnUrl: normalizeMediaHost(parsed.canonicalCdnUrl),
      allowedImageHosts: normalizeHostList(parsed.allowedImageHosts),
      canonicalHostAliases: normalizeHostList(parsed.canonicalHostAliases),
    };
  } catch {
    return {
      enabled: true,
      canonicalCdnUrl: "",
      allowedImageHosts: [],
      canonicalHostAliases: [],
    };
  }
}

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

export interface CurrencySettings {
  currencyCode: SupportedCurrencyCode;
  currencySymbol: string;
  usdExchangeRate: string;
}

const CURRENCY_CHANGE_CONFLICT_MESSAGE =
  "Currency code cannot be changed after products or orders exist. You can still update the currency symbol and USD exchange rate.";

function normalizeUsdExchangeRate(value: string): string {
  const trimmed = value.trim();
  const rate = Number(trimmed);

  if (!trimmed || !Number.isFinite(rate) || rate <= 0) {
    throw new ValidationError(
      "USD exchange rate must be a finite number greater than 0.",
    );
  }

  return String(rate);
}

export async function isCurrencyCodeLocked(db: Database): Promise<boolean> {
  const [productRows, orderRows] = await safeBatch(db, [
    db.select({ id: products.id }).from(products).limit(1),
    db.select({ id: orders.id }).from(orders).limit(1),
  ]);

  return Boolean(productRows?.length || orderRows?.length);
}

export async function getCurrencySettings(db: Database): Promise<CurrencySettings> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, "currency"))
    .all();

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const currencyCode = normalizeSupportedCurrencyCode(map["currency_code"]);

  if (!currencyCode) {
    return {
      currencyCode: "BDT",
      currencySymbol: "\u09F3",
      usdExchangeRate: "1",
    };
  }

  return {
    currencyCode,
    currencySymbol: map["currency_symbol"] ?? "\u09F3",
    usdExchangeRate: map["usd_exchange_rate"] ?? "1",
  };
}

export async function saveCurrencySettings(
  db: Database,
  data: {
    currencyCode?: string;
    currencySymbol?: string;
    usdExchangeRate?: string;
  },
) {
  const current = await getCurrencySettings(db);
  const currencyCode = data.currencyCode === undefined
    ? current.currencyCode
    : normalizeSupportedCurrencyCode(data.currencyCode);

  if (!currencyCode) {
    throw new ValidationError("Select a supported three-letter currency code.");
  }

  const currencySymbol = typeof data.currencySymbol === "string" && data.currencySymbol.trim()
    ? data.currencySymbol.trim()
    : current.currencySymbol;
  const usdExchangeRate = data.usdExchangeRate === undefined
    ? normalizeUsdExchangeRate(current.usdExchangeRate)
    : normalizeUsdExchangeRate(data.usdExchangeRate);

  if (currencyCode !== current.currencyCode) {
    if (await isCurrencyCodeLocked(db)) {
      throw new ConflictError(CURRENCY_CHANGE_CONFLICT_MESSAGE);
    }
  }

  const settingUpsert = (key: string, value: string) =>
    db
      .insert(settings)
      .values({
        id: crypto.randomUUID(),
        key,
        value,
        type: "string",
        category: "currency",
      })
      .onConflictDoUpdate({
        target: [settings.key, settings.category],
        set: { value, updatedAt: sql`unixepoch()` },
      });

  await safeBatch(db, [
    settingUpsert("currency_code", currencyCode),
    settingUpsert("currency_symbol", currencySymbol),
    settingUpsert("usd_exchange_rate", usdExchangeRate),
  ]);
}

// ─────────────────────────────────────────
// General (header + footer)
// ─────────────────────────────────────────

export async function getGeneralSettings(db: Database) {
  const [row] = await db.select().from(siteSettings).limit(1);
  const headerRead = readPersistedNavigationConfig("header", row?.headerConfig);
  const footerRead = readPersistedNavigationConfig("footer", row?.footerConfig);
  const resolved = await resolveNavigationConfigs(
    db,
    headerRead.config,
    footerRead.config,
    "admin",
  );
  return {
    ...resolved,
    navigationReadiness: {
      header: {
        state: headerRead.state,
        ...(headerRead.message ? { message: headerRead.message } : {}),
      },
      footer: {
        state: footerRead.state,
        ...(footerRead.message ? { message: footerRead.message } : {}),
      },
    },
  };
}

export async function saveHeaderConfig(
  db: Database,
  config: Record<string, unknown>,
) {
  const normalizedConfig = parseNavigationConfig("header", config);
  await db
    .insert(siteSettings)
    .values({
      id: "settings_" + nanoid(),
      siteName: "My Store",
      siteDescription: "",
      headerConfig: JSON.stringify(normalizedConfig),
      footerConfig: JSON.stringify({}),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: siteSettings.singletonKey,
      set: {
        headerConfig: JSON.stringify(normalizedConfig),
        updatedAt: sql`unixepoch()`,
      },
    });
}

export async function saveFooterConfig(
  db: Database,
  config: Record<string, unknown>,
) {
  const normalizedConfig = parseNavigationConfig("footer", config);
  await db
    .insert(siteSettings)
    .values({
      id: "settings_" + nanoid(),
      siteName: "My Store",
      siteDescription: "",
      headerConfig: JSON.stringify({}),
      footerConfig: JSON.stringify(normalizedConfig),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: siteSettings.singletonKey,
      set: {
        footerConfig: JSON.stringify(normalizedConfig),
        updatedAt: sql`unixepoch()`,
      },
    });
}

// ─────────────────────────────────────────
// Theme
// ─────────────────────────────────────────

export async function getThemeSettings(
  db: Database,
): Promise<ThemeSettingsDocument> {
  const current = await db
    .select({
      colors: themeSettings.colors,
      revision: themeSettings.revision,
    })
    .from(themeSettings)
    .where(eq(themeSettings.id, THEME_SETTINGS_ID))
    .get();

  if (current) {
    return {
      theme: parseAuthoritativeThemeSettings(current.colors),
      revision: current.revision,
    };
  }

  // Pre-versioned installations stored colors in the generic settings table.
  // A missing document is represented as revision 0 so the first writer can
  // atomically claim revision 1 without overwriting another first writer.
  const legacy = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.category, THEME_SETTINGS_CATEGORY),
        eq(settings.key, THEME_COLORS_KEY),
      ),
    )
    .get();
  return { theme: parseStorefrontThemeSettings(legacy?.value), revision: 0 };
}

export async function saveThemeSettings(
  db: Database,
  theme: StorefrontThemeSettings,
  expectedRevision: number,
): Promise<ThemeSettingsDocument> {
  const sanitized = sanitizeStorefrontThemeSettings(theme);
  const serialized = JSON.stringify(sanitized);

  if (expectedRevision === 0) {
    const inserted = await db
      .insert(themeSettings)
      .values({
        id: THEME_SETTINGS_ID,
        colors: serialized,
        revision: 1,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .onConflictDoNothing()
      .returning({ revision: themeSettings.revision });
    if (inserted[0]) return { theme: sanitized, revision: inserted[0].revision };
    throw new ConflictError(
      "The storefront theme was published from another session. Your draft is still available; load the latest saved theme before publishing again.",
    );
  }

  const updated = await db
    .update(themeSettings)
    .set({
      colors: serialized,
      revision: sql`${themeSettings.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(themeSettings.id, THEME_SETTINGS_ID),
        eq(themeSettings.revision, expectedRevision),
      ),
    )
    .returning({ revision: themeSettings.revision });
  if (!updated[0]) {
    throw new ConflictError(
      "The storefront theme was published from another session. Your draft is still available; load the latest saved theme before publishing again.",
    );
  }
  return { theme: sanitized, revision: updated[0].revision };
}

// ─────────────────────────────────────────
// Media / Image optimization
// ─────────────────────────────────────────

export async function getMediaOptimizationSettings(
  db: Database,
): Promise<MediaOptimizationSettings> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.category, MEDIA_SETTINGS_CATEGORY),
        eq(settings.key, IMAGE_OPTIMIZATION_KEY),
      ),
    )
    .get();

  return parseMediaOptimizationSettings(row?.value);
}

export async function saveMediaOptimizationSettings(
  db: Database,
  data: Partial<MediaOptimizationSettings>,
): Promise<MediaOptimizationSettings> {
  const current = await getMediaOptimizationSettings(db);
  const settingsToSave: MediaOptimizationSettings = {
    enabled: typeof data.enabled === "boolean" ? data.enabled : current.enabled,
    canonicalCdnUrl:
      data.canonicalCdnUrl !== undefined
        ? normalizeMediaHost(data.canonicalCdnUrl)
        : current.canonicalCdnUrl,
    allowedImageHosts:
      data.allowedImageHosts !== undefined
        ? normalizeHostList(data.allowedImageHosts)
        : current.allowedImageHosts,
    canonicalHostAliases:
      data.canonicalHostAliases !== undefined
        ? normalizeHostList(data.canonicalHostAliases)
        : current.canonicalHostAliases,
  };

  await upsertSetting(
    db,
    MEDIA_SETTINGS_CATEGORY,
    IMAGE_OPTIMIZATION_KEY,
    JSON.stringify(settingsToSave),
  );
  return settingsToSave;
}

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

export async function getSeoSettings(db: Database) {
  const [siteRows, discoveryRows, returnPolicyRows] = await db.batch([
    db
      .select({
        siteTitle: siteSettings.siteTitle,
        homepageTitle: siteSettings.homepageTitle,
        homepageMetaDescription: siteSettings.homepageMetaDescription,
        robotsTxt: siteSettings.robotsTxt,
      })
      .from(siteSettings)
      .limit(1),
    db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.category, SEO_SETTINGS_CATEGORY),
          eq(settings.key, DISCOVERY_SETTINGS_KEY),
        ),
      )
      .limit(1),
    db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.category, SEO_SETTINGS_CATEGORY),
          eq(settings.key, RETURN_POLICY_SETTINGS_KEY),
        ),
      )
      .limit(1),
  ]);

  const row = siteRows[0];
  const discoveryRow = discoveryRows[0];
  const returnPolicyRow = returnPolicyRows[0];

  return {
    siteTitle: row?.siteTitle || "",
    homepageTitle: row?.homepageTitle || "",
    homepageMetaDescription: row?.homepageMetaDescription || "",
    robotsTxt: row?.robotsTxt || "",
    discovery: parseSeoDiscoverySettings(discoveryRow?.value),
    returnPolicy: parseSeoReturnPolicySettings(returnPolicyRow?.value),
  };
}

export async function saveSeoSettings(
  db: Database,
  data: {
    siteTitle?: string;
    homepageTitle?: string;
    homepageMetaDescription?: string;
    robotsTxt?: string;
    discovery?: PartialSeoDiscoverySettings;
    returnPolicy?: PartialSeoReturnPolicySettings;
  },
) {
  // Filter out undefined values to avoid NULLing existing data
  const updates: Record<string, unknown> = {};
  if (data.siteTitle !== undefined) updates.siteTitle = data.siteTitle;
  if (data.homepageTitle !== undefined)
    updates.homepageTitle = data.homepageTitle;
  if (data.homepageMetaDescription !== undefined)
    updates.homepageMetaDescription = data.homepageMetaDescription;
  if (data.robotsTxt !== undefined) updates.robotsTxt = data.robotsTxt;

  const ops: Promise<unknown>[] = [];

  if (Object.keys(updates).length > 0) {
    ops.push(
      db
        .insert(siteSettings)
        .values({
          id: "settings_" + nanoid(),
          siteName: "My Store",
          headerConfig: JSON.stringify({}),
          footerConfig: JSON.stringify({}),
          ...updates,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .onConflictDoUpdate({
          target: siteSettings.singletonKey,
          set: {
            ...updates,
            updatedAt: sql`unixepoch()`,
          },
        }),
    );
  }

  if (data.discovery !== undefined) {
    const current = await getSeoSettings(db);
    const discovery = mergeSeoDiscoverySettings(current.discovery, data.discovery);
    ops.push(
      upsertSetting(
        db,
        SEO_SETTINGS_CATEGORY,
        DISCOVERY_SETTINGS_KEY,
        JSON.stringify(discovery),
      ),
    );
  }

  if (data.returnPolicy !== undefined) {
    const current = await getSeoSettings(db);
    const returnPolicy = mergeSeoReturnPolicySettings(
      current.returnPolicy,
      data.returnPolicy,
    );
    ops.push(
      upsertSetting(
        db,
        SEO_SETTINGS_CATEGORY,
        RETURN_POLICY_SETTINGS_KEY,
        JSON.stringify(returnPolicy),
      ),
    );
  }

  await Promise.all(ops);
}

// ─────────────────────────────────────────
// Storefront URL
// ─────────────────────────────────────────

export async function getStorefrontUrlSetting(db: Database) {
  const [row] = await db
    .select({ storefrontUrl: siteSettings.storefrontUrl })
    .from(siteSettings)
    .limit(1);
  return { storefrontUrl: row?.storefrontUrl || "/" };
}

export async function saveStorefrontUrl(db: Database, url?: string) {
  await db
    .insert(siteSettings)
    .values({
      id: "settings_" + nanoid(),
      siteName: "My Store",
      headerConfig: JSON.stringify({}),
      footerConfig: JSON.stringify({}),
      storefrontUrl: url || "/",
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: siteSettings.singletonKey,
      set: {
        storefrontUrl: url || "/",
        updatedAt: sql`unixepoch()`,
      },
    });
}

// ─────────────────────────────────────────
// Allowed Countries
// ─────────────────────────────────────────

export async function getAllowedCountries(db: Database) {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.category, "phone"),
        eq(settings.key, "allowed_countries"),
      ),
    )
    .get();

  let allowedCountries: string[] = [];
  let allowedCountriesMode: "include" | "exclude" = "include";
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        // Backward compat: old format was just an array
        allowedCountries = parsed;
      } else if (parsed && typeof parsed === "object") {
        allowedCountries = Array.isArray(parsed.countries)
          ? parsed.countries
          : [];
        allowedCountriesMode =
          parsed.mode === "exclude" ? "exclude" : "include";
      }
    } catch {
      // Invalid JSON — defaults
    }
  }
  return { allowedCountries, allowedCountriesMode };
}

export async function saveAllowedCountries(
  db: Database,
  allowedCountries: string[],
  mode: "include" | "exclude" = "include",
) {
  const stored = JSON.stringify({ countries: allowedCountries, mode });
  await upsertSetting(db, "phone", "allowed_countries", stored);
  return { allowedCountries, allowedCountriesMode: mode };
}
