// src/modules/settings/site-settings.service.ts
// Store presentation and store-detail settings: currency, header/footer,
// homepage, theme workflow, media hosts, SEO, storefront URL, and customer
// countries. Storage lives in ./documents; cache effects stay in the routes.

import {
  orders,
  products,
  themePreviewSessions,
  themeSettings,
  themeSettingsDrafts,
  themeSettingsVersions,
} from "@scalius/database/schema";
import { eq, and, desc, gt, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  AppError,
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import {
  listInvalidStorefrontThemeSettingsEntries,
  parseStorefrontThemeSettings,
  sanitizeStorefrontThemeSettings,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";
import { mergeSeoDiscoverySettings, type SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { mergeSeoReturnPolicySettings, type SeoReturnPolicySettings } from "@scalius/shared/seo-return-policy";
import {
  sanitizeHomepagePresentationConfig,
  type HomepagePresentationConfig,
} from "@scalius/shared/homepage-presentation";
import { readiness, type Readiness } from "@scalius/shared/readiness";
import {
  isMediaReferenceDeletingGuardError,
  MEDIA_REFERENCE_DELETING_MESSAGE,
  noDeletingMediaReferences,
} from "../media/media-reference-guard";
import {
  currencyDocument,
  customerCountriesDocument,
  footerDocument,
  headerDocument,
  homepageDocument,
  mediaDocument,
  normalizeMediaHost,
  seoDocument,
  stripEmbeddedNavigation,
  type CurrencySettings,
  type CustomerCountries,
  type MediaOptimizationSettings,
  type SitePresentationSection,
} from "./documents";
import { getPlatformSettings, savePlatformSettings } from "./platform-settings.service";

const THEME_SETTINGS_ID = "default";

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

export interface ThemePreviewContinuationDocument {
  continuationId: string;
  draftRevision: number;
  basePublishedRevision: number;
  expiresAt: Date;
}

export const SITE_PRESENTATION_REVISION_CONFLICT =
  "SITE_PRESENTATION_REVISION_CONFLICT";
export const HOMEPAGE_PRESENTATION_REVISION_CONFLICT =
  "HOMEPAGE_PRESENTATION_REVISION_CONFLICT";

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
      "A non-negative presentation settings revision is required.",
    );
  }
}

export class HomepagePresentationRevisionConflictError extends AppError {
  constructor(expectedRevision: number, currentRevision: number | null) {
    super(
      409,
      HOMEPAGE_PRESENTATION_REVISION_CONFLICT,
      "Homepage presentation changed in another session. Your changes were not saved.",
      { expectedRevision, currentRevision },
    );
    this.name = "HomepagePresentationRevisionConflictError";
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
  return isBatchGuardError(error, THEME_REVISION_CONFLICT_SENTINEL);
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

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

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
  return currencyDocument.read(db);
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
  const usdExchangeRate = normalizeUsdExchangeRate(data.usdExchangeRate ?? current.usdExchangeRate);

  if (currencyCode !== current.currencyCode && await isCurrencyCodeLocked(db)) {
    throw new ConflictError(CURRENCY_CHANGE_CONFLICT_MESSAGE);
  }

  await currencyDocument.write(db, { currencyCode, currencySymbol, usdExchangeRate });
}

// ─────────────────────────────────────────
// General (header + footer) and homepage presentation
// ─────────────────────────────────────────

/**
 * Stable issue codes for a saved navigation section. `legacy_normalized` means
 * the stored links were safely converted and need one explicit save;
 * `invalid` means the section could not be read, so editing stays locked.
 */
export const NAVIGATION_READINESS_CODES = {
  legacyNormalized: "navigation.legacy_normalized",
  invalid: "navigation.invalid",
} as const;

export async function getGeneralSettings(db: Database) {
  const [header, footer] = await Promise.all([
    headerDocument.readDetailed(db),
    footerDocument.readDetailed(db),
  ]);
  return {
    headerConfig: header.value,
    footerConfig: footer.value,
    revisions: { header: header.revision, footer: footer.revision },
    navigationReadiness: {
      header: readiness.ready(),
      footer: readiness.ready(),
    } satisfies Record<SitePresentationSection, Readiness>,
  };
}

/**
 * Saves one presentation document at the expected revision, rejecting a
 * config that points at media being deleted.
 */
async function savePresentationDocument<T extends object>(
  document: typeof headerDocument | typeof homepageDocument,
  db: Database,
  config: T,
  expectedRevision: number,
  conflict: (currentRevision: number | null) => Error,
): Promise<{ value: T; revision: number }> {
  assertPresentationRevision(expectedRevision);
  const mediaGuard = noDeletingMediaReferences(JSON.stringify(config));
  try {
    return await (document as typeof headerDocument).write(
      db,
      config as Record<string, unknown>,
      {},
      {
        expectedRevision,
        conflict,
        replace: true,
        before: mediaGuard ? [buildBatchGuard(db, mediaGuard, "MEDIA_REFERENCE_DELETING")] : [],
      },
    ) as { value: T; revision: number };
  } catch (error) {
    if (isMediaReferenceDeletingGuardError(error)) {
      throw new ConflictError(MEDIA_REFERENCE_DELETING_MESSAGE);
    }
    throw error;
  }
}

function sitePresentationWriter(section: SitePresentationSection) {
  const document = section === "header" ? headerDocument : footerDocument;
  return async (
    db: Database,
    config: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<{ revision: number }> => {
    const { revision } = await savePresentationDocument(
      document,
      db,
      stripEmbeddedNavigation(section, config),
      expectedRevision,
      (currentRevision) => new SitePresentationRevisionConflictError(
        section,
        expectedRevision,
        currentRevision,
      ),
    );
    return { revision };
  };
}

export const saveHeaderConfig = sitePresentationWriter("header");
export const saveFooterConfig = sitePresentationWriter("footer");

export async function getHomepagePresentationSettings(
  db: Database,
): Promise<{ config: HomepagePresentationConfig; revision: number }> {
  const { value, revision } = await homepageDocument.readDetailed(db);
  return { config: value, revision };
}

export async function saveHomepagePresentationSettings(
  db: Database,
  config: HomepagePresentationConfig,
  expectedRevision: number,
): Promise<{ config: HomepagePresentationConfig; revision: number }> {
  const { value, revision } = await savePresentationDocument(
    homepageDocument,
    db,
    sanitizeHomepagePresentationConfig(config),
    expectedRevision,
    (currentRevision) => new HomepagePresentationRevisionConflictError(
      expectedRevision,
      currentRevision,
    ),
  );
  return { config: value, revision };
}

// ─────────────────────────────────────────
// Theme
// ─────────────────────────────────────────

function selectThemeSettingsRows(db: Database) {
  return db
    .select({
      colors: themeSettings.colors,
      revision: themeSettings.revision,
    })
    .from(themeSettings)
    .where(eq(themeSettings.id, THEME_SETTINGS_ID))
    .limit(1);
}

function selectThemeDraftRows(db: Database) {
  return db
    .select({
      theme: themeSettingsDrafts.theme,
      revision: themeSettingsDrafts.revision,
      basePublishedRevision: themeSettingsDrafts.basePublishedRevision,
      updatedAt: themeSettingsDrafts.updatedAt,
    })
    .from(themeSettingsDrafts)
    .where(eq(themeSettingsDrafts.id, THEME_SETTINGS_ID))
    .limit(1);
}

function themeSettingsDocumentFromRow(
  current: { colors: string; revision: number },
): ThemeSettingsDocument {
  return {
    theme: parseAuthoritativeThemeSettings(current.colors),
    revision: current.revision,
  };
}

/** No published row yet: revision 0 lets the first writer claim revision 1. */
function unpublishedThemeSettings(): ThemeSettingsDocument {
  return { theme: parseStorefrontThemeSettings(undefined), revision: 0 };
}

export async function getThemeSettings(
  db: Database,
): Promise<ThemeSettingsDocument> {
  const current = (await selectThemeSettingsRows(db))[0];

  if (current) {
    return themeSettingsDocumentFromRow(current);
  }

  return unpublishedThemeSettings();
}

export async function getThemeWorkspace(
  db: Database,
): Promise<ThemeWorkspaceDocument> {
  const workspaceResults = await safeBatch(db, [
    selectThemeSettingsRows(db),
    selectThemeDraftRows(db),
  ]);
  const publishedRows = workspaceResults[0] as {
    colors: string;
    revision: number;
  }[];
  const draftRows = workspaceResults[1] as {
    theme: string;
    revision: number;
    basePublishedRevision: number;
    updatedAt: Date;
  }[];
  const published = publishedRows[0]
    ? themeSettingsDocumentFromRow(publishedRows[0])
    : unpublishedThemeSettings();
  const draft = draftRows[0];

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
  return buildBatchGuard(db, expectedRevision === 0
      ? sql`NOT EXISTS (
          SELECT 1 FROM ${themeSettings}
          WHERE ${themeSettings.id} = ${THEME_SETTINGS_ID}
        )`
      : sql`EXISTS (
          SELECT 1 FROM ${themeSettings}
          WHERE ${themeSettings.id} = ${THEME_SETTINGS_ID}
            AND ${themeSettings.revision} = ${expectedRevision}
        )`, THEME_REVISION_CONFLICT_SENTINEL);
}

function buildThemeDraftRevisionGuard(
  db: Database,
  expectedDraftRevision: number,
  basePublishedRevision: number,
) {
  return buildBatchGuard(db, sql`
    EXISTS (
      SELECT 1 FROM ${themeSettingsDrafts}
      WHERE ${themeSettingsDrafts.id} = ${THEME_SETTINGS_ID}
        AND ${themeSettingsDrafts.revision} = ${expectedDraftRevision}
        AND ${themeSettingsDrafts.basePublishedRevision} = ${basePublishedRevision}
    )
  `, THEME_REVISION_CONFLICT_SENTINEL);
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

const THEME_PREVIEW_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const THEME_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL =
  "THEME_PREVIEW_CONTINUATION_CONSUME_CONFLICT";

export async function createThemePreviewSession(
  db: Database,
  expectedDraftRevision: number,
  actorId: string | null = null,
): Promise<ThemePreviewContinuationDocument> {
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

  // This is a one-time browser continuation bearer, carried only in a bounded
  // same-origin POST body. Only the service-authenticated exchange accepts it,
  // and the raw value is never persisted or placed in a URL.
  const continuationId = `tpc_${nanoid(48)}`;
  const tokenHash = await hashThemePreviewToken(continuationId);
  const expiresAt = new Date(Date.now() + THEME_PREVIEW_CONTINUATION_TTL_MS);
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
    continuationId,
    draftRevision: draft.revision,
    basePublishedRevision: draft.basePublishedRevision,
    expiresAt,
  };
}

/**
 * Atomically consume a browser continuation and mint the cookie-only preview
 * bearer. The caller must be the service-authenticated storefront bridge; the
 * raw bearer must never be returned to a dashboard or agent operation.
 */
export async function exchangeThemePreviewContinuation(
  db: Database,
  continuationId: string,
): Promise<ThemePreviewSessionDocument & { token: string }> {
  const normalizedId = continuationId.trim();
  if (!/^tpc_[A-Za-z0-9_-]{48}$/.test(normalizedId)) {
    throw new ConflictError("Theme preview continuation is unavailable or expired.");
  }
  const continuationHash = await hashThemePreviewToken(normalizedId);
  const continuation = await db
    .select({
      theme: themePreviewSessions.theme,
      draftRevision: themePreviewSessions.draftRevision,
      basePublishedRevision: themePreviewSessions.basePublishedRevision,
      expiresAt: themePreviewSessions.expiresAt,
      createdBy: themePreviewSessions.createdBy,
    })
    .from(themePreviewSessions)
    .where(and(
      eq(themePreviewSessions.tokenHash, continuationHash),
      gt(themePreviewSessions.expiresAt, sql`unixepoch()`),
    ))
    .get();
  if (!continuation) {
    throw new ConflictError("Theme preview continuation is unavailable or expired.");
  }

  const token = `tpv_${nanoid(48)}`;
  const tokenHash = await hashThemePreviewToken(token);
  const expiresAt = new Date(Date.now() + THEME_PREVIEW_SESSION_TTL_MS);
  const consumeGuard = buildBatchGuard(db, sql`EXISTS (
    SELECT 1 FROM ${themePreviewSessions}
    WHERE ${themePreviewSessions.tokenHash} = ${continuationHash}
      AND ${themePreviewSessions.expiresAt} > unixepoch()
  )`, THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL);
  try {
    await safeBatch(db, [
      consumeGuard,
      db.delete(themePreviewSessions).where(and(
        eq(themePreviewSessions.tokenHash, continuationHash),
        gt(themePreviewSessions.expiresAt, sql`unixepoch()`),
      )),
      db.insert(themePreviewSessions).values({
        tokenHash,
        theme: continuation.theme,
        draftRevision: continuation.draftRevision,
        basePublishedRevision: continuation.basePublishedRevision,
        expiresAt,
        createdBy: continuation.createdBy,
        createdAt: sql`unixepoch()`,
      }),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL)) {
      throw new ConflictError("Theme preview continuation is unavailable or expired.");
    }
    throw error;
  }
  return {
    token,
    theme: parseAuthoritativeThemeSettings(continuation.theme),
    draftRevision: continuation.draftRevision,
    basePublishedRevision: continuation.basePublishedRevision,
    expiresAt,
  };
}

export async function resolveThemePreviewSession(
  db: Database,
  token: string,
): Promise<ThemePreviewSessionDocument | null> {
  const normalizedToken = token.trim();
  if (!/^tpv_[A-Za-z0-9_-]{48}$/.test(normalizedToken)) return null;
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
// Media delivery hosts
// ─────────────────────────────────────────

export function isValidMediaHostInput(value: string): boolean {
  return !value.trim() || normalizeMediaHost(value) !== "";
}

export async function getMediaOptimizationSettings(
  db: Database,
): Promise<MediaOptimizationSettings> {
  return mediaDocument.read(db);
}

export async function saveMediaOptimizationSettings(
  db: Database,
  data: Partial<MediaOptimizationSettings>,
): Promise<MediaOptimizationSettings> {
  return (await mediaDocument.write(db, data)).value;
}

// ─────────────────────────────────────────
// SEO
// ─────────────────────────────────────────

export async function getSeoSettings(db: Database) {
  return seoDocument.read(db);
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
  const current = data.discovery !== undefined || data.returnPolicy !== undefined
    ? await getSeoSettings(db)
    : null;
  await seoDocument.write(db, {
    siteTitle: data.siteTitle,
    homepageTitle: data.homepageTitle,
    homepageMetaDescription: data.homepageMetaDescription,
    robotsTxt: data.robotsTxt,
    discovery: current && data.discovery !== undefined
      ? mergeSeoDiscoverySettings(current.discovery, data.discovery)
      : undefined,
    returnPolicy: current && data.returnPolicy !== undefined
      ? mergeSeoReturnPolicySettings(current.returnPolicy, data.returnPolicy)
      : undefined,
  });
}

// ─────────────────────────────────────────
// Storefront URL (the platform document's storefront origin)
// ─────────────────────────────────────────

export async function getStorefrontUrlSetting(db: Database) {
  return { storefrontUrl: (await getPlatformSettings(db)).storefrontUrl };
}

export async function saveStorefrontUrl(
  db: Database,
  url: string,
  kv?: Parameters<typeof savePlatformSettings>[2],
) {
  await savePlatformSettings(db, { storefrontUrl: url }, kv);
}

// ─────────────────────────────────────────
// Customer countries
// ─────────────────────────────────────────

export async function getAllowedCountries(db: Database): Promise<CustomerCountries> {
  return customerCountriesDocument.read(db);
}

export async function saveAllowedCountries(
  db: Database,
  allowedCountries: string[],
  mode: "include" | "exclude" = "include",
): Promise<CustomerCountries> {
  return (await customerCountriesDocument.write(db, {
    allowedCountries,
    allowedCountriesMode: mode,
  })).value;
}
