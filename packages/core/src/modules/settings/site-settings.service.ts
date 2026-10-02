// src/modules/settings/site-settings.service.ts
// Store presentation and store-detail settings: currency, the theme workflow
// (everything that shapes how the storefront looks: brand, announcement,
// footer words, homepage sections and what `/` shows), media hosts, SEO,
// storefront URL, and customer countries. Storage lives in ./documents;
// cache effects stay in the routes.

import {
  media,
  orders,
  products,
  shippingMethods,
  themePreviewSessions,
  themeSettings,
  themeSettingsDrafts,
  themeSettingsVersions,
} from "@scalius/database/schema";
import { eq, and, desc, gt, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import {
  DEFAULT_STOREFRONT_THEME,
  parseStoredStorefrontThemeDocument,
  storefrontThemeDocumentSchema,
  storefrontThemeMediaReferences,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { mergeSeoDiscoverySettings, type SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { mergeSeoReturnPolicySettings, type SeoReturnPolicySettings } from "@scalius/shared/seo-return-policy";
import {
  currencyDocument,
  customerCountriesDocument,
  mediaDocument,
  normalizeMediaHost,
  seoDocument,
  type CurrencySettings,
  type CustomerCountries,
  type MediaOptimizationSettings,
} from "./documents";
import type { SettingsDocument, SettingsDocumentWriteResult } from "./settings-store";

const THEME_SETTINGS_ID = "default";

/** Published versions kept for history and restore: the most the history list returns. */
export const THEME_VERSION_HISTORY_LIMIT = 50;

/** The revision the merchant's editor loaded; a stale one is a 409 conflict. */
export interface SettingsSaveOptions {
  expectedRevision?: number;
}

/** A document as an editor loads it: its value and the revision a save must send back. */
export async function readSettingsForEdit<T extends object>(
  db: Database,
  document: SettingsDocument<T>,
): Promise<SettingsDocumentWriteResult<T>> {
  const { value, revision } = await document.readDetailed(db, {}, { skipCache: true });
  return { value, revision };
}

export interface ThemeSettingsDocument {
  theme: StorefrontThemeDocument;
  revision: number;
}

export interface ThemeDraftDocument {
  theme: StorefrontThemeDocument;
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

/** What a live preview renders: the saved draft as it is when the preview reads it. */
export interface ThemePreviewSessionDocument {
  theme: StorefrontThemeDocument;
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


/** Stored theme rows are read strictly; an unreadable one fails closed. */
function parseAuthoritativeThemeSettings(value: string): StorefrontThemeDocument {
  const theme = parseStoredStorefrontThemeDocument(value);
  if (!theme) {
    throw new ServiceUnavailableError(
      "Published storefront style is unreadable. Re-save it before editing.",
    );
  }
  return theme;
}

function assertNonnegativeRevision(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`A non-negative ${label} revision is required.`);
  }
}

function serializeThemeSettings(theme: StorefrontThemeDocument): {
  theme: StorefrontThemeDocument;
  serialized: string;
} {
  const result = storefrontThemeDocumentSchema.safeParse(theme);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues[0]?.message ?? "The storefront style is not a valid theme document.",
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }
  return { theme: result.data, serialized: JSON.stringify(result.data) };
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
  feeds?: Partial<SeoDiscoverySettings["feeds"]>;
};
type PartialSeoReturnPolicySettings = Partial<SeoReturnPolicySettings>;

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

const CURRENCY_CHANGE_CONFLICT_MESSAGE =
  "Currency code cannot be changed after products or orders exist. You can still update the currency symbol.";

/** Catalog, shipping and order amounts are minor units of this currency, so it locks once any exist. */
export async function isCurrencyCodeLocked(db: Database): Promise<boolean> {
  const [productRows, orderRows, shippingRows] = await safeBatch(db, [
    db.select({ id: products.id }).from(products).limit(1),
    db.select({ id: orders.id }).from(orders).limit(1),
    db.select({ id: shippingMethods.id }).from(shippingMethods).limit(1),
  ]);

  return Boolean(productRows?.length || orderRows?.length || shippingRows?.length);
}

export async function getCurrencySettings(db: Database): Promise<CurrencySettings> {
  return currencyDocument.read(db);
}

export async function saveCurrencySettings(
  db: Database,
  data: {
    currencyCode?: string;
    currencySymbol?: string;
  },
  options: SettingsSaveOptions = {},
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

  if (currencyCode !== current.currencyCode && await isCurrencyCodeLocked(db)) {
    throw new ConflictError(CURRENCY_CHANGE_CONFLICT_MESSAGE);
  }

  return currencyDocument.write(db, { currencyCode, currencySymbol }, {}, options);
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
  return { theme: structuredClone(DEFAULT_STOREFRONT_THEME), revision: 0 };
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

/**
 * What a theme names must exist when it is saved: every image (brand,
 * slides, section photos) a ready or trashed image in Files, and a product
 * homepage's product, not in trash. Each problem is reported against its
 * document path (`brand.logo`, `pages.home.0.settings.slides.1.image`). The
 * storefront still renders only what is public when it reads the theme.
 */
async function assertThemeReferences(db: Database, theme: StorefrontThemeDocument): Promise<void> {
  const references = storefrontThemeMediaReferences(theme);
  const mediaIds = [...new Set(references.map((reference) => reference.mediaId))];
  const productId = theme.pages.homeMode.kind === "product" ? theme.pages.homeMode.productId : null;
  if (mediaIds.length === 0 && productId === null) return;
  const [mediaRows, productRows] = await safeBatch(db, [
    db.select({ id: media.id, kind: media.kind }).from(media).where(and(
      sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)}))`,
      notInArray(media.status, ["deleting", "deleted"]),
    )),
    db.select({ id: products.id }).from(products)
      .where(and(eq(products.id, productId ?? ""), isNull(products.deletedAt)))
      .limit(1),
  ]);
  const images = new Set((mediaRows as Array<{ id: string; kind: string }>)
    .filter((row) => row.kind === "image")
    .map((row) => row.id));
  const issues = references
    .filter((reference) => !images.has(reference.mediaId))
    .map((reference) => ({ path: reference.path, message: "That image is not in Files any more. Choose another image." }));
  if (productId !== null && (productRows as unknown[]).length === 0) {
    issues.push({ path: "pages.homeMode.productId", message: "That product is unavailable or in trash. Choose another product." });
  }
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues);
}

export async function saveThemeDraft(
  db: Database,
  theme: StorefrontThemeDocument,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeDraftDocument> {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  assertNonnegativeRevision(basePublishedRevision, "base published");
  const normalized = serializeThemeSettings(theme);
  await assertThemeReferences(db, normalized.theme);

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

/**
 * Publishing (a draft or a restored version) writes the published row, its
 * history row and the synchronized draft in one batch, so the draft is always
 * based on the live revision; history keeps the newest
 * THEME_VERSION_HISTORY_LIMIT versions, the most the history list shows.
 */
async function runThemePublishBatch(
  db: Database,
  options: {
    theme: StorefrontThemeDocument;
    expectedPublishedRevision: number;
    expectedDraftRevision: number;
    actorId: string | null;
    source: "publish" | "rollback";
    sourceRevision?: number | null;
  },
): Promise<ThemeWorkspaceDocument> {
  assertNonnegativeRevision(options.expectedPublishedRevision, "published");
  if (!Number.isInteger(options.expectedDraftRevision) || options.expectedDraftRevision < 1) {
    throw new ValidationError("A positive draft revision is required to publish.");
  }
  const normalized = serializeThemeSettings(options.theme);
  const publishedRevision = options.expectedPublishedRevision + 1;
  const draftRevision = options.expectedDraftRevision + 1;

  try {
    await safeBatch(db, [
      buildPublishedThemeRevisionGuard(db, options.expectedPublishedRevision),
      buildThemeDraftRevisionGuard(
        db,
        options.expectedDraftRevision,
        options.expectedPublishedRevision,
      ),
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
      }),
      db.delete(themeSettingsVersions).where(sql`${themeSettingsVersions.publishedRevision} NOT IN (
        SELECT ${themeSettingsVersions.publishedRevision} FROM ${themeSettingsVersions}
        ORDER BY ${themeSettingsVersions.publishedRevision} DESC
        LIMIT ${sql.raw(String(THEME_VERSION_HISTORY_LIMIT))}
      )`),
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
        )),
    ]);
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
  });
}

export async function listThemeVersions(
  db: Database,
  limit = 20,
): Promise<ThemeVersionDocument[]> {
  const boundedLimit = Math.min(THEME_VERSION_HISTORY_LIMIT, Math.max(1, Math.trunc(limit)));
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
  });
}

const THEME_PREVIEW_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const THEME_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL =
  "THEME_PREVIEW_CONTINUATION_CONSUME_CONFLICT";

/** Every place that reads or mints a preview row also clears the expired ones. */
function deleteExpiredThemePreviewSessions(db: Database) {
  return db
    .delete(themePreviewSessions)
    .where(lte(themePreviewSessions.expiresAt, sql`unixepoch()`));
}

/**
 * Opens a preview of the saved draft. The session stores no theme: every
 * preview read resolves the draft as it is then, so a refreshed preview tab
 * shows the latest saved draft for the session's lifetime.
 */
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
  await safeBatch(db, [
    deleteExpiredThemePreviewSessions(db),
    db.insert(themePreviewSessions).values({
      tokenHash,
      expiresAt,
      createdBy: actorId,
      createdAt: sql`unixepoch()`,
    }),
  ]);
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
): Promise<{ token: string; expiresAt: Date }> {
  const normalizedId = continuationId.trim();
  if (!/^tpc_[A-Za-z0-9_-]{48}$/.test(normalizedId)) {
    throw new ConflictError("Theme preview continuation is unavailable or expired.");
  }
  const continuationHash = await hashThemePreviewToken(normalizedId);
  const continuation = await db
    .select({ createdBy: themePreviewSessions.createdBy })
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
      db.delete(themePreviewSessions).where(or(
        eq(themePreviewSessions.tokenHash, continuationHash),
        lte(themePreviewSessions.expiresAt, sql`unixepoch()`),
      )),
      db.insert(themePreviewSessions).values({
        tokenHash,
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
  return { token, expiresAt };
}

/** The saved draft as it is now, behind a live preview token; null when the token is unknown or expired. */
export async function resolveThemePreviewSession(
  db: Database,
  token: string,
): Promise<ThemePreviewSessionDocument | null> {
  const normalizedToken = token.trim();
  if (!/^tpv_[A-Za-z0-9_-]{48}$/.test(normalizedToken)) return null;
  const tokenHash = await hashThemePreviewToken(normalizedToken);
  const results = await safeBatch(db, [
    deleteExpiredThemePreviewSessions(db),
    db
      .select({
        theme: themeSettingsDrafts.theme,
        draftRevision: themeSettingsDrafts.revision,
        basePublishedRevision: themeSettingsDrafts.basePublishedRevision,
        expiresAt: themePreviewSessions.expiresAt,
      })
      .from(themePreviewSessions)
      .innerJoin(themeSettingsDrafts, eq(themeSettingsDrafts.id, THEME_SETTINGS_ID))
      .where(and(
        eq(themePreviewSessions.tokenHash, tokenHash),
        gt(themePreviewSessions.expiresAt, sql`unixepoch()`),
      ))
      .limit(1),
  ]);
  const row = (results[1] as Array<{
    theme: string;
    draftRevision: number;
    basePublishedRevision: number;
    expiresAt: Date;
  }>)[0];
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
  options: SettingsSaveOptions = {},
) {
  return mediaDocument.write(db, data, {}, options);
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
    homepageTitle?: string;
    homepageMetaDescription?: string;
    socialImage?: string;
    discovery?: PartialSeoDiscoverySettings;
    returnPolicy?: PartialSeoReturnPolicySettings;
  },
  options: SettingsSaveOptions = {},
) {
  const current = data.discovery !== undefined || data.returnPolicy !== undefined
    ? await getSeoSettings(db)
    : null;
  return seoDocument.write(db, {
    homepageTitle: data.homepageTitle,
    homepageMetaDescription: data.homepageMetaDescription,
    socialImage: data.socialImage,
    discovery: current && data.discovery !== undefined
      ? mergeSeoDiscoverySettings(current.discovery, data.discovery)
      : undefined,
    returnPolicy: current && data.returnPolicy !== undefined
      ? mergeSeoReturnPolicySettings(current.returnPolicy, data.returnPolicy)
      : undefined,
  }, {}, options);
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
  options: SettingsSaveOptions = {},
) {
  return customerCountriesDocument.write(db, {
    allowedCountries,
    allowedCountriesMode: mode,
  }, {}, options);
}
