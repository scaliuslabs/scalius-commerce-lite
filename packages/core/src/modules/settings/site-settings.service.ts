// src/modules/settings/site-settings.service.ts
// DB operations for admin site settings (header, footer, theme, SEO, etc.).
// Cache invalidation is intentionally NOT here — it stays in the route handlers
// which have access to KV from the Hono context.

import { siteSettings, settings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { upsertSetting } from "../payments/gateway-settings";
import { sanitizeStorefrontThemeColors } from "@scalius/shared/storefront-theme";

const MEDIA_SETTINGS_CATEGORY = "media";
const IMAGE_OPTIMIZATION_KEY = "image_optimization";

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

export async function getCurrencySettings(db: Database) {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, "currency"))
    .all();

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return {
    currencyCode: map["currency_code"] ?? "BDT",
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
  const ops: Promise<void>[] = [];

  if (typeof data.currencyCode === "string" && data.currencyCode.trim()) {
    ops.push(
      upsertSetting(db, "currency", "currency_code", data.currencyCode.trim()),
    );
  }
  if (typeof data.currencySymbol === "string" && data.currencySymbol.trim()) {
    ops.push(
      upsertSetting(
        db,
        "currency",
        "currency_symbol",
        data.currencySymbol.trim(),
      ),
    );
  }
  if (typeof data.usdExchangeRate === "string" && data.usdExchangeRate.trim()) {
    const rate = parseFloat(data.usdExchangeRate.trim());
    if (!isNaN(rate) && rate > 0) {
      ops.push(
        upsertSetting(db, "currency", "usd_exchange_rate", String(rate)),
      );
    }
  }
  await Promise.all(ops);
}

// ─────────────────────────────────────────
// General (header + footer)
// ─────────────────────────────────────────

export async function getGeneralSettings(db: Database) {
  const [row] = await db.select().from(siteSettings).limit(1);
  const safeParseJSON = (val: string | null | undefined) => {
    if (!val) return {};
    try {
      return JSON.parse(val);
    } catch {
      return {};
    }
  };
  return {
    headerConfig: safeParseJSON(row?.headerConfig),
    footerConfig: safeParseJSON(row?.footerConfig),
  };
}

export async function saveHeaderConfig(
  db: Database,
  config: Record<string, unknown>,
) {
  await db
    .insert(siteSettings)
    .values({
      id: "settings_" + nanoid(),
      siteName: "My Store",
      siteDescription: "",
      headerConfig: JSON.stringify(config),
      footerConfig: JSON.stringify({}),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: siteSettings.singletonKey,
      set: {
        headerConfig: JSON.stringify(config),
        updatedAt: sql`unixepoch()`,
      },
    });
}

export async function saveFooterConfig(
  db: Database,
  config: Record<string, unknown>,
) {
  await db
    .insert(siteSettings)
    .values({
      id: "settings_" + nanoid(),
      siteName: "My Store",
      siteDescription: "",
      headerConfig: JSON.stringify({}),
      footerConfig: JSON.stringify(config),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoUpdate({
      target: siteSettings.singletonKey,
      set: {
        footerConfig: JSON.stringify(config),
        updatedAt: sql`unixepoch()`,
      },
    });
}

// ─────────────────────────────────────────
// Theme
// ─────────────────────────────────────────

export async function getThemeSettings(db: Database) {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.category, "theme"),
        eq(settings.key, "storefront_colors"),
      ),
    )
    .get();

  let colors: unknown = {};
  if (row?.value) {
    try {
      colors = JSON.parse(row.value);
    } catch (e: unknown) {
      console.warn(
        "[Settings] Failed to parse storefront theme colors:",
        e instanceof Error ? e.message : e,
      );
    }
  }
  return { colors: sanitizeStorefrontThemeColors(colors as Record<string, unknown>) };
}

export async function saveThemeSettings(
  db: Database,
  colors: Record<string, unknown>,
) {
  const sanitized = sanitizeStorefrontThemeColors(colors);
  await upsertSetting(db, "theme", "storefront_colors", JSON.stringify(sanitized));
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
  const [row] = await db
    .select({
      siteTitle: siteSettings.siteTitle,
      homepageTitle: siteSettings.homepageTitle,
      homepageMetaDescription: siteSettings.homepageMetaDescription,
      robotsTxt: siteSettings.robotsTxt,
    })
    .from(siteSettings)
    .limit(1);

  return {
    siteTitle: row?.siteTitle || "",
    homepageTitle: row?.homepageTitle || "",
    homepageMetaDescription: row?.homepageMetaDescription || "",
    robotsTxt: row?.robotsTxt || "",
  };
}

export async function saveSeoSettings(
  db: Database,
  data: {
    siteTitle?: string;
    homepageTitle?: string;
    homepageMetaDescription?: string;
    robotsTxt?: string;
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

  await db
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
    });
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
