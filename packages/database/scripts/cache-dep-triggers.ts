/**
 * Generates cache dependency migrations (D1/Turso SQL and PostgreSQL
 * sidecars) from the dependency registry in
 * `@scalius/shared/cache-deps`: the `cache_clock` and `cache_dep` tables and
 * one trigger per registered table and rule. The checked-in files must equal
 * this output (`__tests__/cache-dep-triggers.test.ts`), so the triggers never
 * drift from the registry that read recording and tests use.
 *
 * `--write` writes additive 0101 only. Deployed 0100 is immutable; its
 * renderer remains here so byte-parity checks keep the baseline unchanged.
 *
 *   pnpm --filter @scalius/database exec tsx scripts/cache-dep-triggers.ts --write
 *
 * SQLite (D1, Turso): a trigger's guard is its WHEN clause and its body is one
 * `INSERT INTO cache_dep ... SELECT ... ON CONFLICT DO UPDATE` statement (no
 * CASE anywhere: remote D1 rejects trigger bodies that embed one). Each key
 * gets `cache_clock.seq + 1`, and one trigger on `cache_dep` raises the clock
 * to it. SQLite has one writer (Turso BEGIN CONCURRENT transactions that both
 * bump conflict on the clock row and retry), so seq order is commit order.
 *
 * PostgreSQL: every trigger is a deferred constraint trigger. At commit it
 * locks the clock row (`UPDATE ... SET seq = seq + 1`), so bumping
 * transactions commit in seq order, and it takes that lock only after every
 * row lock the transaction needs is held, so the clock adds no deadlock.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../src/schema";
import { compileSqliteDdlForPostgres } from "./postgres-schema";
import {
  CACHE_DEP_TABLES,
  type CacheDepKeyTemplate,
  type CacheDepKind,
  type CacheDepRule,
  type CacheDepTableSpec,
} from "../../shared/src/cache-deps";

export const CACHE_DEP_MIGRATION = {
  version: 100,
  name: "0100_cache_dependencies",
} as const;

/** Additive projection coverage; deployed 0100 is immutable. */
export const CACHE_DEP_PROJECTION_MIGRATION = {
  version: 101,
  name: "0101_cache_ordering_dependencies",
} as const;
const PROJECTION_TABLES = new Set(["product_recommendations", "product_sales_stats", "orders", "order_items"]);

/**
 * Tables registered after 0101 whose triggers a later, hand-assembled
 * migration installs; that migration must contain each generated statement
 * verbatim (`__tests__/custom-fields-migration.test.ts`).
 */
export const CACHE_DEP_LATER_TABLES: Readonly<Record<string, string>> = {
  custom_field_definitions: "0104_custom_fields",
  custom_field_values: "0104_custom_fields",
  promotion_customer_segments: "0108_customer_marketing",
  plugin_installations: "0110_plugin_providers",
  plugin_registrations: "0110_plugin_providers",
  plugin_records: "0110_plugin_providers",
  markets: "0112_markets",
  market_countries: "0112_markets",
  market_presences: "0112_markets",
  delivery_zone_regions: "0114_shipping_zones",
  tax_regions: "0116_tax_regions",
  places: "0118_places",
  price_lists: "0120_price_lists",
  price_list_prices: "0120_price_lists",
  store_languages: "0121_translations",
  translations: "0121_translations",
  localized_slugs: "0121_translations",
  sales_channels: "0122_sales_channels",
  product_channel_publications: "0122_sales_channels",
  sales_channel_locations: "0122_sales_channels",
  // A channel's sellable stock reads the levels at its unlinked locations.
  inventory_levels: "0122_sales_channels",
};
/**
 * Triggers added after their table's migration, by trigger name: the table's
 * own migration stays byte for byte (it is deployed), so a rule registered
 * later installs its trigger in the migration named here.
 */
export const CACHE_DEP_LATER_TRIGGERS: Readonly<Record<string, string>> = {
  // The set of countries the active markets sell to (`mk:selling`).
  cdep_markets_selling_upd: "0115_selling_countries_dependency",
  cdep_markets_selling_del: "0115_selling_countries_dependency",
  cdep_market_countries_selling_ins: "0115_selling_countries_dependency",
  cdep_market_countries_selling_del: "0115_selling_countries_dependency",
  cdep_market_countries_selling_upd: "0115_selling_countries_dependency",
  // Tax regions (0116) rebuild tax_rates (its triggers go with the old table)
  // and drop tax_settings.prices_include_tax (its update guard names it).
  cdep_tax_rates_ins: "0116_tax_regions",
  cdep_tax_rates_del: "0116_tax_regions",
  cdep_tax_rates_upd: "0116_tax_regions",
  cdep_tax_settings_upd: "0116_tax_regions",
  // The place directory (0118) rebuilds delivery_zone_locations onto places.
  cdep_delivery_zone_locations_ins: "0118_places",
  cdep_delivery_zone_locations_del: "0118_places",
  cdep_delivery_zone_locations_upd: "0118_places",
  // A market's pricing columns (0120) advance its `pl:` key.
  cdep_markets_pricing: "0120_price_lists",
  cdep_markets_pricing_old: "0120_price_lists",
  // A presence's locale decides which translations it reads (`tr:locales`, 0121).
  cdep_market_presences_locales_ins: "0121_translations",
  cdep_market_presences_locales_del: "0121_translations",
  cdep_market_presences_locales_upd: "0121_translations",
  // Sales channels (0122) drop products.exclude_from_product_feed (the feed
  // channels' publications replace it): the triggers that name it are
  // reinstalled without it. A channel's sellable stock reads its linked
  // locations, so raw stock moves a SKU's keys once a location is unlinked.
  cdep_products_upd: "0122_sales_channels",
  cdep_products_seo: "0122_sales_channels",
  cdep_product_variants_chstock: "0122_sales_channels",
  cdep_product_variants_chstock_old: "0122_sales_channels",
  // The price filter reads the product discount live (`lo:price`).
  cdep_products_price_order: "0122_sales_channels",
  cdep_products_price_order_old: "0122_sales_channels",
};

/**
 * Rules added to a baseline table after deployed 0100 (not reinstalled ones):
 * 0100 never had them, so its render leaves them out; the migration named in
 * `CACHE_DEP_LATER_TRIGGERS` installs them.
 */
export const CACHE_DEP_ADDED_BASELINE_TRIGGERS: ReadonlySet<string> = new Set([
  "cdep_product_variants_chstock",
  "cdep_product_variants_chstock_old",
  "cdep_products_price_order",
  "cdep_products_price_order_old",
]);

/**
 * Baseline tables whose columns changed after deployed 0100, with the
 * columns 0100 saw: 0100 renders their triggers over these (it is immutable),
 * and the migration that changed the columns reinstalls the triggers that
 * name them (`CACHE_DEP_LATER_TRIGGERS`).
 */
/**
 * Update rules whose `changed` list deployed 0100 rendered with a column a
 * later migration dropped (`<table>:<rule name>`): 0100 renders this list,
 * every later render the registry's.
 */
export const CACHE_DEP_BASELINE_CHANGED: Readonly<Record<string, readonly string[]>> = {
  "products:seo": ["no_index", "exclude_from_sitemap", "exclude_from_product_feed"],
};

export const CACHE_DEP_BASELINE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  products: [
    "id", "name", "description", "price_minor", "category_id", "slug", "meta_title", "meta_description",
    "canonical_path", "no_index", "exclude_from_sitemap", "exclude_from_product_feed", "product_condition",
    "aggregate_revision", "created_at", "updated_at", "deleted_at", "is_active", "discount_bps", "discount_type",
    "discount_amount_minor", "free_delivery", "tax_class_id", "tax_classification_version", "is_gift_card",
    "customization_schema", "brand_id", "page_template", "emi_eligible", "warranty_policy_id",
  ],
  tax_rates: [
    "id", "tax_class_id", "name", "rate_bps", "jurisdiction_type", "jurisdiction_id", "jurisdiction_label",
    "priority", "is_compound", "is_active", "version", "created_at", "updated_at", "deleted_at",
  ],
  tax_settings: [
    "id", "enabled", "prices_include_tax", "tax_shipping", "default_tax_class_id", "shipping_tax_class_id",
    "display_label", "version", "created_at", "updated_at",
  ],
};
const isBaselineTable = (table: string) => !PROJECTION_TABLES.has(table) && !(table in CACHE_DEP_LATER_TABLES);

export interface RetiredCacheDepTable {
  /** The registry table it followed, so deployed 0100 renders byte for byte. */
  readonly after: string;
  /** The migration that drops the table (and, on PostgreSQL, its trigger functions). */
  readonly droppedIn: string;
  /** Its columns as 0100 saw them (the table is gone from the schema). */
  readonly columns: readonly string[];
  readonly spec: CacheDepTableSpec;
}

/**
 * Tables deployed 0100 installed triggers for that the registry no longer
 * has. 0100 is immutable, so its renderer keeps each frozen spec at its old
 * registry position; the table's own migration drops it (SQLite drops its
 * triggers with it; the PostgreSQL sidecar also drops the trigger
 * functions, `retiredCacheDepFunctionDrops`).
 */
export const CACHE_DEP_RETIRED_TABLES: Readonly<Record<string, RetiredCacheDepTable>> = {
  // The place directory (`places`, 0118) replaces the Bangladesh-only table.
  delivery_locations: {
    after: "delivery_zone_regions",
    droppedIn: "0118_places",
    columns: [
      "id", "name", "type", "parent_id", "external_ids", "metadata", "is_active", "sort_order",
      "created_at", "updated_at", "deleted_at",
    ],
    spec: {
      kinds: ["loc" as CacheDepKind],
      noise: ["updated_at"],
      rules: [
        { name: "ins", event: "insert", image: "new", keys: [{ dep: "loc" }] },
        { name: "del", event: "delete", image: "old", keys: [{ dep: "loc" }] },
        { name: "upd", event: "update", image: "new", changed: "visible", keys: [{ dep: "loc" }] },
      ],
    },
  },
  // The homepage hero lives in the theme document's hero section now.
  hero_sliders: {
    after: "pages",
    droppedIn: "0106_theme_document_v6",
    columns: ["id", "type", "images", "is_active", "revision", "created_at", "updated_at", "deleted_at"],
    spec: {
      kinds: ["hero" as CacheDepKind],
      noise: ["revision", "updated_at"],
      rules: [
        { name: "ins", event: "insert", image: "new", keys: [{ dep: "hero" }] },
        { name: "del", event: "delete", image: "old", keys: [{ dep: "hero" }] },
        { name: "upd", event: "update", image: "new", changed: "visible", keys: [{ dep: "hero" }] },
      ],
    },
  },
};

const BREAKPOINT = "--> statement-breakpoint";

/** Trigger name prefix of every generated per-table trigger. */
export const CACHE_DEP_TRIGGER_PREFIX = "cdep_";
/** The two SQLite triggers that raise the clock (PostgreSQL raises it in the bump function). */
export const CACHE_DEP_CLOCK_TRIGGERS = ["cache_dep_clock_ins", "cache_dep_clock_upd"] as const;

const HEADER = `-- Dependency-validated cache, phase P0 (audit/rewrite-2026-09-23/CACHE-DESIGN.md
-- §6.2-6.4): a commit-ordered clock (cache_clock) and the clock value of each
-- dependency key's last buyer-visible change (cache_dep), kept by triggers in
-- the same transaction as every write, whatever wrote it. Nothing reads them
-- yet; the cache generation stays the freshness authority.
--
-- Generated by packages/database/scripts/cache-dep-triggers.ts from the
-- registry in packages/shared/src/cache-deps.ts (a test keeps this file equal
-- to that output). Every guard is in WHEN and every body is one statement.`;

const TABLES_SQLITE = [
  `CREATE TABLE \`cache_clock\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`seq\` integer DEFAULT 0 NOT NULL,
	\`floor\` integer DEFAULT 0 NOT NULL,
	\`coarse\` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cache_clock_singleton" CHECK("cache_clock"."id" = 1),
	CONSTRAINT "cache_clock_coarse_flag" CHECK("cache_clock"."coarse" IN (0, 1))
)`,
  "INSERT INTO `cache_clock` (`id`, `seq`, `floor`, `coarse`) VALUES (1, 0, 0, 0)",
  `CREATE TABLE \`cache_dep\` (
	\`dep\` text PRIMARY KEY NOT NULL,
	\`seq\` integer NOT NULL
) WITHOUT ROWID`,
  "CREATE INDEX `cache_dep_seq_idx` ON `cache_dep` (`seq`)",
];

const CLOCK_TRIGGERS_SQLITE = [
  `CREATE TRIGGER \`cache_dep_clock_ins\` AFTER INSERT ON \`cache_dep\`
WHEN NEW.\`seq\` > COALESCE((SELECT \`seq\` FROM \`cache_clock\` WHERE \`id\` = 1), 0)
BEGIN
  INSERT INTO \`cache_clock\` (\`id\`, \`seq\`) VALUES (1, NEW.\`seq\`) ON CONFLICT (\`id\`) DO UPDATE SET \`seq\` = excluded.\`seq\`;
END`,
  `CREATE TRIGGER \`cache_dep_clock_upd\` AFTER UPDATE OF \`seq\` ON \`cache_dep\`
WHEN NEW.\`seq\` > COALESCE((SELECT \`seq\` FROM \`cache_clock\` WHERE \`id\` = 1), 0)
BEGIN
  INSERT INTO \`cache_clock\` (\`id\`, \`seq\`) VALUES (1, NEW.\`seq\`) ON CONFLICT (\`id\`) DO UPDATE SET \`seq\` = excluded.\`seq\`;
END`,
];

/**
 * PostgreSQL: advance the clock (locking its row until commit) and give every
 * non-null key the new value; inside a coarse rebuild the keys become `store`.
 */
export const CACHE_DEP_POSTGRES_BUMP_FUNCTION = `CREATE OR REPLACE FUNCTION scalius_compat."cache_dep_bump"(dep_keys text[])
RETURNS void
LANGUAGE plpgsql
AS $cache_dep_bump$
DECLARE
  next_seq bigint;
  coarse_mode bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM unnest(dep_keys) AS key_value WHERE key_value IS NOT NULL) THEN
    RETURN;
  END IF;
  INSERT INTO "cache_clock" ("id", "seq") VALUES (1, 1)
  ON CONFLICT ("id") DO UPDATE SET "seq" = "cache_clock"."seq" + 1
  RETURNING "seq", "coarse" INTO next_seq, coarse_mode;
  IF coarse_mode = 1 THEN
    dep_keys := ARRAY['store'];
  END IF;
  INSERT INTO "cache_dep" ("dep", "seq")
  SELECT DISTINCT key_value, next_seq FROM unnest(dep_keys) AS key_value WHERE key_value IS NOT NULL
  ON CONFLICT ("dep") DO UPDATE SET "seq" = excluded."seq";
END
$cache_dep_bump$`;

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

interface Dialect {
  id(name: string): string;
  /** A list of text expressions as a row source (may reference sibling FROM items). */
  list(expressions: readonly string[], alias: string): { from: string; value: string };
  distinct: string;
}

const sqlite: Dialect = {
  id: (name) => `\`${name}\``,
  list: (expressions, alias) => ({
    from: `json_each(json_array(${expressions.join(", ")})) AS ${alias}`,
    value: `${alias}.value`,
  }),
  distinct: "IS NOT",
};

const postgres: Dialect = {
  id: (name) => `"${name}"`,
  list: (expressions, alias) => ({
    from: `unnest(ARRAY[${expressions.join(", ")}]::text[]) AS ${alias}(value)`,
    value: `${alias}.value`,
  }),
  distinct: "IS DISTINCT FROM",
};

const literal = (value: string | number) =>
  typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;

// ---------------------------------------------------------------------------
// Schema lookups
// ---------------------------------------------------------------------------

const tableColumns = new Map<string, string[]>();
for (const value of Object.values(schema)) {
  if (!value || typeof value !== "object") continue;
  try {
    const config = getTableConfig(value as SQLiteTable);
    if (config?.name) tableColumns.set(config.name, config.columns.map((column) => column.name));
  } catch {
    // Not a table (relations, enums, helpers).
  }
}

for (const [table, retired] of Object.entries(CACHE_DEP_RETIRED_TABLES)) {
  if (!tableColumns.has(table)) tableColumns.set(table, [...retired.columns]);
}

/** While rendering deployed 0100: the columns it saw (`CACHE_DEP_BASELINE_COLUMNS`). */
let renderingBaseline = false;

function columnsOf(table: string): string[] {
  const frozen = renderingBaseline ? CACHE_DEP_BASELINE_COLUMNS[table] : undefined;
  if (frozen) return [...frozen];
  const columns = tableColumns.get(table);
  if (!columns) throw new Error(`Cache dependency registry names unknown table ${table}.`);
  return columns;
}

function assertColumn(table: string, column: string): void {
  if (!columnsOf(table).includes(column)) {
    throw new Error(`Cache dependency registry names unknown column ${table}.${column}.`);
  }
}

function changedColumns(table: string, spec: CacheDepTableSpec, rule: CacheDepRule): string[] {
  if (rule.bandChanged) return [];
  if (rule.changed === undefined) return [];
  const columns = rule.changed === "visible"
    ? columnsOf(table).filter((column) => !spec.noise.includes(column))
    : renderingBaseline && CACHE_DEP_BASELINE_CHANGED[`${table}:${rule.name}`]
      ? [...CACHE_DEP_BASELINE_CHANGED[`${table}:${rule.name}`]!]
      : [...rule.changed];
  for (const column of columns) assertColumn(table, column);
  return columns;
}

/** Inputs of a SKU's buyer availability band (a change of anything else cannot move it). */
const BAND_INPUTS = ["stock", "reserved_stock", "track_inventory", "low_stock_threshold"] as const;

/**
 * The SKU's buyer availability band as a number (out 0, low 1, in 2,
 * untracked 3), the twin of `resolveBuyerAvailabilityBand` with the SKU's own
 * level, else the store default (`inventory` settings document).
 */
function bandSql(dialect: "sqlite" | "postgres", image: "OLD" | "NEW"): string {
  const d = dialect === "sqlite" ? sqlite : postgres;
  const col = (name: string) => `${image}.${d.id(name)}`;
  const available = `(${col("stock")} - ${col("reserved_stock")})`;
  const storeDefault = dialect === "sqlite"
    ? "(SELECT CAST(json_extract(`value`, '$.defaultLowStockThreshold') AS INTEGER) FROM `settings` WHERE `category` = 'inventory' AND `key` = 'document' AND json_valid(`value`))"
    : `(SELECT CAST(json_extract("value", '$.defaultLowStockThreshold') AS bigint) FROM "settings" WHERE "category" = 'inventory' AND "key" = 'document' AND json_valid("value"))`;
  const threshold = `COALESCE(${col("low_stock_threshold")}, ${storeDefault})`;
  if (dialect === "sqlite") {
    return `((${col("track_inventory")} = 0) * 3 + (${col("track_inventory")} <> 0) * (${available} > 0) * (1 + (COALESCE(${threshold}, 0) <= 0 OR ${available} > ${threshold})))`;
  }
  return `(CASE WHEN ${col("track_inventory")} = 0 THEN 3 WHEN ${available} <= 0 THEN 0 WHEN COALESCE(${threshold}, 0) > 0 AND ${available} <= ${threshold} THEN 1 ELSE 2 END)`;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

type ScopeTemplate = Extract<CacheDepKeyTemplate, { scopes: string }>;

function isScope(template: CacheDepKeyTemplate): template is ScopeTemplate {
  return "scopes" in template;
}

function keyExpression(table: string, template: CacheDepKeyTemplate, image: string, d: Dialect): string {
  if ("dep" in template) return literal(template.dep);
  if ("columns" in template) {
    for (const column of template.columns) assertColumn(table, column);
    return [literal(template.prefix), ...template.columns.map((column, index) =>
      `${index > 0 ? `':' || ` : ""}${image}.${d.id(column)}`)].join(" || ");
  }
  if ("lookup" in template) {
    const { lookup } = template;
    assertColumn(table, lookup.column);
    assertColumn(lookup.table, lookup.select);
    assertColumn(lookup.table, lookup.key);
    return `${literal(template.prefix)} || (SELECT ${d.id(lookup.select)} FROM ${d.id(lookup.table)} WHERE ${d.id(lookup.key)} = ${image}.${d.id(lookup.column)})`;
  }
  throw new Error("Scope templates are rendered separately.");
}

/**
 * The public scopes of the rule's product, as rows of `scope`: `all`,
 * `brand:<id>`, `cat:<id>` straight from the product's category, and
 * `cat:<ancestor>` for every ancestor in `category_closure`. The direct term
 * does not depend on the closure, so a closure gap can hide an ancestor
 * subtree's change but never the change of the product's own category.
 */
function scopesSql(template: ScopeTemplate, table: string, image: string, d: Dialect): string {
  const id = d.id;
  if ("row" in template.from) {
    const list = d.list(["'all'", `'brand:' || ${image}.${id("brand_id")}`, `'cat:' || ${image}.${id("category_id")}`], "scope_list");
    return `SELECT ${list.value} AS scope FROM ${list.from}`
      + ` UNION ALL SELECT 'cat:' || ${id("ancestor_id")} FROM ${id("category_closure")} WHERE ${id("descendant_id")} = ${image}.${id("category_id")}`;
  }
  assertColumn(table, template.from.product);
  const product = `${image}.${id(template.from.product)}`;
  const state = `${id("product_buyer_state")} AS scope_state`;
  const publicState = `scope_state.${id("product_id")} = ${product} AND scope_state.${id("is_public")} = 1`;
  const list = d.list(["'all'", `'brand:' || scope_state.${id("brand_id")}`, `'cat:' || scope_state.${id("category_id")}`], "scope_list");
  return `SELECT ${list.value} AS scope FROM ${state}, ${list.from} WHERE ${publicState}`
    + ` UNION ALL SELECT 'cat:' || scope_closure.${id("ancestor_id")} FROM ${state} JOIN ${id("category_closure")} AS scope_closure ON scope_closure.${id("descendant_id")} = scope_state.${id("category_id")} WHERE ${publicState}`;
}

/** Every key of the rule as rows of `dep` (NULL keys included; the caller drops them). */
function keysSql(table: string, rule: CacheDepRule, d: Dialect): string {
  const image = rule.image === "new" ? "NEW" : "OLD";
  const plain = rule.keys.filter((template) => !isScope(template) && !("rows" in template))
    .map((template) => keyExpression(table, template, image, d));
  plain.push(literal(`t:${table}`));
  const scoped = rule.keys.filter(isScope);
  const keyList = d.list(plain, "key_list");
  const parts = [`SELECT ${keyList.value} AS dep FROM ${keyList.from}`];
  rule.keys.forEach((template, index) => {
    if (!("rows" in template)) return;
    for (const match of template.rows.matchAll(/\bR\.([A-Za-z_][A-Za-z0-9_]*)/g)) assertColumn(table, match[1]!);
    const alias = `key_ref_${index}`;
    parts.push(`SELECT ${literal(template.prefix)} || ${alias}.ref FROM (${template.rows.replace(/\bR\./g, `${image}.`)}) AS ${alias}`);
  });
  if (scoped.length > 0) {
    const from = JSON.stringify(scoped[0]!.from);
    if (scoped.some((template) => JSON.stringify(template.from) !== from)) {
      throw new Error(`${table}.${rule.name}: every scope key of a rule must read the same product.`);
    }
    const facets = scoped.map((template) => literal(template.scopes));
    const facetList = d.list(facets, "facet_list");
    parts.push(`SELECT ${facetList.value} || ':' || scope_rows.scope FROM (${scopesSql(scoped[0]!, table, image, d)}) AS scope_rows, ${facetList.from}`);
  }
  return parts.join(" UNION ");
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

interface Guards {
  /** Plain column guards (no subquery): SQLite WHEN, PostgreSQL trigger WHEN. */
  simple: string[];
  /** Guards with a subquery: SQLite WHEN, PostgreSQL function body. */
  subquery: string[];
}

function guards(table: string, spec: CacheDepTableSpec, rule: CacheDepRule, dialect: "sqlite" | "postgres"): Guards {
  const d = dialect === "sqlite" ? sqlite : postgres;
  const image = rule.image === "new" ? "NEW" : "OLD";
  const simple: string[] = [];
  const subquery: string[] = [];
  const changed = changedColumns(table, spec, rule);
  // A companion whose key columns are all among the changed ones needs only
  // the narrower key-column test.
  const implied = rule.keyColumnsChanged !== undefined && rule.keyColumnsChanged.every((column) => changed.includes(column));
  if (rule.event === "update" && changed.length > 0 && !implied) {
    simple.push(`(${changed.map((column) => `OLD.${d.id(column)} ${d.distinct} NEW.${d.id(column)}`).join(" OR ")})`);
  }
  if (rule.keyColumnsChanged !== undefined) {
    // An old-image companion fires only when the old image derives other keys.
    if (rule.event !== "update" || rule.image !== "old" || rule.keyColumnsChanged.length === 0) {
      throw new Error(`${table}.${rule.name}: a companion is an old-image update rule with key columns.`);
    }
    for (const column of rule.keyColumnsChanged) assertColumn(table, column);
    simple.push(`(${rule.keyColumnsChanged.map((column) => `OLD.${d.id(column)} ${d.distinct} NEW.${d.id(column)}`).join(" OR ")})`);
  }
  if (rule.bandChanged) {
    if (rule.event !== "update") throw new Error(`${table}.${rule.name}: a band rule is an update rule.`);
    for (const column of BAND_INPUTS) assertColumn(table, column);
    simple.push(`(${BAND_INPUTS.map((column) => `OLD.${d.id(column)} ${d.distinct} NEW.${d.id(column)}`).join(" OR ")})`);
    subquery.push(`${bandSql(dialect, "OLD")} <> ${bandSql(dialect, "NEW")}`);
  }
  for (const [column, value] of Object.entries(rule.where?.equals ?? {})) {
    assertColumn(table, column);
    simple.push(`${image}.${d.id(column)} = ${literal(value)}`);
  }
  if (rule.where?.exists) subquery.push(`EXISTS (${rule.where.exists.replace(/\bR\./g, `${image}.`)})`);
  if (rule.event === "update" && changed.length === 0 && !rule.bandChanged) {
    throw new Error(`${table}.${rule.name}: an update rule needs changed columns or a band test.`);
  }
  return { simple, subquery };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export interface GeneratedCacheDepTrigger {
  name: string;
  table: string;
  event: "insert" | "update" | "delete";
  sqlite: string;
  postgres: string;
}

function triggerName(table: string, rule: CacheDepRule): string {
  return `${CACHE_DEP_TRIGGER_PREFIX}${table}_${rule.name}`;
}

function sqliteTrigger(table: string, spec: CacheDepTableSpec, rule: CacheDepRule): string {
  const d = sqlite;
  const { simple, subquery } = guards(table, spec, rule, "sqlite");
  const when = [...simple, ...subquery];
  // COALESCE: a store whose clock row is missing (a partial data import)
  // still accepts writes; the clock trigger recreates the row.
  const clock = (column: string) => `COALESCE((SELECT ${d.id(column)} FROM ${d.id("cache_clock")} WHERE ${d.id("id")} = 1), 0)`;
  return [
    `CREATE TRIGGER ${d.id(triggerName(table, rule))} AFTER ${rule.event.toUpperCase()} ON ${d.id(table)}`,
    ...(when.length > 0 ? [`WHEN ${when.join("\n  AND ")}`] : []),
    "BEGIN",
    `  INSERT INTO ${d.id("cache_dep")} (${d.id("dep")}, ${d.id("seq")})`,
    `  SELECT key_rows.dep, ${clock("seq")} + 1 FROM (${keysSql(table, rule, d)}) AS key_rows`,
    `  WHERE key_rows.dep IS NOT NULL AND ${clock("coarse")} = 0`,
    `  UNION ALL SELECT 'store', ${clock("seq")} + 1 WHERE ${clock("coarse")} = 1`,
    `  ON CONFLICT (${d.id("dep")}) DO UPDATE SET ${d.id("seq")} = excluded.${d.id("seq")};`,
    "END",
  ].join("\n");
}

function postgresTrigger(table: string, spec: CacheDepTableSpec, rule: CacheDepRule): string {
  const d = postgres;
  const name = triggerName(table, rule);
  const { simple, subquery } = guards(table, spec, rule, "postgres");
  const guard = subquery.length > 0
    ? `  IF NOT coalesce((${subquery.join(" AND ")}), false) THEN\n    RETURN NULL;\n  END IF;\n`
    : "";
  return [
    `CREATE OR REPLACE FUNCTION scalius_compat.${d.id(`${name}_fn`)}()`,
    "RETURNS trigger",
    "LANGUAGE plpgsql",
    "AS $trigger_function$",
    "BEGIN",
    `${guard}  PERFORM scalius_compat."cache_dep_bump"(ARRAY(${keysSql(table, rule, d)}));`,
    "  RETURN NULL;",
    "END",
    "$trigger_function$;",
    `CREATE CONSTRAINT TRIGGER ${d.id(name)}`,
    `AFTER ${rule.event.toUpperCase()} ON ${d.id(table)}`,
    "DEFERRABLE INITIALLY DEFERRED",
    "FOR EACH ROW",
    ...(simple.length > 0 ? [`WHEN (${simple.join(" AND ")})`] : []),
    `EXECUTE FUNCTION scalius_compat.${d.id(`${name}_fn`)}()`,
  ].join("\n");
}

/** The registry's tables in order, each retired table at its old position when asked for. */
function registryTables(withRetired: boolean): Array<[string, CacheDepTableSpec]> {
  const tables: Array<[string, CacheDepTableSpec]> = [];
  for (const [table, spec] of Object.entries(CACHE_DEP_TABLES) as Array<[string, CacheDepTableSpec]>) {
    tables.push([table, spec]);
    if (!withRetired) continue;
    for (const [retired, frozen] of Object.entries(CACHE_DEP_RETIRED_TABLES)) {
      if (frozen.after === table) tables.push([retired, frozen.spec]);
    }
  }
  return tables;
}

/** Every per-table trigger, in registry order (with `withRetired`, deployed 0100's retired tables too). */
export function generateCacheDepTriggers(options: { withRetired?: boolean } = {}): GeneratedCacheDepTrigger[] {
  const triggers: GeneratedCacheDepTrigger[] = [];
  const names = new Set<string>();
  for (const [table, spec] of registryTables(options.withRetired === true)) {
    columnsOf(table);
    for (const column of spec.noise) assertColumn(table, column);
    for (const rule of spec.rules) {
      const name = triggerName(table, rule);
      if (names.has(name)) throw new Error(`Duplicate cache dependency trigger ${name}.`);
      names.add(name);
      if ((rule.event === "insert" && rule.image !== "new") || (rule.event === "delete" && rule.image !== "old")) {
        throw new Error(`${name}: insert rules read the new row and delete rules the old one.`);
      }
      triggers.push({
        name,
        table,
        event: rule.event,
        sqlite: sqliteTrigger(table, spec, rule),
        postgres: postgresTrigger(table, spec, rule),
      });
    }
  }
  return triggers;
}

const generated = generateCacheDepTriggers();
const generatedWithRetired = generateCacheDepTriggers({ withRetired: true });
/** Deployed 0100's triggers: with its retired tables and the columns it saw. */
const generatedBaseline = (() => {
  renderingBaseline = true;
  try {
    return generateCacheDepTriggers({ withRetired: true });
  } finally {
    renderingBaseline = false;
  }
})();
const postgresByName = new Map(generatedWithRetired.map((trigger) => [trigger.name, trigger.postgres]));
const baselineByName = new Map(generatedBaseline
  .filter((trigger) => trigger.table in CACHE_DEP_BASELINE_COLUMNS)
  .map((trigger) => [trigger.name, trigger]));

/** The trigger names a retired table's drop removes (its SQLite triggers go with the table). */
export function retiredCacheDepTriggerNames(migration?: string): string[] {
  return generatedWithRetired
    .filter((trigger) => trigger.table in CACHE_DEP_RETIRED_TABLES
      && (migration === undefined || CACHE_DEP_RETIRED_TABLES[trigger.table]!.droppedIn === migration))
    .map((trigger) => trigger.name);
}

/** PostgreSQL statements dropping the trigger functions of the tables `migration` drops. */
export function retiredCacheDepFunctionDrops(migration: string): string[] {
  return retiredCacheDepTriggerNames(migration)
    .map((name) => `DROP FUNCTION IF EXISTS scalius_compat.${postgres.id(`${name}_fn`)}()`);
}

/**
 * The PostgreSQL form of a generated SQLite trigger, for the canonical
 * PostgreSQL schema compiler: a string for a per-table trigger, `null` for
 * the SQLite-only clock triggers, `undefined` for any other trigger.
 */
export function cacheDepPostgresTrigger(name: string, installedSqlite?: string): string | null | undefined {
  if ((CACHE_DEP_CLOCK_TRIGGERS as readonly string[]).includes(name)) return null;
  // A schema compiled before the migration that changed a baseline table's
  // columns still holds 0100's trigger: its PostgreSQL form names those columns.
  const baseline = baselineByName.get(name);
  if (baseline && installedSqlite !== undefined && installedSqlite.trim() === baseline.sqlite) return `${baseline.postgres};`;
  const postgresSql = postgresByName.get(name);
  return postgresSql === undefined ? undefined : `${postgresSql};`;
}

// ---------------------------------------------------------------------------
// Migration files
// ---------------------------------------------------------------------------

function sourceSha256(statements: readonly string[]): string {
  return createHash("sha256").update(`${statements.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
}

/** Both migration files, byte for byte. */
export function renderCacheDepMigration(): { sqlite: string; postgres: string } {
  const baseline = generatedBaseline.filter((trigger) =>
    isBaselineTable(trigger.table) && !CACHE_DEP_ADDED_BASELINE_TRIGGERS.has(trigger.name));
  const sqliteBody = [...TABLES_SQLITE, ...CLOCK_TRIGGERS_SQLITE, ...baseline.map((trigger) => trigger.sqlite)];
  const sqliteStatements = sqliteBody.map((statement, index) => `${index === 0 ? `${HEADER}\n` : ""}${statement};`);
  const sha = sourceSha256(sqliteStatements);
  const { version, name } = CACHE_DEP_MIGRATION;
  const sqliteFile = [
    ...sqliteStatements,
    `INSERT INTO \`scalius_schema_migrations\` (\`version\`, \`name\`, \`source_sha256\`) VALUES (${version}, '${name}', '${sha}');`,
  ].join(`\n${BREAKPOINT}\n`) + "\n";
  const postgresBody = [
    ...TABLES_SQLITE.map((statement) => compileSqliteDdlForPostgres(statement)),
    CACHE_DEP_POSTGRES_BUMP_FUNCTION,
    ...baseline.map((trigger) => trigger.postgres),
  ];
  const postgresFile = [
    ...postgresBody.map((statement, index) => `${index === 0 ? `${HEADER}\n` : ""}${statement};`),
    `INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (${version}, '${name}', '${sha}');`,
  ].join(`\n${BREAKPOINT}\n`) + "\n";
  return { sqlite: sqliteFile, postgres: postgresFile };
}

export const CACHE_DEP_MIGRATION_PATHS = {
  sqlite: fileURLToPath(new URL(`../migrations/${CACHE_DEP_MIGRATION.name}.sql`, import.meta.url)),
  postgres: fileURLToPath(new URL(`../migrations/postgres/${CACHE_DEP_MIGRATION.name}.sql`, import.meta.url)),
};

/** Only new rules: existing tables, clock and 0100 trigger text stay intact. */
export function renderCacheDepProjectionMigration(): { sqlite: string; postgres: string } {
  const additions = generated.filter((trigger) => PROJECTION_TABLES.has(trigger.table));
  const header = "-- Keyed recommendation/sales projections and private live-ranking signals.\n-- Generated by packages/database/scripts/cache-dep-triggers.ts; additive to deployed 0100.";
  const statements = additions.map((trigger, index) => `${index === 0 ? `${header}\n` : ""}${trigger.sqlite};`);
  const sha = sourceSha256(statements);
  const { version, name } = CACHE_DEP_PROJECTION_MIGRATION;
  return {
    sqlite: [...statements, `INSERT INTO \`scalius_schema_migrations\` (\`version\`, \`name\`, \`source_sha256\`) VALUES (${version}, '${name}', '${sha}');`].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [...additions.map((trigger, index) => `${index === 0 ? `${header}\n` : ""}${trigger.postgres};`),
      `INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (${version}, '${name}', '${sha}');`].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}
/** The generated triggers a later migration (by name) installs, in registry order. */
export function cacheDepTriggersForMigration(name: string): GeneratedCacheDepTrigger[] {
  return generated.filter((trigger) =>
    (CACHE_DEP_LATER_TRIGGERS[trigger.name] ?? CACHE_DEP_LATER_TABLES[trigger.table]) === name);
}

export const CACHE_DEP_PROJECTION_MIGRATION_PATHS = {
  sqlite: fileURLToPath(new URL(`../migrations/${CACHE_DEP_PROJECTION_MIGRATION.name}.sql`, import.meta.url)),
  postgres: fileURLToPath(new URL(`../migrations/postgres/${CACHE_DEP_PROJECTION_MIGRATION.name}.sql`, import.meta.url)),
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!process.argv.includes("--write")) {
    console.error("Usage: tsx scripts/cache-dep-triggers.ts --write");
    process.exit(1);
  }
  const rendered = renderCacheDepProjectionMigration();
  writeFileSync(CACHE_DEP_PROJECTION_MIGRATION_PATHS.sqlite, rendered.sqlite);
  writeFileSync(CACHE_DEP_PROJECTION_MIGRATION_PATHS.postgres, rendered.postgres);
  console.log(`Wrote ${CACHE_DEP_PROJECTION_MIGRATION.name} (D1/Turso and PostgreSQL).`);
}
