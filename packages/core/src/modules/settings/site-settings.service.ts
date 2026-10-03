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
  user,
} from "@scalius/database/schema";
import { eq, and, desc, gt, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { isPriceIncrementMinor } from "@scalius/shared/currency-policy";
import {
  DEFAULT_STOREFRONT_THEME,
  THEME_VERSION_CHANGES_MAX,
  compareThemeDocuments,
  parseStoredStorefrontThemeDocument,
  storefrontThemeDocumentSchema,
  storefrontThemeMediaIds,
  storefrontThemeMediaReferences,
  storefrontThemeWithoutMedia,
  themeDocumentChangeSchema,
  type StorefrontLandingPage,
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
  priceIncrementOf,
  seoDocument,
  type CurrencySettings,
  type CustomerCountries,
  type MediaOptimizationSettings,
} from "./documents";
import type { SettingsDocument, SettingsDocumentWriteResult } from "../../settings-store";

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
    /** The default market's price increment; omitted keeps the saved one (reset when the currency changes). */
    priceIncrementMinor?: number;
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

  // Saved prices are never rewritten: a store that moves to whole units keeps
  // any amount with minor units until it is edited.
  const priceIncrementMinor = data.priceIncrementMinor
    ?? (currencyCode === current.currencyCode ? current.priceIncrementMinor : undefined);
  if (priceIncrementMinor !== undefined && !isPriceIncrementMinor(currencyCode, priceIncrementMinor)) {
    throw new ValidationError(`Choose how ${currencyCode} prices are entered: in minor units or whole units.`);
  }

  // The whole document is written, so an increment left out (a new currency)
  // is gone rather than kept from the old currency.
  const saved = await currencyDocument.write(
    db,
    { currencyCode, currencySymbol, ...(priceIncrementMinor === undefined ? {} : { priceIncrementMinor }) },
    {},
    { ...options, replace: true },
  );
  // Catalogue projections store percentage prices at the increment: a change
  // needs their rebuild (the caller queues it, as for the store alert level).
  return { ...saved, priceIncrementChanged: priceIncrementOf(saved.value) !== priceIncrementOf(current) };
}
// ─────────────────────────────────────────
// Theme
// ─────────────────────────────────────────
//
// One published document (`theme_settings`), one shared draft
// (`theme_settings_drafts`) and immutable published versions
// (`theme_settings_versions`). Every write is a guarded batch on revisions:
// the draft revision only ever grows (no ABA), publish writes the live row,
// its version row, the history prune and the rebased draft at once, and
// restore/discard replace only the draft. A version row stores
// `{"meta": {changes, moreChanges, note}, "theme": <document>}`; rows written
// before history metadata hold the bare document and read with no changes.

const THEME_SETTINGS_ID = "default";

/** Published versions kept for history and restore, pruned in the publish batch. */
export const THEME_VERSION_HISTORY_LIMIT = 20;
/** Most versions one history page lists: metadata only, and five worst-case entries stay under the 64 KiB agent result ceiling. */
export const THEME_VERSION_PAGE_LIMIT = 5;
/** Largest stored theme document: bounds each D1 row and the retained history on Workers Free. */
export const THEME_DOCUMENT_MAX_BYTES = 512 * 1024;
/** A publication note's length. */
export const THEME_PUBLISH_NOTE_MAX = 500;

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

/** Who published the live theme, and when. */
export interface ThemePublication {
  revision: number;
  publishedBy: string | null;
  publishedByName: string | null;
  createdAt: Date;
}

/** Revisions and status only: what a save, publish, restore or discard answers. */
export interface ThemeStatus {
  published: { revision: number };
  draft: { revision: number; basePublishedRevision: number; updatedAt: Date | null };
  draftDiffersFromLive: boolean;
  lastPublished: ThemePublication | null;
}

export interface ThemeWorkspaceDocument {
  published: ThemeSettingsDocument;
  draft: ThemeDraftDocument;
  draftDiffersFromLive: boolean;
  lastPublished: ThemePublication | null;
}

/** A published version as the history lists it (no document). */
export interface ThemeVersionSummary {
  id: string;
  revision: number;
  source: "publish" | "rollback" | "migration";
  sourceRevision: number | null;
  publishedBy: string | null;
  publishedByName: string | null;
  createdAt: Date;
  changes: ThemeDocumentChange[];
  /** Changes past the stored list. */
  moreChanges: number;
  note: string | null;
}

export interface ThemeVersionDocument extends ThemeVersionSummary {
  theme: StorefrontThemeDocument;
}

/** What a live preview renders: the saved draft (or one version) as it is when the preview reads it. */
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

const themeVersionMetaSchema = z.object({
  changes: z.array(themeDocumentChangeSchema).max(THEME_VERSION_CHANGES_MAX),
  moreChanges: z.number().int().nonnegative(),
  note: z.string().max(THEME_PUBLISH_NOTE_MAX).nullable(),
}).strict();
type ThemeVersionMeta = z.infer<typeof themeVersionMetaSchema>;
const NO_VERSION_META: ThemeVersionMeta = { changes: [], moreChanges: 0, note: null };

/** Stored theme rows are read through the upgrade path; an unreadable one fails closed. */
function parseAuthoritativeThemeSettings(value: string): StorefrontThemeDocument {
  const theme = parseStoredStorefrontThemeDocument(value);
  if (!theme) {
    throw new ServiceUnavailableError(
      "Published storefront style is unreadable. Re-save it before editing.",
    );
  }
  return theme;
}

function parseVersionMeta(value: unknown): ThemeVersionMeta {
  if (value === null || value === undefined) return NO_VERSION_META;
  const parsed = themeVersionMetaSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value);
  if (!parsed.success) throw new ServiceUnavailableError("Storefront style history is unreadable.");
  return parsed.data;
}

/** A version row's document and metadata; a bare document is a version from before metadata. */
function parseVersionRow(serialized: string): { theme: StorefrontThemeDocument; meta: ThemeVersionMeta } {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ServiceUnavailableError("Storefront style history is unreadable.");
  }
  const envelope = value && typeof value === "object" && "meta" in value && "theme" in value
    ? value as { meta: unknown; theme: unknown }
    : null;
  if (!envelope) return { theme: parseAuthoritativeThemeSettings(serialized), meta: NO_VERSION_META };
  return { theme: parseAuthoritativeThemeSettings(JSON.stringify(envelope.theme)), meta: parseVersionMeta(envelope.meta) };
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
    throw new ValidationError("Storefront style is too large. Shorten page content or remove unused landing pages.");
  }
  return { theme: result.data, serialized };
}

const THEME_REVISION_CONFLICT_SENTINEL = "THEME_REVISION_CONFLICT";
const DRAFT_CONFLICT = "The storefront style or its draft changed in another session. Reload the latest draft before continuing.";

function isThemeRevisionConflict(error: unknown): boolean {
  return isBatchGuardError(error, THEME_REVISION_CONFLICT_SENTINEL);
}

function themeConflict(message = DRAFT_CONFLICT): ConflictError {
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

function selectThemeSettingsRows(db: Database) {
  return db
    .select({ colors: themeSettings.colors, revision: themeSettings.revision })
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

/** Version rows without their documents: metadata comes out of the stored JSON in the database. */
function selectThemeVersionSummaries(db: Database) {
  return db
    .select({
      id: themeSettingsVersions.id,
      revision: themeSettingsVersions.publishedRevision,
      source: themeSettingsVersions.source,
      sourceRevision: themeSettingsVersions.sourceRevision,
      publishedBy: themeSettingsVersions.publishedBy,
      publishedByName: user.name,
      createdAt: themeSettingsVersions.createdAt,
      meta: sql<string | null>`json_extract(${themeSettingsVersions.theme}, '$.meta')`,
    })
    .from(themeSettingsVersions)
    .leftJoin(user, eq(user.id, themeSettingsVersions.publishedBy));
}

type ThemeVersionSummaryRow = Omit<ThemeVersionSummary, "changes" | "moreChanges" | "note"> & { meta: string | null };

function themeVersionSummary(row: ThemeVersionSummaryRow): ThemeVersionSummary {
  const { meta, ...version } = row;
  return { ...version, publishedByName: version.publishedByName ?? null, ...parseVersionMeta(meta) };
}

/** No published row yet: revision 0 lets the first writer claim revision 1. */
function unpublishedThemeSettings(): ThemeSettingsDocument {
  return { theme: structuredClone(DEFAULT_STOREFRONT_THEME), revision: 0 };
}

export async function getThemeSettings(db: Database): Promise<ThemeSettingsDocument> {
  const current = (await selectThemeSettingsRows(db))[0];
  return current
    ? { theme: parseAuthoritativeThemeSettings(current.colors), revision: current.revision }
    : unpublishedThemeSettings();
}

/** The live document, the shared draft (the live one until a draft is saved) and who published last. */
export async function getThemeWorkspace(db: Database): Promise<ThemeWorkspaceDocument> {
  const [publishedRows, draftRows, latestRows] = await safeBatch(db, [
    selectThemeSettingsRows(db),
    selectThemeDraftRows(db),
    selectThemeVersionSummaries(db).orderBy(desc(themeSettingsVersions.publishedRevision)).limit(1),
  ]);
  const publishedRow = (publishedRows as Array<{ colors: string; revision: number }>)[0];
  const published = publishedRow
    ? { theme: parseAuthoritativeThemeSettings(publishedRow.colors), revision: publishedRow.revision }
    : unpublishedThemeSettings();
  const draftRow = (draftRows as Array<{ theme: string; revision: number; basePublishedRevision: number; updatedAt: Date }>)[0];
  const draft: ThemeDraftDocument = draftRow
    ? { theme: parseAuthoritativeThemeSettings(draftRow.theme), revision: draftRow.revision, basePublishedRevision: draftRow.basePublishedRevision, updatedAt: draftRow.updatedAt }
    : { theme: published.theme, revision: 0, basePublishedRevision: published.revision, updatedAt: null };
  const latest = (latestRows as ThemeVersionSummaryRow[])[0];
  return {
    published,
    draft,
    draftDiffersFromLive: compareThemeDocuments(published.theme, draft.theme).length > 0,
    lastPublished: latest
      ? { revision: latest.revision, publishedBy: latest.publishedBy, publishedByName: latest.publishedByName ?? null, createdAt: latest.createdAt }
      : null,
  };
}

/** A workspace without its documents. */
export function themeStatus(workspace: ThemeWorkspaceDocument): ThemeStatus {
  return {
    published: { revision: workspace.published.revision },
    draft: {
      revision: workspace.draft.revision,
      basePublishedRevision: workspace.draft.basePublishedRevision,
      updatedAt: workspace.draft.updatedAt,
    },
    draftDiffersFromLive: workspace.draftDiffersFromLive,
    lastPublished: workspace.lastPublished,
  };
}

/**
 * What a theme names must exist when it is saved: every image (brand,
 * slides, section photos on the homepage and landing pages) a ready or
 * trashed image in Files, and a product homepage's product, not in trash.
 * Each problem is reported against its document path (`brand.logo`,
 * `pages.landing.eid.sections.0.settings.slides.1.image`). The storefront
 * still renders only what is public when it reads the theme.
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

/** The images a theme names that are no longer (ready or trashed) images in Files. */
async function readMissingThemeImages(db: Database, theme: StorefrontThemeDocument): Promise<Set<string>> {
  const mediaIds = storefrontThemeMediaIds(theme);
  if (mediaIds.length === 0) return new Set();
  const rows = await db.select({ id: media.id, kind: media.kind }).from(media).where(and(
    sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)}))`,
    notInArray(media.status, ["deleting", "deleted"]),
  ));
  const images = new Set(rows.filter((row) => row.kind === "image").map((row) => row.id));
  return new Set(mediaIds.filter((id) => !images.has(id)));
}

/** A restore refused because the version names images deleted from Files since (`details.missingImages`: how many). */
export const THEME_VERSION_IMAGES_MISSING = "THEME_VERSION_IMAGES_MISSING";

function buildPublishedThemeRevisionGuard(db: Database, expectedRevision: number) {
  return buildBatchGuard(db, expectedRevision === 0
    ? sql`NOT EXISTS (SELECT 1 FROM ${themeSettings} WHERE ${themeSettings.id} = ${THEME_SETTINGS_ID})`
    : sql`EXISTS (
        SELECT 1 FROM ${themeSettings}
        WHERE ${themeSettings.id} = ${THEME_SETTINGS_ID} AND ${themeSettings.revision} = ${expectedRevision}
      )`, THEME_REVISION_CONFLICT_SENTINEL);
}

/** The draft is at this revision on this live revision; revision 0 means no draft row exists yet. */
function buildThemeDraftRevisionGuard(db: Database, expectedDraftRevision: number, basePublishedRevision: number) {
  return buildBatchGuard(db, expectedDraftRevision === 0
    ? sql`NOT EXISTS (SELECT 1 FROM ${themeSettingsDrafts} WHERE ${themeSettingsDrafts.id} = ${THEME_SETTINGS_ID})`
    : sql`EXISTS (
        SELECT 1 FROM ${themeSettingsDrafts}
        WHERE ${themeSettingsDrafts.id} = ${THEME_SETTINGS_ID}
          AND ${themeSettingsDrafts.revision} = ${expectedDraftRevision}
          AND ${themeSettingsDrafts.basePublishedRevision} = ${basePublishedRevision}
      )`, THEME_REVISION_CONFLICT_SENTINEL);
}

/** Writes the draft at the next revision (inserting revision 1 when there is none yet). */
function themeDraftWriteStatement(
  db: Database,
  serialized: string,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null,
) {
  if (expectedDraftRevision === 0) {
    return db.insert(themeSettingsDrafts).values({
      id: THEME_SETTINGS_ID, theme: serialized, revision: 1, basePublishedRevision,
      updatedBy: actorId, createdAt: sql`unixepoch()`, updatedAt: sql`unixepoch()`,
    });
  }
  return db.update(themeSettingsDrafts).set({
    theme: serialized,
    revision: sql`${themeSettingsDrafts.revision} + 1`,
    basePublishedRevision,
    updatedBy: actorId,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(themeSettingsDrafts.id, THEME_SETTINGS_ID), eq(themeSettingsDrafts.revision, expectedDraftRevision)));
}

/**
 * Replaces the shared draft in one guarded batch: the live revision and the
 * draft revision the caller read must both still hold. Saving, restoring a
 * version and discarding all go through here; none of them touches the live
 * theme. Returns the new draft revision and its time.
 */
async function writeThemeDraft(
  db: Database,
  theme: StorefrontThemeDocument,
  expectedDraftRevision: number,
  expectedBasePublishedRevision: number,
  nextBasePublishedRevision: number,
  actorId: string | null,
): Promise<{ theme: StorefrontThemeDocument; revision: number; updatedAt: Date }> {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  assertNonnegativeRevision(expectedBasePublishedRevision, "base published");
  const normalized = serializeThemeSettings(theme);
  await assertThemeReferences(db, normalized.theme);
  let rows: Array<{ revision: number; updatedAt: Date }>;
  try {
    const results = await safeBatch(db, [
      buildPublishedThemeRevisionGuard(db, nextBasePublishedRevision),
      buildThemeDraftRevisionGuard(db, expectedDraftRevision, expectedBasePublishedRevision),
      themeDraftWriteStatement(db, normalized.serialized, expectedDraftRevision, nextBasePublishedRevision, actorId) as never,
      selectThemeDraftRows(db),
    ]);
    rows = results[3] as Array<{ revision: number; updatedAt: Date }>;
  } catch (error) {
    if (isThemeRevisionConflict(error)) throw themeConflict();
    throw error;
  }
  const row = rows[0];
  if (!row || row.revision !== expectedDraftRevision + 1) throw themeConflict();
  return { theme: normalized.theme, revision: row.revision, updatedAt: row.updatedAt };
}

/** Saves the editor's whole document as the shared draft. */
export async function saveThemeDraft(
  db: Database,
  theme: StorefrontThemeDocument,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeDraftDocument> {
  const saved = await writeThemeDraft(db, theme, expectedDraftRevision, basePublishedRevision, basePublishedRevision, actorId);
  return { ...saved, basePublishedRevision };
}

/** The page an agent edits on its own: the homepage sections, or one landing page (null removes it). */
export type ThemePageEdit =
  | { page: "home"; value: StorefrontThemeDocument["pages"]["home"] }
  | { page: "landing"; slug: string; value: StorefrontLandingPage | null };

/** One page of the shared draft, with the same validation and revision authority as the editor. */
export async function saveThemePageDraft(
  db: Database,
  edit: ThemePageEdit,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeDraftDocument> {
  const workspace = await getThemeWorkspace(db);
  if (workspace.draft.revision !== expectedDraftRevision || workspace.draft.basePublishedRevision !== basePublishedRevision) {
    throw themeConflict();
  }
  const theme = structuredClone(workspace.draft.theme);
  if (edit.page === "home") theme.pages.home = edit.value;
  else if (edit.value === null) delete theme.pages.landing[edit.slug];
  else theme.pages.landing[edit.slug] = edit.value;
  return saveThemeDraft(db, theme, expectedDraftRevision, basePublishedRevision, actorId);
}

/** Puts a published version in the draft (never live), on the current live revision. */
export async function restoreThemeVersion(
  db: Database,
  sourceRevision: number,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
  options: {
    /** Restore it anyway, leaving out the images deleted from Files since it was published. */
    withoutMissingImages?: boolean;
  } = {},
): Promise<ThemeStatus> {
  const version = await getThemeVersion(db, sourceRevision);
  const workspace = await getThemeWorkspace(db);
  if (workspace.published.revision !== basePublishedRevision) throw themeConflict();
  // A version may name images deleted from Files since: say so (with how many)
  // rather than fail on the first one, and restore without them when asked.
  const missing = await readMissingThemeImages(db, version.theme);
  if (missing.size > 0 && !options.withoutMissingImages) {
    throw new AppError(400, THEME_VERSION_IMAGES_MISSING, `This version uses ${missing.size === 1 ? "an image" : `${missing.size} images`} no longer in Files. Restore it without ${missing.size === 1 ? "it" : "them"}, or add ${missing.size === 1 ? "it" : "them"} back to Files first.`, { missingImages: missing.size });
  }
  const theme = storefrontThemeWithoutMedia(version.theme, missing);
  const saved = await writeThemeDraft(db, theme, expectedDraftRevision, workspace.draft.basePublishedRevision, basePublishedRevision, actorId);
  return {
    ...themeStatus(workspace),
    draft: { revision: saved.revision, basePublishedRevision, updatedAt: saved.updatedAt },
    draftDiffersFromLive: compareThemeDocuments(workspace.published.theme, saved.theme).length > 0,
  };
}

/** Throws the draft's changes away: the draft becomes the live document again, at a new revision. */
export async function discardThemeDraft(
  db: Database,
  expectedDraftRevision: number,
  basePublishedRevision: number,
  actorId: string | null = null,
): Promise<ThemeStatus> {
  const workspace = await getThemeWorkspace(db);
  if (workspace.published.revision !== basePublishedRevision) throw themeConflict();
  const saved = await writeThemeDraft(db, workspace.published.theme, expectedDraftRevision, workspace.draft.basePublishedRevision, basePublishedRevision, actorId);
  return {
    ...themeStatus(workspace),
    draft: { revision: saved.revision, basePublishedRevision, updatedAt: saved.updatedAt },
    draftDiffersFromLive: false,
  };
}

function publishedThemeWriteStatement(db: Database, serialized: string, expectedRevision: number) {
  if (expectedRevision === 0) {
    return db.insert(themeSettings).values({
      id: THEME_SETTINGS_ID, colors: serialized, revision: 1, createdAt: sql`unixepoch()`, updatedAt: sql`unixepoch()`,
    });
  }
  return db.update(themeSettings)
    .set({ colors: serialized, revision: sql`${themeSettings.revision} + 1`, updatedAt: sql`unixepoch()` })
    .where(and(eq(themeSettings.id, THEME_SETTINGS_ID), eq(themeSettings.revision, expectedRevision)));
}

/**
 * Publishes the exact saved draft revision. One batch writes the live row,
 * its version row (with what changed since the previous live document and
 * the merchant's note), prunes history to THEME_VERSION_HISTORY_LIMIT and
 * moves the draft onto the new live revision, so the draft is always based
 * on what is live and nothing is half-published.
 */
export async function publishThemeDraft(
  db: Database,
  expectedPublishedRevision: number,
  expectedDraftRevision: number,
  actorId: string | null = null,
  note: string | null = null,
): Promise<ThemeStatus> {
  assertNonnegativeRevision(expectedPublishedRevision, "published");
  if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 1) {
    throw new ValidationError("Save the storefront style draft before publishing it.");
  }
  const trimmedNote = note?.trim() || null;
  if (trimmedNote && trimmedNote.length > THEME_PUBLISH_NOTE_MAX) {
    throw new ValidationError(`A publication note must be at most ${THEME_PUBLISH_NOTE_MAX} characters.`);
  }
  const workspace = await getThemeWorkspace(db);
  if (workspace.published.revision !== expectedPublishedRevision || workspace.draft.revision !== expectedDraftRevision
    || workspace.draft.basePublishedRevision !== expectedPublishedRevision) {
    throw themeConflict();
  }
  const normalized = serializeThemeSettings(workspace.draft.theme);
  await assertThemeReferences(db, normalized.theme);
  const changes = compareThemeDocuments(workspace.published.theme, normalized.theme);
  const meta: ThemeVersionMeta = {
    changes: changes.slice(0, THEME_VERSION_CHANGES_MAX),
    moreChanges: Math.max(0, changes.length - THEME_VERSION_CHANGES_MAX),
    note: trimmedNote,
  };
  const versionId = `themev_${nanoid()}`;
  const publishedRevision = expectedPublishedRevision + 1;
  let latestRows: ThemeVersionSummaryRow[];
  let draftRows: Array<{ updatedAt: Date }>;
  try {
    const results = await safeBatch(db, [
      buildPublishedThemeRevisionGuard(db, expectedPublishedRevision),
      buildThemeDraftRevisionGuard(db, expectedDraftRevision, expectedPublishedRevision),
      publishedThemeWriteStatement(db, normalized.serialized, expectedPublishedRevision) as never,
      db.insert(themeSettingsVersions).values({
        id: versionId,
        publishedRevision,
        theme: JSON.stringify({ meta, theme: normalized.theme }),
        source: "publish",
        sourceRevision: null,
        publishedBy: actorId,
        createdAt: sql`unixepoch()`,
      }),
      db.delete(themeSettingsVersions).where(sql`${themeSettingsVersions.publishedRevision} NOT IN (
        SELECT ${themeSettingsVersions.publishedRevision} FROM ${themeSettingsVersions}
        ORDER BY ${themeSettingsVersions.publishedRevision} DESC
        LIMIT ${sql.raw(String(THEME_VERSION_HISTORY_LIMIT))}
      )`),
      themeDraftWriteStatement(db, normalized.serialized, expectedDraftRevision, publishedRevision, actorId) as never,
      selectThemeVersionSummaries(db).where(eq(themeSettingsVersions.id, versionId)).limit(1),
      selectThemeDraftRows(db),
    ]);
    latestRows = results[6] as ThemeVersionSummaryRow[];
    draftRows = results[7] as Array<{ updatedAt: Date }>;
  } catch (error) {
    if (isThemeRevisionConflict(error)) throw themeConflict();
    throw error;
  }
  const latest = latestRows[0]!;
  return {
    published: { revision: publishedRevision },
    draft: { revision: expectedDraftRevision + 1, basePublishedRevision: publishedRevision, updatedAt: draftRows[0]?.updatedAt ?? null },
    draftDiffersFromLive: false,
    lastPublished: { revision: publishedRevision, publishedBy: actorId, publishedByName: latest.publishedByName ?? null, createdAt: latest.createdAt },
  };
}

/** Published versions, newest first, without their documents; `beforeRevision` pages back. */
export async function listThemeVersions(
  db: Database,
  options: { limit?: number; beforeRevision?: number } = {},
): Promise<ThemeVersionSummary[]> {
  const limit = Math.min(THEME_VERSION_PAGE_LIMIT, Math.max(1, Math.trunc(options.limit ?? THEME_VERSION_PAGE_LIMIT)));
  const rows = await selectThemeVersionSummaries(db)
    .where(options.beforeRevision === undefined ? undefined : lt(themeSettingsVersions.publishedRevision, options.beforeRevision))
    .orderBy(desc(themeSettingsVersions.publishedRevision))
    .limit(limit);
  return (rows as ThemeVersionSummaryRow[]).map(themeVersionSummary);
}

/** One published version with its document. */
export async function getThemeVersion(db: Database, revision: number): Promise<ThemeVersionDocument> {
  if (!Number.isInteger(revision) || revision < 1) throw new ValidationError("Choose a published storefront style version.");
  const [summaryRows, documentRows] = await safeBatch(db, [
    selectThemeVersionSummaries(db).where(eq(themeSettingsVersions.publishedRevision, revision)).limit(1),
    db.select({ theme: themeSettingsVersions.theme }).from(themeSettingsVersions)
      .where(eq(themeSettingsVersions.publishedRevision, revision)).limit(1),
  ]);
  const summary = (summaryRows as ThemeVersionSummaryRow[])[0];
  const document = (documentRows as Array<{ theme: string }>)[0];
  if (!summary || !document) throw new NotFoundError("That storefront style version is no longer kept.");
  return { ...themeVersionSummary(summary), theme: parseVersionRow(document.theme).theme };
}

const THEME_PREVIEW_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const THEME_PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL = "THEME_PREVIEW_CONTINUATION_CONSUME_CONFLICT";

/**
 * Preview bearers are `tpc_`/`tpv_` plus 48 characters: `D` and 47 random
 * ones for the shared draft, or `V`, the version's revision (10 base-36
 * digits), `_` and 36 random ones for a published version. Only the SHA-256
 * of the whole bearer is stored, so the revision cannot be changed without
 * losing the session, and the session row needs no column for it.
 */
function previewVersion(token: string): number | null {
  const match = /^tp[cv]_V([0-9a-z]{10})_[A-Za-z0-9_-]{36}$/.exec(token);
  if (!match) return null;
  const revision = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function mintThemePreviewBearer(kind: "tpc" | "tpv", sourceRevision: number | null): string {
  return sourceRevision === null
    ? `${kind}_D${nanoid(47)}`
    : `${kind}_V${sourceRevision.toString(36).padStart(10, "0")}_${nanoid(36)}`;
}

/** Every place that reads or mints a preview row also clears the expired ones. */
function deleteExpiredThemePreviewSessions(db: Database) {
  return db.delete(themePreviewSessions).where(lte(themePreviewSessions.expiresAt, sql`unixepoch()`));
}

/**
 * Opens a preview of the saved draft, or of one published version
 * (`sourceRevision`). The session stores no theme: every preview read
 * resolves the draft (or the version) as it is then, so a refreshed preview
 * shows the latest saved draft for the session's lifetime, and a pruned
 * version stops previewing.
 */
export async function createThemePreviewSession(
  db: Database,
  expectedDraftRevision: number,
  actorId: string | null = null,
  sourceRevision: number | null = null,
): Promise<ThemePreviewContinuationDocument> {
  assertNonnegativeRevision(expectedDraftRevision, "draft");
  let target: { revision: number; basePublishedRevision: number };
  if (sourceRevision !== null) {
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || sourceRevision > 2_147_483_647) {
      throw new ValidationError("Choose a published storefront style version to preview.");
    }
    const version = await db.select({ revision: themeSettingsVersions.publishedRevision }).from(themeSettingsVersions)
      .where(eq(themeSettingsVersions.publishedRevision, sourceRevision)).get();
    if (!version) throw new NotFoundError("That storefront style version is no longer kept.");
    target = { revision: sourceRevision, basePublishedRevision: sourceRevision };
  } else {
    if (expectedDraftRevision < 1) throw new ValidationError("Save the storefront style draft before previewing it.");
    const saved = await db.select({ revision: themeSettingsDrafts.revision, basePublishedRevision: themeSettingsDrafts.basePublishedRevision })
      .from(themeSettingsDrafts)
      .where(and(eq(themeSettingsDrafts.id, THEME_SETTINGS_ID), eq(themeSettingsDrafts.revision, expectedDraftRevision)))
      .get();
    if (!saved) throw themeConflict("The storefront style draft changed before preview opened. Reload the latest draft.");
    target = saved;
  }

  // This is a one-time browser continuation bearer, carried only in a bounded
  // same-origin POST body. Only the service-authenticated exchange accepts it,
  // and the raw value is never persisted or placed in a URL.
  const continuationId = mintThemePreviewBearer("tpc", sourceRevision);
  const tokenHash = await hashThemePreviewToken(continuationId);
  const expiresAt = new Date(Date.now() + THEME_PREVIEW_CONTINUATION_TTL_MS);
  await safeBatch(db, [
    deleteExpiredThemePreviewSessions(db),
    db.insert(themePreviewSessions).values({ tokenHash, expiresAt, createdBy: actorId, createdAt: sql`unixepoch()` }),
  ]);
  return { continuationId, draftRevision: target.revision, basePublishedRevision: target.basePublishedRevision, expiresAt };
}

/**
 * Atomically consume a browser continuation and mint the cookie-only preview
 * bearer (for the same draft or version). The caller must be the
 * service-authenticated storefront bridge; the raw bearer must never be
 * returned to a dashboard or agent operation.
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
    .where(and(eq(themePreviewSessions.tokenHash, continuationHash), gt(themePreviewSessions.expiresAt, sql`unixepoch()`)))
    .get();
  if (!continuation) throw new ConflictError("Theme preview continuation is unavailable or expired.");

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
      db.insert(themePreviewSessions).values({ tokenHash, expiresAt, createdBy: continuation.createdBy, createdAt: sql`unixepoch()` }),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, THEME_PREVIEW_CONTINUATION_CONSUME_SENTINEL)) {
      throw new ConflictError("Theme preview continuation is unavailable or expired.");
    }
    throw error;
  }
  return { token, expiresAt };
}

/** The saved draft (or the token's version) as it is now; null when the token is unknown, expired or its version pruned. */
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
      ? db.select({
        theme: themeSettingsDrafts.theme,
        draftRevision: themeSettingsDrafts.revision,
        basePublishedRevision: themeSettingsDrafts.basePublishedRevision,
        expiresAt: themePreviewSessions.expiresAt,
      }).from(themePreviewSessions).innerJoin(themeSettingsDrafts, eq(themeSettingsDrafts.id, THEME_SETTINGS_ID)).where(authorized).limit(1)
      : db.select({
        theme: themeSettingsVersions.theme,
        draftRevision: themeSettingsVersions.publishedRevision,
        basePublishedRevision: themeSettingsVersions.publishedRevision,
        expiresAt: themePreviewSessions.expiresAt,
      }).from(themePreviewSessions).innerJoin(themeSettingsVersions, eq(themeSettingsVersions.publishedRevision, sourceRevision)).where(authorized).limit(1),
  ]);
  const row = (results[1] as Array<{ theme: string; draftRevision: number; basePublishedRevision: number; expiresAt: Date }>)[0];
  if (!row) return null;
  return {
    theme: sourceRevision === null ? parseAuthoritativeThemeSettings(row.theme) : parseVersionRow(row.theme).theme,
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
