// The translation editor's reads and writes (Shopify's Translate & Adapt):
// every translatable resource with its source text and, per language and
// market, its translation, its localized handle and which fields are
// Outdated (their source changed since they were translated).
//
// A save replaces the translation of one resource in one locale and market
// (empty fields fall back) and records the digest of the source each field
// was translated from. Editors submit the source digest and translation revision
// they observed; batch guards refuse stale source text and competing writes.
// The database keeps one row per resource,
// locale and market and every localized handle unique.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertRichTextFits } from "../../utils/rich-text";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { localizedSlugs, markets, storeLanguages, translations } from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
  MAX_TRANSLATION_FIELDS,
  TRANSLATABLE_RESOURCES,
  isLocalizedSlug,
  isSluggedResourceType,
  isStoreLocale,
  normalizeTranslationFields,
  translatableField,
  outdatedTranslationFields,
  parseTranslationFields,
  translationFieldIssues,
  translationSourceDigest,
  sourceTextDigest,
  type TranslatableResourceType,
  type TranslationFields,
  type TranslationSource,
} from "@scalius/shared/translations";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
  MENU_ITEM_PREFIX,
  pageTableSources,
  readMenuItems,
  readProductParts,
  readTableSources,
  resourceSourceUnchanged,
  type PaymentMethodSource,
  type ResourceSource,
} from "./resources";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The types the editor lists on their own (a product's parts are edited with it). */
export const EDITOR_RESOURCE_TYPES = [
  "product",
  "collection",
  "category",
  "brand",
  "page",
  "menu",
  "shipping_method",
  "payment_method",
] as const satisfies readonly TranslatableResourceType[];
export type EditorResourceType = (typeof EDITOR_RESOURCE_TYPES)[number];

/** At most this many resources per save (a product with its options, values and SKUs). */
export const MAX_TRANSLATION_ENTRIES_PER_SAVE = 200;

/** How a resource stands in one language (Shopify's translation status). */
export type TranslationStatus = "translated" | "outdated" | "partial" | "untranslated";

export interface ResourceTranslation {
  locale: string;
  marketId: string | null;
  fields: TranslationFields;
  /** Translated fields whose source changed since. */
  outdated: string[];
  updatedAt: Date | null;
}

export interface TranslatableResource {
  type: TranslatableResourceType;
  id: string;
  title: string;
  subtitle: string | null;
  /** The source text by field (a menu's links as `item:<id>`). */
  source: TranslationSource;
  /** Digests of the displayed source fields; send them back when saving. */
  sourceDigest: Record<string, string>;
  /** Opaque revision of the translation and localized handle; null means neither exists. */
  revision: string | null;
  /** The source handle (a type with handles). */
  sourceSlug: string | null;
  /** The translation in the requested locale and market, or null. */
  translation: ResourceTranslation | null;
  /** The localized handle in the requested locale, or null. */
  slug: string | null;
  status: TranslationStatus;
}

export interface ResourceTranslationsView {
  resource: TranslatableResource;
  /** A product's options, option values and SKUs, each with its own translation. */
  parts: TranslatableResource[];
}

export interface TranslationContextInput {
  locale: string;
  /** A market-specific translation (Shopify's market adaptation); null: every market. */
  marketId?: string | null;
  /** Payment methods are code: the caller passes their source names. */
  paymentMethods?: readonly PaymentMethodSource[];
}

function cleanContext(input: TranslationContextInput): { locale: string; marketId: string | null } {
  const locale = input.locale.trim().toLowerCase();
  if (!isStoreLocale(locale)) throw new ValidationError("Choose a language by its two-letter code, such as bn.");
  const marketId = input.marketId?.trim() || null;
  return { locale, marketId };
}

function isEditorType(type: string): type is EditorResourceType {
  return (EDITOR_RESOURCE_TYPES as readonly string[]).includes(type);
}

/** What counts as the resource's source fields: its fixed fields with text, and a menu's custom links. */
function translatableKeys(resource: ResourceSource): string[] {
  return Object.entries(resource.fields).filter(([, value]) => typeof value === "string" && value.trim() !== "").map(([key]) => key);
}

function statusOf(resource: ResourceSource, translation: ResourceTranslation | null): TranslationStatus {
  const keys = translatableKeys(resource);
  if (!translation || Object.keys(translation.fields).length === 0) return "untranslated";
  if (translation.outdated.length > 0) return "outdated";
  return keys.every((key) => typeof translation.fields[key] === "string") ? "translated" : "partial";
}

function paymentSources(paymentMethods: readonly PaymentMethodSource[] | undefined, ids?: readonly string[]): ResourceSource[] {
  return (paymentMethods ?? [])
    .filter((method) => !ids || ids.includes(method.id))
    .map((method) => ({
      type: "payment_method" as const,
      id: method.id,
      title: method.name,
      subtitle: method.id,
      fields: { name: method.name, description: method.description ?? null },
      slug: null,
    }));
}

async function withMenuItems(db: Database, sources: ResourceSource[]): Promise<ResourceSource[]> {
  const result: ResourceSource[] = [];
  // A page may contain 100 menus; serialize their dependent reads within D1's connection cap.
  for (const source of sources) {
    if (source.type !== "menu") { result.push(source); continue; }
    const items = await readMenuItems(db, source.id);
    const fields = { ...source.fields };
    for (const item of items) fields[`${MENU_ITEM_PREFIX}${item.id}`] = item.label;
    result.push({ ...source, fields });
  }
  return result;
}

async function readSources(db: Database, type: TranslatableResourceType, ids: readonly string[], paymentMethods?: readonly PaymentMethodSource[]): Promise<ResourceSource[]> {
  if (type === "payment_method") return paymentSources(paymentMethods, ids);
  return withMenuItems(db, await readTableSources(db, type, ids));
}

interface StoredTranslation {
  id: string;
  resourceType: string;
  resourceId: string;
  fields: string;
  sourceDigest: string;
  updatedAt: Date | null;
}

function storedQueries(db: Database, type: TranslatableResourceType | null, ids: readonly string[], context: { locale: string; marketId: string | null }, types?: readonly string[]) {
  return [
    db.select({
      id: translations.id,
      resourceType: translations.resourceType,
      resourceId: translations.resourceId,
      fields: translations.fields,
      sourceDigest: translations.sourceDigest,
      updatedAt: translations.updatedAt,
    }).from(translations).where(and(
      type ? eq(translations.resourceType, type) : inArray(translations.resourceType, [...(types ?? [])] as never),
      sql`${translations.resourceId} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`,
      eq(translations.locale, context.locale),
      context.marketId ? eq(translations.marketId, context.marketId) : isNull(translations.marketId),
    )),
    db.select({ resourceType: localizedSlugs.resourceType, resourceId: localizedSlugs.resourceId, slug: localizedSlugs.slug })
      .from(localizedSlugs)
      .where(and(
        sql`${localizedSlugs.resourceId} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`,
        eq(localizedSlugs.locale, context.locale),
      )),
  ] as const;
}

async function readStored(db: Database, type: TranslatableResourceType | null, ids: readonly string[], context: { locale: string; marketId: string | null }, types?: readonly string[]) {
  if (ids.length === 0) return [[], []] as const;
  const [rows, slugRows] = await Promise.all(storedQueries(db, type, ids, context, types));
  return [rows as StoredTranslation[], slugRows] as const;
}

/** Content revision includes the row identity, so a delete/recreate cannot reuse it. */
function translationRevision(stored: StoredTranslation | undefined, slug: string | null): string | null {
  return stored || slug ? sourceTextDigest(JSON.stringify([
    stored?.id ?? null, stored?.fields ?? null, stored?.sourceDigest ?? null,
    stored?.updatedAt?.getTime() ?? null, slug,
  ])) : null;
}

function present(
  source: ResourceSource,
  stored: StoredTranslation | undefined,
  slug: string | null,
  context: { locale: string; marketId: string | null },
): TranslatableResource {
  const fields = stored ? parseTranslationFields(stored.fields) : {};
  const translation: ResourceTranslation | null = stored
    ? {
      locale: context.locale,
      marketId: context.marketId,
      fields,
      outdated: outdatedTranslationFields(fields, stored.sourceDigest, source.fields),
      updatedAt: stored.updatedAt ?? null,
    }
    : null;
  return {
    type: source.type,
    id: source.id,
    title: source.title,
    subtitle: source.subtitle,
    source: source.fields,
    sourceDigest: JSON.parse(translationSourceDigest(source.fields, Object.keys(source.fields))) as Record<string, string>,
    revision: translationRevision(stored, context.marketId ? null : slug),
    sourceSlug: isSluggedResourceType(source.type) ? source.slug : null,
    translation,
    slug: context.marketId ? null : slug,
    status: statusOf(source, translation),
  };
}

async function assertContext(db: Database, context: { locale: string; marketId: string | null }): Promise<void> {
  const [language, market] = await Promise.all([
    db.select({ locale: storeLanguages.locale }).from(storeLanguages).where(eq(storeLanguages.locale, context.locale)).get(),
    context.marketId ? db.select({ id: markets.id }).from(markets).where(eq(markets.id, context.marketId)).get() : Promise.resolve({ id: null }),
  ]);
  if (!language) throw new NotFoundError("Add the language to the store first.");
  if (!market) throw new NotFoundError("Market not found");
}

/**
 * One page of a type's resources with their status in a language (and
 * market), by title, matching `search` in the title.
 */
export async function listTranslatableResources(
  db: Database,
  type: string,
  input: TranslationContextInput & { search?: string; page?: number; limit?: number },
): Promise<{ items: TranslatableResource[]; total: number; page: number; limit: number }> {
  if (!isEditorType(type)) throw new ValidationError("Choose a resource type to translate.");
  const context = cleanContext(input);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), 100);
  const page = Math.max(Math.trunc(input.page ?? 1), 1);
  let sources: ResourceSource[];
  let total: number;
  if (type === "payment_method") {
    const all = paymentSources(input.paymentMethods)
      .filter((source) => !input.search?.trim() || source.title.toLowerCase().includes(input.search.trim().toLowerCase()));
    total = all.length;
    sources = all.slice((page - 1) * limit, page * limit);
  } else {
    const result = await pageTableSources(db, type, { search: input.search, offset: (page - 1) * limit, limit });
    total = result.total;
    sources = await withMenuItems(db, result.items);
  }
  const [stored, slugs] = await readStored(db, type, sources.map((source) => source.id), context);
  return {
    items: sources.map((source) => present(
      source,
      stored.find((row) => row.resourceId === source.id),
      slugs.find((row) => row.resourceId === source.id && row.resourceType === type)?.slug ?? null,
      context,
    )),
    total,
    page,
    limit,
  };
}

/** One resource with its translation in a language (and market); a product with its parts. */
export async function getResourceTranslations(
  db: Database,
  type: string,
  id: string,
  input: TranslationContextInput,
): Promise<ResourceTranslationsView> {
  if (!isEditorType(type)) throw new ValidationError("Choose a resource type to translate.");
  const context = cleanContext(input);
  const [source] = await readSources(db, type, [id], input.paymentMethods);
  if (!source) throw new NotFoundError("Nothing to translate here: the resource does not exist or is in the trash.");
  const parts = type === "product" ? await readProductParts(db, id) : [];
  const partTypes = ["product_option", "product_option_value", "product_variant"];
  const [[stored, slugs], [partStored]] = await Promise.all([
    readStored(db, type, [id], context),
    readStored(db, null, parts.map((part) => part.id), context, partTypes),
  ]);
  return {
    resource: present(source, stored[0], slugs.find((row) => row.resourceType === type)?.slug ?? null, context),
    parts: parts.map((part) => present(part, partStored.find((row) => row.resourceType === part.type && row.resourceId === part.id), null, context)),
  };
}

export interface TranslationEntryInput {
  type: TranslatableResourceType;
  id: string;
  /** The whole translation: fields left out (or empty) fall back to the source. */
  fields: Record<string, string>;
  /** Digests observed by the author; a changed or missing submitted field refuses the save. */
  sourceDigest?: Record<string, string>;
  /** Observed translation/handle revision; null asserts that neither exists. Omit for legacy writes. */
  revision?: string | null;
  /** The localized handle (a type with handles, every-market translations only); empty or null removes it. */
  slug?: string | null;
}

function translationWriteError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isBatchGuardError(error, "TRANSLATION_SOURCE_CONFLICT")) return new ConflictError("The source text changed while you were translating. Reload it and review your translation.");
  if (isBatchGuardError(error, "TRANSLATION_REVISION_CONFLICT")) return new ConflictError("This translation changed while you were editing. Reload it and try again.");
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  if (/LOCALIZED_SLUG_TAKEN/.test(text)) return new ConflictError("Another page of this kind uses this web address. Choose another.");
  if (/localized_slugs/i.test(text) && /UNIQUE|PRIMARY|duplicate/i.test(text)) {
    return new ConflictError("Another page of this kind uses this web address in this language. Choose another.");
  }
  if (/FOREIGN KEY|foreign key/i.test(text)) return new NotFoundError("The language or market no longer exists. Reload and try again.");
  return error;
}

/**
 * Saves translations of a resource (and, for a product, its parts) in one
 * language and market, in one batch. Observed source digests and revisions
 * are optional for old clients; the dashboard supplies both. A stale author
 * snapshot refuses the whole save, including parts and handles. Empty fields
 * remove the translation, restoring source fallback.
 */
export async function saveTranslations(
  db: Database,
  input: TranslationContextInput & { entries: readonly TranslationEntryInput[] },
): Promise<Record<string, string | null>> {
  const context = cleanContext(input);
  if (input.entries.length === 0) return {};
  if (input.entries.length > MAX_TRANSLATION_ENTRIES_PER_SAVE) {
    throw new ValidationError(`Save at most ${MAX_TRANSLATION_ENTRIES_PER_SAVE} translations at once.`);
  }
  await assertContext(db, context);
  const byType = new Map<TranslatableResourceType, string[]>();
  const identities = new Set<string>();
  for (const entry of input.entries) {
    const key = `${entry.type}:${entry.id}`;
    if (identities.has(key)) throw new ValidationError("A resource may appear only once in a translation save.");
    identities.add(key);
    if (!(entry.type in TRANSLATABLE_RESOURCES)) throw new ValidationError(`Unknown resource type ${entry.type}.`);
    const issues = translationFieldIssues(entry.type, entry.fields);
    if (issues.length > 0) {
      throw new ValidationError(`Some fields can't be saved: ${issues.map((issue) => issue.code === "too_long" ? `${issue.field} is longer than ${issue.max} characters` : `${issue.field} is not a field of this resource`).join("; ")}.`, { issues });
    }
    if (Object.keys(entry.fields).length > MAX_TRANSLATION_FIELDS) throw new ValidationError(`A translation has at most ${MAX_TRANSLATION_FIELDS} fields.`);
    if (entry.slug !== undefined && entry.slug !== null && entry.slug !== "") {
      if (!isSluggedResourceType(entry.type)) throw new ValidationError("This kind of page has no web address to translate.");
      if (context.marketId) throw new ValidationError("A web address is translated for every market of a language, not one market.");
      if (!isLocalizedSlug(entry.slug)) throw new ValidationError("A web address uses lowercase letters, digits and single dashes, at most 100 characters.");
    }
    byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry.id]);
  }
  // The source as it is now (live resources only): its digest marks what each field was translated from.
  const sources = new Map<string, ResourceSource>();
  for (const [type, ids] of byType) {
    for (const source of await readSources(db, type, ids, input.paymentMethods)) sources.set(`${type}:${source.id}`, source);
  }
  const [currentTranslations, currentSlugs] = await readStored(db, null,
    input.entries.map((entry) => entry.id), context, [...byType.keys()]);
  const writes: SQLiteBatchItem[] = [];
  const guards: SQLiteBatchItem[] = [];
  for (const entry of input.entries) {
    const source = sources.get(`${entry.type}:${entry.id}`);
    if (!source) throw new NotFoundError("Nothing to translate here: a resource does not exist or is in the trash.");
    const fields = normalizeTranslationFields(entry.type, entry.fields);
    const identity = and(
      eq(translations.resourceType, entry.type),
      eq(translations.resourceId, entry.id),
      eq(translations.locale, context.locale),
      context.marketId ? eq(translations.marketId, context.marketId) : isNull(translations.marketId),
    );
    const current = currentTranslations.find((row) => row.resourceType === entry.type && row.resourceId === entry.id);
    // Rich fields as stored (sanitized on normalize) fit the bound, unless no longer than the stored translation.
    await assertRichTextFits(
      Object.fromEntries(Object.entries(fields).filter(([key]) => translatableField(entry.type, key)?.kind === "html")),
      () => Object.fromEntries(Object.entries(parseTranslationFields(current?.fields ?? "{}")).map(([key, value]) => [key, value.length])),
    );
    const currentSlug = context.marketId ? null : currentSlugs.find((row) => row.resourceType === entry.type && row.resourceId === entry.id)?.slug ?? null;
    if (entry.sourceDigest !== undefined) {
      if (Object.keys(fields).some((field) => entry.sourceDigest?.[field] !== sourceTextDigest(source.fields[field] ?? ""))) {
        throw new ConflictError("The source text changed while you were translating. Reload it and review your translation.");
      }
      const unchanged = resourceSourceUnchanged(source);
      if (unchanged) guards.push(buildBatchGuard(db, unchanged, "TRANSLATION_SOURCE_CONFLICT"));
    }
    if (entry.revision !== undefined) {
      if (entry.revision !== translationRevision(current, currentSlug)) {
        throw new ConflictError("This translation changed while you were editing. Reload it and try again.");
      }
      const rowUnchanged = current
        ? sql`EXISTS (SELECT 1 FROM ${translations} WHERE ${identity} AND ${translations.id} = ${current.id}
            AND ${translations.fields} = ${current.fields} AND ${translations.sourceDigest} = ${current.sourceDigest}
            AND ${eq(translations.updatedAt, current.updatedAt!)})`
        : sql`NOT EXISTS (SELECT 1 FROM ${translations} WHERE ${identity})`;
      const slugIdentity = sql`${localizedSlugs.resourceType} = ${entry.type} AND ${localizedSlugs.resourceId} = ${entry.id} AND ${localizedSlugs.locale} = ${context.locale}`;
      const slugUnchanged = context.marketId ? sql`1 = 1` : currentSlug
        ? sql`EXISTS (SELECT 1 FROM ${localizedSlugs} WHERE ${slugIdentity} AND ${localizedSlugs.slug} = ${currentSlug})`
        : sql`NOT EXISTS (SELECT 1 FROM ${localizedSlugs} WHERE ${slugIdentity})`;
      guards.push(buildBatchGuard(db, sql`${rowUnchanged} AND ${slugUnchanged}`, "TRANSLATION_REVISION_CONFLICT"));
    }
    if (Object.keys(fields).length === 0) {
      writes.push(db.delete(translations).where(identity) as unknown as SQLiteBatchItem);
    } else {
      const digest = translationSourceDigest(source.fields, Object.keys(fields));
      const text = JSON.stringify(fields);
      // One row per identity: replace it in place (the unique index guards a concurrent insert).
      writes.push(db.update(translations)
        .set({ fields: text, sourceDigest: digest, updatedAt: sql`unixepoch()` })
        .where(and(identity, sql`(${translations.fields} IS NOT ${text} OR ${translations.sourceDigest} IS NOT ${digest})`)) as unknown as SQLiteBatchItem);
      writes.push(db.insert(translations).select(
        db.select({
          id: sql<string>`${`tr_${nanoid(16)}`}`.as("id"),
          resourceType: sql<string>`${entry.type}`.as("resource_type"),
          resourceId: sql<string>`${entry.id}`.as("resource_id"),
          locale: sql<string>`${context.locale}`.as("locale"),
          marketId: sql<string | null>`${context.marketId}`.as("market_id"),
          fields: sql<string>`${text}`.as("fields"),
          sourceDigest: sql<string>`${digest}`.as("source_digest"),
          updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
        }).from(sql`(SELECT 1 AS one) AS translation_seed`)
          .where(sql`NOT EXISTS (SELECT 1 FROM ${translations} AS existing WHERE existing.resource_type = ${entry.type} AND existing.resource_id = ${entry.id} AND existing.locale = ${context.locale} AND coalesce(existing.market_id, '') = ${context.marketId ?? ""})`),
      ) as unknown as SQLiteBatchItem);
    }
    if (entry.slug !== undefined && isSluggedResourceType(entry.type) && !context.marketId) {
      const requested = entry.slug?.trim() ?? "";
      // The source's own handle is no translation: the page keeps its source address.
      const next = requested === source.slug ? "" : requested;
      const current = currentSlugs.find((row) => row.resourceType === entry.type && row.resourceId === entry.id)?.slug ?? "";
      if (next !== current) {
        writes.push(db.delete(localizedSlugs).where(and(
          eq(localizedSlugs.resourceType, entry.type),
          eq(localizedSlugs.resourceId, entry.id),
          eq(localizedSlugs.locale, context.locale),
        )) as unknown as SQLiteBatchItem);
        // A handle another resource holds in this language fails the batch (primary key).
        if (next) {
          writes.push(db.insert(localizedSlugs)
            .values({ resourceType: entry.type, locale: context.locale, slug: next, resourceId: entry.id }) as unknown as SQLiteBatchItem);
        }
      }
    }
  }
  try {
    // The response read can race a later writer. Capture our own revisions in
    // this transaction so an editor retaining in-flight edits cannot adopt theirs.
    const result = await safeBatch(db, [...guards, ...writes,
      ...storedQueries(db, null, input.entries.map((entry) => entry.id), context, [...byType.keys()]),
    ] as never) as unknown as unknown[];
    const stored = result[result.length - 2] as StoredTranslation[];
    const slugs = result[result.length - 1] as Array<{ resourceType: string; resourceId: string; slug: string }>;
    return Object.fromEntries(input.entries.map((entry) => [`${entry.type}:${entry.id}`, translationRevision(
      stored.find((row) => row.resourceType === entry.type && row.resourceId === entry.id),
      context.marketId ? null : slugs.find((row) => row.resourceType === entry.type && row.resourceId === entry.id)?.slug ?? null,
    )]));
  } catch (error) {
    throw translationWriteError(error);
  }
}

/** Deletes a resource's translation (and, every-market, its handle) in a language. */
export async function deleteResourceTranslation(
  db: Database,
  type: string,
  id: string,
  input: { locale: string; marketId?: string | null },
): Promise<void> {
  if (!(type in TRANSLATABLE_RESOURCES)) throw new ValidationError("Unknown resource type.");
  const context = cleanContext(input);
  const writes: SQLiteBatchItem[] = [
    db.delete(translations).where(and(
      eq(translations.resourceType, type as TranslatableResourceType),
      eq(translations.resourceId, id),
      eq(translations.locale, context.locale),
      context.marketId ? eq(translations.marketId, context.marketId) : isNull(translations.marketId),
    )) as unknown as SQLiteBatchItem,
  ];
  if (!context.marketId && isSluggedResourceType(type)) {
    writes.push(db.delete(localizedSlugs).where(and(
      eq(localizedSlugs.resourceType, type),
      eq(localizedSlugs.resourceId, id),
      eq(localizedSlugs.locale, context.locale),
    )) as unknown as SQLiteBatchItem);
  }
  await safeBatch(db, writes as never);
}

