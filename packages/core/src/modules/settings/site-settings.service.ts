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
import { eq, and, desc, gt, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
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
  compareThemeDocuments,
  formatThemeDocumentChanges,
  parseStoredStorefrontThemeDocument,
  storefrontThemeDocumentSchema,
  storefrontThemeMediaReferences,
  type StorefrontThemeDocument,
  type ThemeDocumentChange,
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
export const THEME_VERSION_HISTORY_LIMIT = 20;
// ponytail: one JSON document, capped at 512 KiB for bounded D1 rows and 20-version history on Workers Free.
export const THEME_DOCUMENT_MAX_BYTES = 512 * 1024;

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
  draftDiffersFromLive: boolean;
  lastPublished: {
    revision: number;
    publishedBy: string | null;
    publishedByName: string | null;
    createdAt: Date;
  } | null;
}

export interface ThemeVersionDocument extends ThemeSettingsDocument {
  id: string;
  source: "publish" | "rollback" | "migration";
  sourceRevision: number | null;
  publishedBy: string | null;
  publishedByName: string | null;
  summary: string[];
  changes: ThemeDocumentChange[];
  note: string | null;
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

/** History metadata shares the snapshot JSON; older bare-document rows remain readable. */
function parseThemeVersionSnapshot(serialized: string): {
  theme: StorefrontThemeDocument;
  summary: string[];
  changes: ThemeDocumentChange[];
  note: string | null;
  publishedByName: string | null;
} {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return { theme: parseAuthoritativeThemeSettings(serialized), summary: [], changes: [], note: null, publishedByName: null }; }
  if (value && typeof value === "object" && "theme" in value) {
    const snapshot = value as { theme: unknown; publication?: unknown };
    const metadata = snapshot.publication as { summary?: unknown; changes?: unknown; note?: unknown; publishedByName?: unknown } | undefined;
    if (!metadata || !Array.isArray(metadata.summary) || metadata.summary.length > 51 || metadata.summary.some((entry) => typeof entry !== "string") ||
      (metadata.changes !== undefined && (!Array.isArray(metadata.changes) || metadata.changes.length > 50 || metadata.changes.some((change: unknown) => {
        if (!change || typeof change !== "object") return true;
        const descriptor = change as Partial<ThemeDocumentChange>;
        return !["added", "removed", "reordered", "settings"].includes(descriptor.kind ?? "") || typeof descriptor.page !== "string" ||
          (descriptor.sectionId !== undefined && typeof descriptor.sectionId !== "string") || (descriptor.path !== undefined && typeof descriptor.path !== "string");
      }))) ||
      (metadata.note !== null && (typeof metadata.note !== "string" || metadata.note.length > 500)) ||
      (metadata.publishedByName !== null && (typeof metadata.publishedByName !== "string" || metadata.publishedByName.length > 200))) {
      throw new ServiceUnavailableError("Storefront style history metadata is unreadable.");
    }
    return { theme: parseAuthoritativeThemeSettings(JSON.stringify(snapshot.theme)), summary: metadata.summary as string[], changes: Array.isArray(metadata.changes) ? metadata.changes as ThemeDocumentChange[] : [], note: metadata.note as string | null, publishedByName: metadata.publishedByName as string | null };
  }
  return { theme: parseAuthoritativeThemeSettings(serialized), summary: [], changes: [], note: null, publishedByName: null };
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
  const serialized = JSON.stringify(result.data);
  if (new TextEncoder().encode(serialized).byteLength > THEME_DOCUMENT_MAX_BYTES) {
    throw new ValidationError("Storefront style is too large. Shorten page content or remove unused pages.");
  }
  return { theme: result.data, serialized };
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
    db.select({ revision: themeSettingsVersions.publishedRevision, publishedBy: themeSettingsVersions.publishedBy, theme: themeSettingsVersions.theme, createdAt: themeSettingsVersions.createdAt })
      .from(themeSettingsVersions).orderBy(desc(themeSettingsVersions.publishedRevision)).limit(1),
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
  const draftTheme = draft ? parseAuthoritativeThemeSettings(draft.theme) : published.theme;
  const latest = (workspaceResults[2] as Array<{ revision: number; publishedBy: string | null; theme: string; createdAt: Date }>)[0];

  return {
    draftDiffersFromLive: compareThemeDocuments(published.theme, draftTheme).length > 0,
    lastPublished: latest ? { revision: latest.revision, publishedBy: latest.publishedBy, publishedByName: parseThemeVersionSnapshot(latest.theme).publishedByName, createdAt: latest.createdAt } : null,
    published,
    draft: draft
      ? {
          theme: draftTheme,
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
    let inserted: Array<{ revision: number; updatedAt: Date }>;
    try {
      const results = await safeBatch(db, [
        buildPublishedThemeRevisionGuard(db, basePublishedRevision),
        buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM ${themeSettingsDrafts} WHERE ${themeSettingsDrafts.id} = ${THEME_SETTINGS_ID})`, THEME_REVISION_CONFLICT_SENTINEL),
        db.insert(themeSettingsDrafts).values({
          id: THEME_SETTINGS_ID, theme: normalized.serialized, revision: 1, basePublishedRevision,
          updatedBy: actorId, createdAt: sql`unixepoch()`, updatedAt: sql`unixepoch()`,
        }).returning({ revision: themeSettingsDrafts.revision, updatedAt: themeSettingsDrafts.updatedAt }),
      ]);
      inserted = results[2] as Array<{ revision: number; updatedAt: Date }>;
    } catch (error) {
      if (isThemeRevisionConflict(error)) throw themeConflict("The storefront style or draft changed in another session. Reload the saved draft before continuing.");
      throw error;
    }
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
    note?: string | null;
    actorName?: string | null;
  },
): Promise<ThemeWorkspaceDocument> {
  assertNonnegativeRevision(options.expectedPublishedRevision, "published");
  if (!Number.isInteger(options.expectedDraftRevision) || options.expectedDraftRevision < 1) {
    throw new ValidationError("A positive draft revision is required to publish.");
  }
  const normalized = serializeThemeSettings(options.theme);
  await assertThemeReferences(db, normalized.theme);
  const previous = await getThemeSettings(db);
  const changes = compareThemeDocuments(previous.theme, normalized.theme);
  const allChanges = formatThemeDocumentChanges(changes);
  const summary = allChanges.length > 50 ? [...allChanges.slice(0, 50), `${allChanges.length - 50} additional changes`] : allChanges;
  const note = options.note?.trim() || null;
  if (note && note.length > 500) throw new ValidationError("A publication note must be at most 500 characters.");
  const actorName = options.actorName?.trim().slice(0, 200) || null;
  const versionId = `themev_${nanoid()}`;
  const publishedRevision = options.expectedPublishedRevision + 1;
  const draftRevision = options.expectedDraftRevision + 1;

  let publishedAt = new Date();
  try {
    const committed = await safeBatch(db, [
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
        id: versionId,
        publishedRevision,
        theme: JSON.stringify({ theme: normalized.theme, publication: { summary, changes: changes.slice(0, 50), note, publishedByName: actorName } }),
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
      db.select({ createdAt: themeSettingsVersions.createdAt }).from(themeSettingsVersions).where(eq(themeSettingsVersions.id, versionId)).limit(1),
    ]);
    publishedAt = (committed.at(-1) as Array<{ createdAt: Date }>)[0]!.createdAt;
  } catch (error) {
    if (isThemeRevisionConflict(error)) {
      throw themeConflict(
        "The storefront style or its draft changed in another session. Reload the latest versions before publishing.",
      );
    }
    throw error;
  }

  return {
    draftDiffersFromLive: false,
    lastPublished: { revision: publishedRevision, publishedBy: options.actorId, publishedByName: actorName, createdAt: publishedAt },
    published: { theme: normalized.theme, revision: publishedRevision },
    draft: {
      theme: normalized.theme,
      revision: draftRevision,
      basePublishedRevision: publishedRevision,
      updatedAt: publishedAt,
    },
  };
}

export async function publishThemeDraft(
  db: Database,
  expectedPublishedRevision: number,
  expectedDraftRevision: number,
  actorId: string | null = null,
  note: string | null = null,
  actorName: string | null = null,
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
    note,
    actorName,
  });
}

function themeVersionFromRow(row: typeof themeSettingsVersions.$inferSelect): ThemeVersionDocument {
  return {
    id: row.id,
    revision: row.publishedRevision,
    ...parseThemeVersionSnapshot(row.theme),
    source: row.source,
    sourceRevision: row.sourceRevision,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt,
  };
}

export async function listThemeVersions(
  db: Database,
  limit = 20,
  beforeRevision?: number,
): Promise<ThemeVersionDocument[]> {
  const boundedLimit = Math.min(THEME_VERSION_HISTORY_LIMIT, Math.max(1, Math.trunc(limit)));
  const rows = await db.select().from(themeSettingsVersions)
    .where(beforeRevision === undefined ? undefined : lt(themeSettingsVersions.publishedRevision, beforeRevision))
    .orderBy(desc(themeSettingsVersions.publishedRevision)).limit(boundedLimit);
  return rows.map(themeVersionFromRow);
}

export async function getThemeVersion(db: Database, sourceRevision: number): Promise<ThemeVersionDocument> {
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1) throw new ValidationError("Choose a positive published theme revision.");
  const row = await db.select().from(themeSettingsVersions).where(eq(themeSettingsVersions.publishedRevision, sourceRevision)).get();
  if (!row) throw new ValidationError("That storefront style revision is unavailable.");
  return themeVersionFromRow(row);
}

/** Restore and discard replace only the draft; the monotonic revision prevents stale editors and ABA. */
async function replaceThemeDraft(
  db: Database,
  theme: StorefrontThemeDocument | null,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null,
): Promise<ThemeWorkspaceDocument> {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  assertNonnegativeRevision(basePublishedRevision, "base published");
  const workspace = await getThemeWorkspace(db);
  if (workspace.published.revision !== basePublishedRevision || workspace.draft.revision !== expectedDraftRevision) {
    throw themeConflict("The storefront style or draft changed in another session. Reload before replacing the draft.");
  }
  const normalized = serializeThemeSettings(theme ?? workspace.published.theme);
  if (theme) await assertThemeReferences(db, normalized.theme);
  try {
    await safeBatch(db, [
      buildPublishedThemeRevisionGuard(db, basePublishedRevision),
      expectedDraftRevision === 0
        ? buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM ${themeSettingsDrafts} WHERE ${themeSettingsDrafts.id} = ${THEME_SETTINGS_ID})`, THEME_REVISION_CONFLICT_SENTINEL)
        : buildThemeDraftRevisionGuard(db, expectedDraftRevision, workspace.draft.basePublishedRevision),
      (expectedDraftRevision === 0
        ? db.insert(themeSettingsDrafts).values({ id: THEME_SETTINGS_ID, theme: normalized.serialized, revision: 1, basePublishedRevision, updatedBy: actorId, createdAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        : db.update(themeSettingsDrafts).set({ theme: normalized.serialized, revision: sql`${themeSettingsDrafts.revision} + 1`, basePublishedRevision, updatedBy: actorId, updatedAt: sql`unixepoch()` })
          .where(eq(themeSettingsDrafts.id, THEME_SETTINGS_ID))) as never,
    ]);
  } catch (error) {
    if (isThemeRevisionConflict(error)) throw themeConflict("The storefront style or draft changed in another session. Reload before replacing the draft.");
    throw error;
  }
  return {
    ...workspace,
    draft: { theme: normalized.theme, revision: expectedDraftRevision + 1, basePublishedRevision, updatedAt: new Date() },
    draftDiffersFromLive: compareThemeDocuments(workspace.published.theme, normalized.theme).length > 0,
  };
}

export async function restoreThemeVersion(
  db: Database,
  sourceRevision: number,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeWorkspaceDocument> {
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1) throw new ValidationError("Choose a positive published theme revision to restore.");
  const source = await db.select({ theme: themeSettingsVersions.theme }).from(themeSettingsVersions)
    .where(eq(themeSettingsVersions.publishedRevision, sourceRevision)).get();
  if (!source) throw new ValidationError("That storefront style revision is unavailable.");
  return replaceThemeDraft(db, parseThemeVersionSnapshot(source.theme).theme, expectedDraftRevision, basePublishedRevision, actorId);
}

export async function discardThemeDraft(
  db: Database,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeWorkspaceDocument> {
  return replaceThemeDraft(db, null, expectedDraftRevision, basePublishedRevision, actorId);
}

/** Compatibility command: old rollback callers now restore to draft and must explicitly publish. */
export async function rollbackThemeSettings(
  db: Database,
  sourceRevision: number,
  expectedPublishedRevision: number,
  expectedDraftRevision: number,
  actorId: string | null = null,
): Promise<ThemeWorkspaceDocument> {
  return restoreThemeVersion(db, sourceRevision, expectedDraftRevision, expectedPublishedRevision, actorId);
}

function patchThemePage(theme: StorefrontThemeDocument, page: "home" | "landing" | "product" | "collection" | "search", value: unknown, slug?: string): void {
  if (page === "landing") {
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ValidationError("Choose a valid landing-page slug.");
    const pages = theme.pages as unknown as { landing: Record<string, unknown> };
    if (value === null) delete pages.landing[slug];
    else pages.landing[slug] = value;
  } else {
    (theme.pages as unknown as Record<string, unknown>)[page] = value;
  }
}

/** A bounded read proof compares approved page content and exact revisions without returning the theme. */
export async function checkThemePageDraft(
  db: Database,
  page: "home" | "landing" | "product" | "collection" | "search",
  value: unknown,
  expectedDraftRevision: number,
  expectedPublishedRevision: number,
  slug?: string,
) {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  assertNonnegativeRevision(expectedPublishedRevision, "published");
  const workspace = await getThemeWorkspace(db);
  const expectedTheme = structuredClone(workspace.draft.theme);
  patchThemePage(expectedTheme, page, value, slug);
  const normalized = serializeThemeSettings(expectedTheme).theme;
  const pageMatches = compareThemeDocuments(workspace.draft.theme, normalized).length === 0;
  const revisionMatches = workspace.draft.revision === expectedDraftRevision;
  const publishedRevisionMatches = workspace.published.revision === expectedPublishedRevision;
  return { matches: pageMatches && revisionMatches && publishedRevisionMatches, pageMatches, revisionMatches, publishedRevisionMatches, draftRevision: workspace.draft.revision, publishedRevision: workspace.published.revision };
}

/** One-page agent edits use the same document validation and revision authority as the editor. */
export async function saveThemePageDraft(
  db: Database,
  page: "home" | "landing" | "product" | "collection" | "search",
  value: unknown,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
  slug?: string,
): Promise<ThemeDraftDocument> {
  const workspace = await getThemeWorkspace(db);
  if (workspace.draft.revision !== expectedDraftRevision || workspace.draft.basePublishedRevision !== basePublishedRevision) {
    throw themeConflict("The storefront style draft changed in another session. Reload before changing a page.");
  }
  const theme = structuredClone(workspace.draft.theme);
  patchThemePage(theme, page, value, slug);
  return saveThemeDraft(db, theme, expectedDraftRevision, basePublishedRevision, actorId);
}

const THEME_PREVIEW_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const THEME_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL =
  "THEME_PREVIEW_CONTINUATION_CONSUME_CONFLICT";

/** Version selectors stay in the existing hashed bearer, never a URL or overloaded database column. */
function previewVersion(token: string): number | null {
  const match = /^tp[cv]_V([0-9a-z]{10})_[A-Za-z0-9_-]{36}$/.exec(token);
  if (!match) return null;
  const revision = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function mintThemePreviewBearer(kind: "tpc" | "tpv", sourceRevision: number | null): string {
  return sourceRevision === null ? `${kind}_${nanoid(48)}` : `${kind}_V${sourceRevision.toString(36).padStart(10, "0")}_${nanoid(36)}`;
}

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
  sourceRevision: number | null = null,
): Promise<ThemePreviewContinuationDocument> {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  let draft: { revision: number; basePublishedRevision: number };
  if (sourceRevision !== null) {
    if (!Number.isInteger(sourceRevision) || sourceRevision < 1 || sourceRevision > 2_147_483_647) throw new ValidationError("Choose a valid published theme revision to preview.");
    const version = await db.select({ theme: themeSettingsVersions.theme }).from(themeSettingsVersions).where(eq(themeSettingsVersions.publishedRevision, sourceRevision)).get();
    if (!version) throw new ValidationError("That storefront style revision is unavailable.");
    parseThemeVersionSnapshot(version.theme);
    draft = { revision: sourceRevision, basePublishedRevision: sourceRevision };
  } else {
    if (expectedDraftRevision < 1) throw new ValidationError("Save the storefront style draft before previewing it.");
    const saved = await db.select({ revision: themeSettingsDrafts.revision, basePublishedRevision: themeSettingsDrafts.basePublishedRevision })
      .from(themeSettingsDrafts).where(and(eq(themeSettingsDrafts.id, THEME_SETTINGS_ID), eq(themeSettingsDrafts.revision, expectedDraftRevision))).get();
    if (!saved) throw themeConflict("The storefront style draft changed before preview opened. Reload the latest draft.");
    draft = saved;
  }

  // This is a one-time browser continuation bearer, carried only in a bounded
  // same-origin POST body. Only the service-authenticated exchange accepts it,
  // and the raw value is never persisted or placed in a URL.
  const continuationId = mintThemePreviewBearer("tpc", sourceRevision);
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

  const token = mintThemePreviewBearer("tpv", previewVersion(normalizedId));
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
  const sourceRevision = previewVersion(normalizedToken);
  const authorized = and(eq(themePreviewSessions.tokenHash, tokenHash), gt(themePreviewSessions.expiresAt, sql`unixepoch()`));
  const results = await safeBatch(db, [
    deleteExpiredThemePreviewSessions(db),
    sourceRevision === null
      ? db.select({ theme: themeSettingsDrafts.theme, draftRevision: themeSettingsDrafts.revision, basePublishedRevision: themeSettingsDrafts.basePublishedRevision, expiresAt: themePreviewSessions.expiresAt })
        .from(themePreviewSessions).innerJoin(themeSettingsDrafts, eq(themeSettingsDrafts.id, THEME_SETTINGS_ID)).where(authorized).limit(1)
      : db.select({ theme: themeSettingsVersions.theme, draftRevision: themeSettingsVersions.publishedRevision, basePublishedRevision: themeSettingsVersions.publishedRevision, expiresAt: themePreviewSessions.expiresAt })
        .from(themePreviewSessions).innerJoin(themeSettingsVersions, eq(themeSettingsVersions.publishedRevision, sourceRevision)).where(authorized).limit(1),
  ]);
  const row = (results[1] as Array<{ theme: string; draftRevision: number; basePublishedRevision: number; expiresAt: Date }>)[0];
  if (!row) return null;
  return {
    theme: sourceRevision === null ? parseAuthoritativeThemeSettings(row.theme) : parseThemeVersionSnapshot(row.theme).theme,
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
