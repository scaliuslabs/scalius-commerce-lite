// The source side of every translatable resource (MARKETS-DESIGN D9): which
// table holds it, which columns are its translatable fields and handle, and
// how the editor lists it. Read straight from the tables (no domain module),
// so this domain sits below every domain whose reads it serves.
//
// A product's SKUs, options and option values are translated with their
// product: the editor reads them as the product's parts. A menu's links are
// the menu's item fields (`item:<id>`), from its published revision; a link
// whose label is its resource's name is translated with that resource.
// Payment methods are code (built-in gateways and app providers): their
// source names come from the caller (`PaymentMethodSource`).
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import type { TranslatableResourceType, TranslationSource } from "@scalius/shared/translations";

interface TableSource {
  table: string;
  /** Translation field → column. */
  columns: Readonly<Record<string, string>>;
  /** The column the editor lists the resource by. */
  title: string;
  /** A second line in the list (a page's type, a SKU's code). */
  subtitle?: string;
  slug?: string;
  /** Rows the editor lists (live, not trashed). */
  live?: string;
}

const SEO = { metaTitle: "meta_title", metaDescription: "meta_description" } as const;

export const TABLE_SOURCES: Readonly<Partial<Record<TranslatableResourceType, TableSource>>> = {
  product: { table: "products", title: "name", slug: "slug", live: "deleted_at IS NULL", columns: { name: "name", description: "description", ...SEO } },
  product_variant: { table: "product_variants", title: "sku", live: "deleted_at IS NULL", columns: { preorderMessage: "preorder_message" } },
  product_option: { table: "product_option_definitions", title: "name", live: "deleted_at IS NULL", columns: { name: "name" } },
  product_option_value: { table: "product_option_values", title: "value", live: "deleted_at IS NULL", columns: { value: "value" } },
  collection: { table: "collections", title: "name", live: "deleted_at IS NULL", columns: { name: "name", description: "description", content: "content", ...SEO } },
  category: { table: "categories", title: "name", slug: "slug", live: "deleted_at IS NULL", columns: { name: "name", description: "description", content: "content", ...SEO } },
  brand: { table: "brands", title: "name", slug: "slug", live: "deleted_at IS NULL", columns: { name: "name", description: "description", ...SEO } },
  page: { table: "pages", title: "title", subtitle: "content_type", slug: "slug", live: "deleted_at IS NULL", columns: { title: "title", content: "content", excerpt: "excerpt", ...SEO } },
  menu: { table: "navigation_menus", title: "name", subtitle: "handle", live: "deleted_at IS NULL", columns: { title: "name" } },
  shipping_method: { table: "shipping_methods", title: "name", subtitle: "kind", live: "deleted_at IS NULL", columns: { name: "name", description: "description", pickupHours: "pickup_hours" } },
};

/** A payment method's source text (built-in gateways and app providers are code). */
export interface PaymentMethodSource {
  id: string;
  name: string;
  description?: string | null;
}

/** One resource as the editor lists and translates it. */
export interface ResourceSource {
  type: TranslatableResourceType;
  id: string;
  title: string;
  subtitle: string | null;
  fields: TranslationSource;
  /** The source URL handle, for a type with handles. */
  slug: string | null;
}

const ident = (name: string) => sql.raw(`"${name}"`);

function columnNames(source: TableSource): string[] {
  return [
    "id",
    "__title",
    ...(source.subtitle ? ["__subtitle"] : []),
    ...(source.slug ? ["__slug"] : []),
    ...Object.keys(source.columns),
  ];
}

function selectColumns(source: TableSource): SQL {
  const parts = [`"id" AS "id"`, `"${source.title}" AS "__title"`];
  if (source.subtitle) parts.push(`"${source.subtitle}" AS "__subtitle"`);
  if (source.slug) parts.push(`"${source.slug}" AS "__slug"`);
  for (const [field, column] of Object.entries(source.columns)) parts.push(`"${column}" AS "${field}"`);
  return sql.raw(parts.join(", "));
}

/**
 * Rows of a raw `db.all` read as objects: D1 and Turso return objects, the
 * PostgreSQL proxy value arrays in select-list order.
 */
export async function namedRows<T extends Record<string, unknown>>(rows: Promise<unknown[]>, columns: readonly string[]): Promise<T[]> {
  return (await rows).map((row) => Array.isArray(row)
    ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T
    : row as T);
}

function toSource(type: TranslatableResourceType, source: TableSource, row: Record<string, unknown>): ResourceSource {
  const fields: TranslationSource = {};
  for (const field of Object.keys(source.columns)) {
    const value = row[field];
    fields[field] = typeof value === "string" ? value : null;
  }
  return {
    type,
    id: String(row.id),
    title: typeof row.__title === "string" ? row.__title : String(row.id),
    subtitle: typeof row.__subtitle === "string" ? row.__subtitle : null,
    fields,
    slug: typeof row.__slug === "string" ? row.__slug : null,
  };
}

/** The live resources of a table-backed type with these ids. */
export async function readTableSources(db: Database, type: TranslatableResourceType, ids: readonly string[]): Promise<ResourceSource[]> {
  const source = TABLE_SOURCES[type];
  if (!source || ids.length === 0) return [];
  const rows = await namedRows<Record<string, unknown>>(db.all(sql`SELECT ${selectColumns(source)} FROM ${ident(source.table)}
    WHERE "id" IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))${source.live ? sql.raw(` AND ${source.live}`) : sql``}`), columnNames(source));
  return rows.map((row) => toSource(type, source, row));
}

/** One page of a table-backed type's live resources, by title, matching `search` in the title. */
export async function pageTableSources(
  db: Database,
  type: TranslatableResourceType,
  options: { search?: string; offset: number; limit: number },
): Promise<{ items: ResourceSource[]; total: number }> {
  const source = TABLE_SOURCES[type];
  if (!source) return { items: [], total: 0 };
  const conditions: SQL[] = [];
  if (source.live) conditions.push(sql.raw(source.live));
  const search = options.search?.trim();
  if (search) conditions.push(sql`lower(${ident(source.title)}) LIKE ${`%${search.toLowerCase()}%`}`);
  const where = conditions.length ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const [rows, count] = await Promise.all([
    namedRows<Record<string, unknown>>(db.all(sql`SELECT ${selectColumns(source)} FROM ${ident(source.table)}${where}
      ORDER BY lower(${ident(source.title)}), "id" LIMIT ${options.limit} OFFSET ${options.offset}`), columnNames(source)),
    namedRows<{ n: number }>(db.all(sql`SELECT count(*) AS n FROM ${ident(source.table)}${where}`), ["n"]),
  ]);
  return { items: rows.map((row) => toSource(type, source, row)), total: Number(count[0]?.n ?? 0) };
}

/** A product's parts: its live SKUs (with a pre-order message), options and option values. */
export async function readProductParts(db: Database, productId: string): Promise<ResourceSource[]> {
  const [variants, options, values] = await Promise.all([
    namedRows<Record<string, unknown>>(db.all(sql`SELECT ${selectColumns(TABLE_SOURCES.product_variant!)} FROM "product_variants"
      WHERE "product_id" = ${productId} AND deleted_at IS NULL AND "is_default" = 0 ORDER BY "created_at", "id"`), columnNames(TABLE_SOURCES.product_variant!)),
    namedRows<Record<string, unknown>>(db.all(sql`SELECT ${selectColumns(TABLE_SOURCES.product_option!)} FROM "product_option_definitions"
      WHERE "product_id" = ${productId} AND deleted_at IS NULL ORDER BY "position", "id"`), columnNames(TABLE_SOURCES.product_option!)),
    namedRows<Record<string, unknown>>(db.all(sql`SELECT option_value."id" AS "id", option_value."value" AS "__title", option_value."option_definition_id" AS "__subtitle",
        option_value."value" AS "value"
      FROM "product_option_values" AS option_value
      JOIN "product_option_definitions" AS value_option ON value_option."id" = option_value."option_definition_id"
      WHERE value_option."product_id" = ${productId} AND option_value.deleted_at IS NULL AND value_option.deleted_at IS NULL
      ORDER BY value_option."position", option_value."position", option_value."id"`), ["id", "__title", "__subtitle", "value"]),
  ]);
  return [
    ...options.map((row) => toSource("product_option", TABLE_SOURCES.product_option!, row)),
    ...values.map((row) => toSource("product_option_value", TABLE_SOURCES.product_option_value!, row)),
    ...variants.map((row) => toSource("product_variant", TABLE_SOURCES.product_variant!, row)),
  ];
}

/**
 * A menu's custom link labels from its published revision, as item fields
 * (`item:<id>`). Links labelled by their resource's name follow that resource.
 */
export async function readMenuItems(db: Database, menuId: string): Promise<Array<{ id: string; label: string }>> {
  return namedRows<{ id: string; label: string }>(db.all(sql`SELECT published_item."item_id" AS "id", published_item."label" AS "label"
    FROM "navigation_menu_publication_items" AS published_item
    JOIN "navigation_menus" AS published_menu ON published_menu."id" = published_item."menu_id" AND published_menu."published_revision" = published_item."revision"
    WHERE published_item."menu_id" = ${menuId} AND published_item."label_mode" = 'custom'
    ORDER BY published_item."parent_id" IS NOT NULL, published_item."position", published_item."item_id"`), ["id", "label"]);
}

export const MENU_ITEM_PREFIX = "item:";
