// src/modules/settings/site-settings.service.ts
// DB operations for admin site settings (header, footer, theme, SEO, etc.).
// Cache invalidation is intentionally NOT here — it stays in the route handlers
// which have access to KV from the Hono context.

import {
  orders,
  products,
  siteSettings,
  settings,
  themePreviewSessions,
  themeSettings,
  themeSettingsDrafts,
  themeSettingsVersions,
} from "@scalius/database/schema";
import { eq, and, desc, gt, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  buildBatchGuard,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  AppError,
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

export interface ThemeDraftDocument {
  theme: StorefrontThemeSettings;
  revision: number;
  basePublishedRevision: number;
  updatedAt: Date | null;
}

export interface ThemeWorkspaceDocument {
  published: ThemeSettingsDocument;
  draft: ThemeDraftDocument;
}

export interface ThemeVersionDocument extends ThemeSettingsDocument {
  id: string;
  source: "publish" | "rollback" | "migration";
  sourceRevision: number | null;
  publishedBy: string | null;
  createdAt: Date;
}

export interface ThemePreviewSessionDocument {
  theme: StorefrontThemeSettings;
  draftRevision: number;
  basePublishedRevision: number;
  expiresAt: Date;
}

export const SITE_PRESENTATION_REVISION_CONFLICT =
  "SITE_PRESENTATION_REVISION_CONFLICT";

export type SitePresentationSection = "header" | "footer";

export class SitePresentationRevisionConflictError extends AppError {
  constructor(
    section: SitePresentationSection,
    expectedRevision: number,
    currentRevision: number | null,
  ) {
    super(
      409,
      SITE_PRESENTATION_REVISION_CONFLICT,
      `${section === "header" ? "Header" : "Footer"} settings changed in another session. Your draft was not saved.`,
      { section, expectedRevision, currentRevision },
    );
    this.name = "SitePresentationRevisionConflictError";
  }
}

function assertPresentationRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ValidationError(
      "A non-negative header or footer settings revision is required.",
    );
  }
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

function assertNonnegativeRevision(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`A non-negative ${label} revision is required.`);
  }
}

function serializeThemeSettings(theme: StorefrontThemeSettings): {
  theme: StorefrontThemeSettings;
  serialized: string;
} {
  const sanitized = sanitizeStorefrontThemeSettings(theme);
  return { theme: sanitized, serialized: JSON.stringify(sanitized) };
}

const THEME_REVISION_CONFLICT_SENTINEL = "THEME_REVISION_CONFLICT";

function isThemeRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /THEME_REVISION_CONFLICT|malformed json/iu.test(message);
}

function themeConflict(message: string): ConflictError {
  return new ConflictError(message);
}

async function hashThemePreviewToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    revisions: {
      header: row?.headerConfigRevision ?? 0,
      footer: row?.footerConfigRevision ?? 0,
    },
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
  expectedRevision: number,
): Promise<{ revision: number }> {
  assertPresentationRevision(expectedRevision);
  const normalizedConfig = parseNavigationConfig("header", config);
  const serialized = JSON.stringify(normalizedConfig);

  if (expectedRevision === 0) {
    const inserted = await db
      .insert(siteSettings)
      .values({
        id: "settings_" + nanoid(),
        siteName: "My Store",
        siteDescription: "",
        headerConfig: serialized,
        headerConfigRevision: 1,
        footerConfig: JSON.stringify({}),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .onConflictDoNothing({ target: siteSettings.singletonKey })
      .returning({ revision: siteSettings.headerConfigRevision });
    if (inserted[0]) return inserted[0];
  } else {
    const updated = await db
      .update(siteSettings)
      .set({
        headerConfig: serialized,
        headerConfigRevision: sql`${siteSettings.headerConfigRevision} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(
        eq(siteSettings.singletonKey, "default"),
        eq(siteSettings.headerConfigRevision, expectedRevision),
      ))
      .returning({ revision: siteSettings.headerConfigRevision });
    if (updated[0]) return updated[0];
  }

  const current = await db
    .select({ revision: siteSettings.headerConfigRevision })
    .from(siteSettings)
    .where(eq(siteSettings.singletonKey, "default"))
    .get();
  throw new SitePresentationRevisionConflictError(
    "header",
    expectedRevision,
    current?.revision ?? null,
  );
}

export async function saveFooterConfig(
  db: Database,
  config: Record<string, unknown>,
  expectedRevision: number,
): Promise<{ revision: number }> {
  assertPresentationRevision(expectedRevision);
  const normalizedConfig = parseNavigationConfig("footer", config);
  const serialized = JSON.stringify(normalizedConfig);

  if (expectedRevision === 0) {
    const inserted = await db
      .insert(siteSettings)
      .values({
        id: "settings_" + nanoid(),
        siteName: "My Store",
        siteDescription: "",
        headerConfig: JSON.stringify({}),
        footerConfig: serialized,
        footerConfigRevision: 1,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .onConflictDoNothing({ target: siteSettings.singletonKey })
      .returning({ revision: siteSettings.footerConfigRevision });
    if (inserted[0]) return inserted[0];
  } else {
    const updated = await db
      .update(siteSettings)
      .set({
        footerConfig: serialized,
        footerConfigRevision: sql`${siteSettings.footerConfigRevision} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(
        eq(siteSettings.singletonKey, "default"),
        eq(siteSettings.footerConfigRevision, expectedRevision),
      ))
      .returning({ revision: siteSettings.footerConfigRevision });
    if (updated[0]) return updated[0];
  }

  const current = await db
    .select({ revision: siteSettings.footerConfigRevision })
    .from(siteSettings)
    .where(eq(siteSettings.singletonKey, "default"))
    .get();
  throw new SitePresentationRevisionConflictError(
    "footer",
    expectedRevision,
    current?.revision ?? null,
  );
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

export async function getThemeWorkspace(
  db: Database,
): Promise<ThemeWorkspaceDocument> {
  const published = await getThemeSettings(db);
  const draft = await db
    .select({
      theme: themeSettingsDrafts.theme,
      revision: themeSettingsDrafts.revision,
      basePublishedRevision: themeSettingsDrafts.basePublishedRevision,
      updatedAt: themeSettingsDrafts.updatedAt,
    })
    .from(themeSettingsDrafts)
    .where(eq(themeSettingsDrafts.id, THEME_SETTINGS_ID))
    .get();

  return {
    published,
    draft: draft
      ? {
          theme: parseAuthoritativeThemeSettings(draft.theme),
          revision: draft.revision,
          basePublishedRevision: draft.basePublishedRevision,
          updatedAt: draft.updatedAt,
        }
      : {
          theme: published.theme,
          revision: 0,
          basePublishedRevision: published.revision,
          updatedAt: null,
        },
  };
}

export async function saveThemeDraft(
  db: Database,
  theme: StorefrontThemeSettings,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeDraftDocument> {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  assertNonnegativeRevision(basePublishedRevision, "base published");
  const normalized = serializeThemeSettings(theme);

  if (expectedDraftRevision === 0) {
    const published = await getThemeSettings(db);
    if (published.revision !== basePublishedRevision) {
      throw themeConflict(
        "The published storefront style changed before this draft was created. Reload the latest style and try again.",
      );
    }
    const inserted = await db
      .insert(themeSettingsDrafts)
      .values({
        id: THEME_SETTINGS_ID,
        theme: normalized.serialized,
        revision: 1,
        basePublishedRevision,
        updatedBy: actorId,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .onConflictDoNothing()
      .returning({
        revision: themeSettingsDrafts.revision,
        updatedAt: themeSettingsDrafts.updatedAt,
      });
    if (!inserted[0]) {
      throw themeConflict(
        "The storefront style draft changed in another session. Reload the saved draft before continuing.",
      );
    }
    return {
      theme: normalized.theme,
      revision: inserted[0].revision,
      basePublishedRevision,
      updatedAt: inserted[0].updatedAt,
    };
  }

  const updated = await db
    .update(themeSettingsDrafts)
    .set({
      theme: normalized.serialized,
      revision: sql`${themeSettingsDrafts.revision} + 1`,
      updatedBy: actorId,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(themeSettingsDrafts.id, THEME_SETTINGS_ID),
      eq(themeSettingsDrafts.revision, expectedDraftRevision),
      eq(themeSettingsDrafts.basePublishedRevision, basePublishedRevision),
    ))
    .returning({
      revision: themeSettingsDrafts.revision,
      updatedAt: themeSettingsDrafts.updatedAt,
    });
  if (!updated[0]) {
    throw themeConflict(
      "The storefront style draft changed in another session. Reload the saved draft before continuing.",
    );
  }
  return {
    theme: normalized.theme,
    revision: updated[0].revision,
    basePublishedRevision,
    updatedAt: updated[0].updatedAt,
  };
}

export async function rebaseThemeDraft(
  db: Database,
  theme: StorefrontThemeSettings,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeDraftDocument> {
  if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 1) {
    throw new ValidationError("A positive draft revision is required to rebase.");
  }
  assertNonnegativeRevision(basePublishedRevision, "base published");
  const published = await getThemeSettings(db);
  if (published.revision !== basePublishedRevision) {
    throw themeConflict(
      "The published storefront style changed again before this draft was rebased. Reload and try again.",
    );
  }
  const normalized = serializeThemeSettings(theme);
  const updated = await db
    .update(themeSettingsDrafts)
    .set({
      theme: normalized.serialized,
      revision: sql`${themeSettingsDrafts.revision} + 1`,
      basePublishedRevision,
      updatedBy: actorId,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(themeSettingsDrafts.id, THEME_SETTINGS_ID),
      eq(themeSettingsDrafts.revision, expectedDraftRevision),
    ))
    .returning({
      revision: themeSettingsDrafts.revision,
      updatedAt: themeSettingsDrafts.updatedAt,
    });
  if (!updated[0]) {
    throw themeConflict(
      "The storefront style draft changed in another session. Reload the saved draft before continuing.",
    );
  }
  return {
    theme: normalized.theme,
    revision: updated[0].revision,
    basePublishedRevision,
    updatedAt: updated[0].updatedAt,
  };
}

function buildPublishedThemeRevisionGuard(
  db: Database,
  expectedRevision: number,
) {
  return buildBatchGuard(db, sql`
    CASE WHEN ${expectedRevision === 0
      ? sql`NOT EXISTS (
          SELECT 1 FROM ${themeSettings}
          WHERE ${themeSettings.id} = ${THEME_SETTINGS_ID}
        )`
      : sql`EXISTS (
          SELECT 1 FROM ${themeSettings}
          WHERE ${themeSettings.id} = ${THEME_SETTINGS_ID}
            AND ${themeSettings.revision} = ${expectedRevision}
        )`}
    THEN 1 ELSE json_extract(${THEME_REVISION_CONFLICT_SENTINEL}, '$') END
  `);
}

function buildThemeDraftRevisionGuard(
  db: Database,
  expectedDraftRevision: number,
  basePublishedRevision: number,
) {
  return buildBatchGuard(db, sql`
    CASE WHEN EXISTS (
      SELECT 1 FROM ${themeSettingsDrafts}
      WHERE ${themeSettingsDrafts.id} = ${THEME_SETTINGS_ID}
        AND ${themeSettingsDrafts.revision} = ${expectedDraftRevision}
        AND ${themeSettingsDrafts.basePublishedRevision} = ${basePublishedRevision}
    ) THEN 1 ELSE json_extract(${THEME_REVISION_CONFLICT_SENTINEL}, '$') END
  `);
}

function publishedThemeWriteStatement(
  db: Database,
  serialized: string,
  expectedRevision: number,
) {
  if (expectedRevision === 0) {
    return db.insert(themeSettings).values({
      id: THEME_SETTINGS_ID,
      colors: serialized,
      revision: 1,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    });
  }
  return db
    .update(themeSettings)
    .set({
      colors: serialized,
      revision: sql`${themeSettings.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(themeSettings.id, THEME_SETTINGS_ID),
      eq(themeSettings.revision, expectedRevision),
    ));
}

async function runThemePublishBatch(
  db: Database,
  options: {
    theme: StorefrontThemeSettings;
    expectedPublishedRevision: number;
    expectedDraftRevision?: number;
    actorId: string | null;
    source: "publish" | "rollback";
    sourceRevision?: number | null;
    synchronizeDraft: boolean;
  },
): Promise<ThemeWorkspaceDocument> {
  assertNonnegativeRevision(options.expectedPublishedRevision, "published");
  const normalized = serializeThemeSettings(options.theme);
  const publishedRevision = options.expectedPublishedRevision + 1;
  const statements = [];
  statements.push(
    buildPublishedThemeRevisionGuard(db, options.expectedPublishedRevision),
  );

  if (options.expectedDraftRevision !== undefined) {
    if (!Number.isInteger(options.expectedDraftRevision) || options.expectedDraftRevision < 1) {
      throw new ValidationError("A positive draft revision is required to publish.");
    }
    statements.push(buildThemeDraftRevisionGuard(
      db,
      options.expectedDraftRevision,
      options.expectedPublishedRevision,
    ));
  }

  statements.push(
    publishedThemeWriteStatement(
      db,
      normalized.serialized,
      options.expectedPublishedRevision,
    ) as never,
    db.insert(themeSettingsVersions).values({
      id: `themev_${nanoid()}`,
      publishedRevision,
      theme: normalized.serialized,
      source: options.source,
      sourceRevision: options.sourceRevision ?? null,
      publishedBy: options.actorId,
      createdAt: sql`unixepoch()`,
    }) as never,
  );

  let draftRevision = 0;
  if (options.synchronizeDraft) {
    if (options.expectedDraftRevision === undefined) {
      throw new ValidationError("A draft revision is required to synchronize publication.");
    }
    draftRevision = options.expectedDraftRevision + 1;
    statements.push(
      db
        .update(themeSettingsDrafts)
        .set({
          theme: normalized.serialized,
          revision: sql`${themeSettingsDrafts.revision} + 1`,
          basePublishedRevision: publishedRevision,
          updatedBy: options.actorId,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(themeSettingsDrafts.id, THEME_SETTINGS_ID),
          eq(themeSettingsDrafts.revision, options.expectedDraftRevision),
        )) as never,
    );
  }

  try {
    await safeBatch(db, statements as never);
  } catch (error) {
    if (isThemeRevisionConflict(error)) {
      throw themeConflict(
        "The storefront style or its draft changed in another session. Reload the latest versions before publishing.",
      );
    }
    throw error;
  }

  return {
    published: { theme: normalized.theme, revision: publishedRevision },
    draft: {
      theme: normalized.theme,
      revision: draftRevision,
      basePublishedRevision: publishedRevision,
      updatedAt: new Date(),
    },
  };
}

export async function saveThemeSettings(
  db: Database,
  theme: StorefrontThemeSettings,
  expectedRevision: number,
  actorId: string | null = null,
): Promise<ThemeSettingsDocument> {
  const draft = await db
    .select({ revision: themeSettingsDrafts.revision })
    .from(themeSettingsDrafts)
    .where(and(
      eq(themeSettingsDrafts.id, THEME_SETTINGS_ID),
      eq(themeSettingsDrafts.basePublishedRevision, expectedRevision),
    ))
    .get();
  const result = await runThemePublishBatch(db, {
    theme,
    expectedPublishedRevision: expectedRevision,
    ...(draft ? { expectedDraftRevision: draft.revision } : {}),
    actorId,
    source: "publish",
    synchronizeDraft: Boolean(draft),
  });
  return result.published;
}

export async function publishThemeDraft(
  db: Database,
  expectedPublishedRevision: number,
  expectedDraftRevision: number,
  actorId: string | null = null,
): Promise<ThemeWorkspaceDocument> {
  const draft = await db
    .select({ theme: themeSettingsDrafts.theme })
    .from(themeSettingsDrafts)
    .where(and(
      eq(themeSettingsDrafts.id, THEME_SETTINGS_ID),
      eq(themeSettingsDrafts.revision, expectedDraftRevision),
      eq(themeSettingsDrafts.basePublishedRevision, expectedPublishedRevision),
    ))
    .get();
  if (!draft) {
    throw themeConflict(
      "The storefront style or its draft changed in another session. Reload before publishing.",
    );
  }
  return runThemePublishBatch(db, {
    theme: parseAuthoritativeThemeSettings(draft.theme),
    expectedPublishedRevision,
    expectedDraftRevision,
    actorId,
    source: "publish",
    synchronizeDraft: true,
  });
}

export async function listThemeVersions(
  db: Database,
  limit = 20,
): Promise<ThemeVersionDocument[]> {
  const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
  const rows = await db
    .select({
      id: themeSettingsVersions.id,
      revision: themeSettingsVersions.publishedRevision,
      theme: themeSettingsVersions.theme,
      source: themeSettingsVersions.source,
      sourceRevision: themeSettingsVersions.sourceRevision,
      publishedBy: themeSettingsVersions.publishedBy,
      createdAt: themeSettingsVersions.createdAt,
    })
    .from(themeSettingsVersions)
    .orderBy(desc(themeSettingsVersions.publishedRevision))
    .limit(boundedLimit);
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    theme: parseAuthoritativeThemeSettings(row.theme),
    source: row.source,
    sourceRevision: row.sourceRevision,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt,
  }));
}

export async function rollbackThemeSettings(
  db: Database,
  sourceRevision: number,
  expectedPublishedRevision: number,
  expectedDraftRevision: number,
  actorId: string | null = null,
): Promise<ThemeWorkspaceDocument> {
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1) {
    throw new ValidationError("Choose a positive published theme revision to restore.");
  }
  const source = await db
    .select({ theme: themeSettingsVersions.theme })
    .from(themeSettingsVersions)
    .where(eq(themeSettingsVersions.publishedRevision, sourceRevision))
    .get();
  if (!source) throw new ValidationError("That storefront style revision is unavailable.");
  return runThemePublishBatch(db, {
    theme: parseAuthoritativeThemeSettings(source.theme),
    expectedPublishedRevision,
    expectedDraftRevision,
    actorId,
    source: "rollback",
    sourceRevision,
    synchronizeDraft: true,
  });
}

export async function createThemePreviewSession(
  db: Database,
  expectedDraftRevision: number,
  actorId: string | null = null,
): Promise<ThemePreviewSessionDocument & { token: string }> {
  if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 1) {
    throw new ValidationError("Save the storefront style draft before previewing it.");
  }
  const draft = await db
    .select({
      theme: themeSettingsDrafts.theme,
      revision: themeSettingsDrafts.revision,
      basePublishedRevision: themeSettingsDrafts.basePublishedRevision,
    })
    .from(themeSettingsDrafts)
    .where(and(
      eq(themeSettingsDrafts.id, THEME_SETTINGS_ID),
      eq(themeSettingsDrafts.revision, expectedDraftRevision),
    ))
    .get();
  if (!draft) {
    throw themeConflict(
      "The storefront style draft changed before preview opened. Reload the latest draft.",
    );
  }

  const token = `tpv_${nanoid(48)}`;
  const tokenHash = await hashThemePreviewToken(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await db
    .delete(themePreviewSessions)
    .where(lte(themePreviewSessions.expiresAt, sql`unixepoch()`));
  await db.insert(themePreviewSessions).values({
    tokenHash,
    theme: draft.theme,
    draftRevision: draft.revision,
    basePublishedRevision: draft.basePublishedRevision,
    expiresAt,
    createdBy: actorId,
    createdAt: sql`unixepoch()`,
  });
  return {
    token,
    theme: parseAuthoritativeThemeSettings(draft.theme),
    draftRevision: draft.revision,
    basePublishedRevision: draft.basePublishedRevision,
    expiresAt,
  };
}

export async function resolveThemePreviewSession(
  db: Database,
  token: string,
): Promise<ThemePreviewSessionDocument | null> {
  const normalizedToken = token.trim();
  if (!/^tpv_[A-Za-z0-9_-]{40,80}$/.test(normalizedToken)) return null;
  const tokenHash = await hashThemePreviewToken(normalizedToken);
  const row = await db
    .select({
      theme: themePreviewSessions.theme,
      draftRevision: themePreviewSessions.draftRevision,
      basePublishedRevision: themePreviewSessions.basePublishedRevision,
      expiresAt: themePreviewSessions.expiresAt,
    })
    .from(themePreviewSessions)
    .where(and(
      eq(themePreviewSessions.tokenHash, tokenHash),
      gt(themePreviewSessions.expiresAt, sql`unixepoch()`),
    ))
    .get();
  if (!row) return null;
  return {
    theme: parseAuthoritativeThemeSettings(row.theme),
    draftRevision: row.draftRevision,
    basePublishedRevision: row.basePublishedRevision,
    expiresAt: row.expiresAt,
  };
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
