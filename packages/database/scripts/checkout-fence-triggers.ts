/**
 * The checkout fence triggers (migration 0199), generated for D1/Turso and
 * PostgreSQL. Migration 0199 and its PostgreSQL sidecar contain every
 * generated statement verbatim (`__tests__/checkout-fences.test.ts`).
 *
 * A checkout reads the fence rows of the scopes it priced against (its
 * products, the settings documents it decided with, and the store-wide
 * shipping, tax and markets scopes) and its commit batch refuses when their
 * revisions moved. Each trigger advances exactly one scope per changed row,
 * so a staff edit of one product, a push-token registration or an analytics
 * setting never refuses another buyer's checkout, and no write serializes on
 * a store-wide row.
 *
 * Deliberately not fenced:
 * - stock, reservations, licence keys and location stock: the commit batch
 *   reserves them itself;
 * - images (`media`, `product_media`): an order line's picture is not priced;
 * - staff push tokens: whether an order notifies staff is the notifications
 *   document's channels, not a device being registered;
 * - a product's insert: a cart read refuses an unknown product, so no commit
 *   can depend on one that did not exist.
 *
 * The bodies are one statement without CASE (remote D1 rule); the guards are
 * the WHEN clauses. An update whose key column can change advances the old and
 * the new scope (`UNION`/`DISTINCT`: PostgreSQL's upsert must not touch a row twice).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSqliteTriggerForPostgres } from "./postgres-schema";
import {
  CHECKOUT_FENCE_PRODUCT_PREFIX,
  CHECKOUT_FENCE_SETTINGS_PREFIX,
  type CheckoutFenceStoreScope,
} from "../src/schema/system";

export const CHECKOUT_FENCE_MIGRATION = "0199_checkout_fences";
const CHECKOUT_FENCE_VERSION = 199;
const BREAKPOINT = "--> statement-breakpoint";

/** `settings.key` of a settings document's row (`SETTINGS_DOCUMENT_ROW_KEY` in core). */
export const SETTINGS_DOCUMENT_KEY = "document";

type Event = "insert" | "update" | "delete";
type Row = "NEW" | "OLD";

/** Where a changed row's scope comes from. */
type ScopeSource =
  | { kind: "store"; scope: CheckoutFenceStoreScope }
  /** `prefix || <row>.<column>` of the changed row itself. */
  | { kind: "column"; prefix: string; column: string }
  /** `prefix || <lookup>.<column>` of the row the changed row references. */
  | { kind: "lookup"; prefix: string; table: string; column: string; key: string; reference: string };

interface FenceTable {
  table: string;
  source: ScopeSource;
  events: readonly Event[];
  /** `UPDATE OF` columns. */
  updateOf?: readonly string[];
  /** Columns whose change advances the scope on update (none listed: every update). */
  changed?: readonly string[];
  /** A guard on the row (`NEW`/`OLD` substituted for the event's row). */
  guard?: (row: Row) => string;
  /** The update guard, when it is not `guard` on either row. */
  updateGuard?: string;
}

const product = (column: string): ScopeSource => ({ kind: "column", prefix: CHECKOUT_FENCE_PRODUCT_PREFIX, column });
const productOf = (table: string, key: string, reference: string): ScopeSource => ({
  kind: "lookup", prefix: CHECKOUT_FENCE_PRODUCT_PREFIX, table, column: "product_id", key, reference,
});
const store = (scope: CheckoutFenceStoreScope): ScopeSource => ({ kind: "store", scope });
const ALL: readonly Event[] = ["insert", "update", "delete"];
const activePriceList = (row: Row) =>
  `EXISTS (SELECT 1 FROM \`price_lists\` WHERE \`price_lists\`.\`id\` = ${row}.\`price_list_id\` AND \`price_lists\`.\`status\` = 'active')`;

/** Every fact a checkout prices or decides against, by scope. */
export const CHECKOUT_FENCE_TABLES: readonly FenceTable[] = [
  // ── A product (the cart's lines) ───────────────────────────────────────────
  {
    table: "products",
    source: product("id"),
    events: ["update", "delete"],
    changed: [
      "name", "price_minor", "category_id", "deleted_at", "is_active", "discount_bps", "discount_type",
      "discount_amount_minor", "free_delivery", "shipping_profile_id", "tax_class_id",
      "tax_classification_version", "is_gift_card", "customization_schema",
    ],
  },
  {
    table: "product_variants",
    source: product("product_id"),
    events: ALL,
    // Stock and reservations are the commit's own reservation guards.
    changed: [
      "product_id", "option_combination_key", "image_id", "price_minor", "weight", "is_default",
      "track_inventory", "allow_preorder", "allow_backorder", "backorder_limit", "tax_class_id",
      "tax_classification_version", "discount_bps", "discount_type", "discount_amount_minor",
      "deleted_at", "fulfillment_kind",
    ],
  },
  {
    table: "product_bundles",
    source: product("product_id"),
    events: ALL,
    changed: ["product_id", "quantity", "discount_type", "discount_bps", "price_minor", "is_active"],
  },
  {
    table: "product_channel_publications",
    source: product("product_id"),
    // A publication only adds availability, which the cart read already refused without it.
    events: ["update", "delete"],
    updateOf: ["unpublished_at", "channel_id", "product_id"],
    guard: (row) => `${row}.\`unpublished_at\` IS NULL`,
    updateGuard: "OLD.`unpublished_at` IS NULL AND (NEW.`unpublished_at` IS NOT NULL OR NEW.`channel_id` IS NOT OLD.`channel_id` OR NEW.`product_id` IS NOT OLD.`product_id`)",
  },
  {
    table: "product_option_definitions",
    source: product("product_id"),
    events: ALL,
    changed: ["product_id", "name", "normalized_name", "position", "standard_mapping", "deleted_at"],
  },
  {
    table: "product_option_values",
    source: productOf("product_option_definitions", "id", "option_definition_id"),
    events: ALL,
    // Swatches are pictures, not the SKU's label.
    changed: ["option_definition_id", "value", "normalized_value", "position", "deleted_at"],
  },
  {
    table: "product_variant_option_values",
    source: productOf("product_variants", "id", "variant_id"),
    events: ALL,
  },
  {
    table: "price_list_prices",
    source: productOf("product_variants", "id", "variant_id"),
    events: ALL,
    guard: activePriceList,
    updateGuard: "EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` IN (NEW.`price_list_id`, OLD.`price_list_id`) AND `price_lists`.`status` = 'active')",
  },
  // ── A settings document ─────────────────────────────────────────────────────
  {
    table: "settings",
    source: { kind: "column", prefix: CHECKOUT_FENCE_SETTINGS_PREFIX, column: "category" },
    events: ALL,
    changed: ["key", "value", "type", "category", "expires_at"],
    guard: (row) => `${row}.\`key\` = '${SETTINGS_DOCUMENT_KEY}'`,
    updateGuard: `(NEW.\`key\` = '${SETTINGS_DOCUMENT_KEY}' OR OLD.\`key\` = '${SETTINGS_DOCUMENT_KEY}')`,
  },
  // ── Delivery: rates, zones, places and shipping profiles ────────────────────
  ...["shipping_methods", "delivery_zones", "delivery_zone_regions", "delivery_zone_locations", "shipping_profiles", "shipping_profile_rates"]
    .map((table): FenceTable => ({ table, source: store("shipping"), events: ALL })),
  {
    table: "places",
    source: store("shipping"),
    events: ALL,
    changed: ["name", "parent_id", "level", "country_code", "is_active", "deleted_at"],
  },
  // ── Tax: rates, regions, classes, settings and the origin location ──────────
  ...["tax_classes", "tax_rates", "tax_regions", "tax_settings"]
    .map((table): FenceTable => ({ table, source: store("tax"), events: ALL })),
  {
    // The default active location's country taxes an order with no address.
    table: "inventory_locations",
    source: store("tax"),
    events: ALL,
    changed: ["country_code", "is_default", "status"],
    guard: (row) => `${row}.\`is_default\` = 1`,
    updateGuard: "(NEW.`is_default` = 1 OR OLD.`is_default` = 1)",
  },
  // ── Market pricing: markets, their countries, price lists, channels ─
  // Not presences: checkout takes the shipping country's market, never the page's.
  {
    table: "markets",
    source: store("markets"),
    events: ["update"],
    changed: [
      "status", "is_backup", "price_increment_minor", "prices_include_tax", "price_mode", "fx_rate",
      "price_adjustment_bps", "price_rounding_minor", "price_ending_minor", "currency_code", "fx_lock_minutes",
    ],
  },
  {
    table: "market_countries",
    source: store("markets"),
    events: ALL,
    changed: ["market_id", "country_code"],
  },
  {
    table: "price_lists",
    source: store("markets"),
    events: ALL,
    guard: (row) => `${row}.\`status\` = 'active'`,
    updateGuard: "(OLD.`status` = 'active' OR NEW.`status` = 'active') AND (NEW.`status` IS NOT OLD.`status` OR NEW.`kind` IS NOT OLD.`kind` OR NEW.`market_id` IS NOT OLD.`market_id` OR NEW.`segment_id` IS NOT OLD.`segment_id` OR NEW.`starts_at` IS NOT OLD.`starts_at` OR NEW.`ends_at` IS NOT OLD.`ends_at` OR NEW.`priority` IS NOT OLD.`priority`)",
  },
  {
    table: "sales_channels",
    source: store("markets"),
    events: ["update"],
    updateOf: ["status"],
    changed: ["status"],
  },
];

const quote = (identifier: string) => `\`${identifier}\``;
const UPSERT = "ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1";
const INSERT = "INSERT INTO `checkout_fences` (`scope`, `revision`)";

function scopeKeyChanges(source: ScopeSource, entry: FenceTable): boolean {
  if (source.kind === "store") return false;
  const column = source.kind === "column" ? source.column : source.reference;
  // A key column outside the changed list never changes (an id); settings and SKUs can move.
  return !entry.changed || entry.changed.includes(column);
}

function body(entry: FenceTable, event: Event): string {
  const { source } = entry;
  const rows: Row[] = event === "insert" ? ["NEW"] : event === "delete" ? ["OLD"] : scopeKeyChanges(source, entry) ? ["NEW", "OLD"] : ["NEW"];
  if (source.kind === "store") return `${INSERT} VALUES ('${source.scope}', 1) ${UPSERT};`;
  if (source.kind === "column") {
    const expression = (row: Row) => `'${source.prefix}' || ${row}.${quote(source.column)}`;
    if (rows.length === 1) return `${INSERT} VALUES (${expression(rows[0]!)}, 1) ${UPSERT};`;
    return `${INSERT} SELECT \`fence_scope\`.\`scope\`, 1 FROM (SELECT ${expression("NEW")} AS \`scope\` UNION SELECT ${expression("OLD")}) AS \`fence_scope\` WHERE \`fence_scope\`.\`scope\` IS NOT NULL ${UPSERT};`;
  }
  const keys = rows.map((row) => `${row}.${quote(source.reference)}`).join(", ");
  const match = rows.length === 1 ? `= ${keys}` : `IN (${keys})`;
  return `${INSERT} SELECT DISTINCT '${source.prefix}' || \`fence_source\`.${quote(source.column)}, 1 FROM ${quote(source.table)} AS \`fence_source\` WHERE \`fence_source\`.${quote(source.key)} ${match} ${UPSERT};`;
}

function when(entry: FenceTable, event: Event): string | null {
  if (event === "update") {
    const guard = entry.updateGuard ?? (entry.guard ? `(${entry.guard("NEW")} OR ${entry.guard("OLD")})` : null);
    const changed = entry.changed?.map((column) => `NEW.${quote(column)} IS NOT OLD.${quote(column)}`).join(" OR ");
    const parts = [guard, changed && (guard ? `(${changed})` : changed)].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" AND ") : null;
  }
  return entry.guard?.(event === "insert" ? "NEW" : "OLD") ?? null;
}

export interface CheckoutFenceTrigger {
  name: string;
  table: string;
  sqlite: string;
}

export function generateCheckoutFenceTriggers(): CheckoutFenceTrigger[] {
  return CHECKOUT_FENCE_TABLES.flatMap((entry) => entry.events.map((event): CheckoutFenceTrigger => {
    const name = `${entry.table}_checkout_fence_${event}`;
    const guard = when(entry, event);
    const of = event === "update" && entry.updateOf ? ` OF ${entry.updateOf.map(quote).join(", ")}` : "";
    return {
      name,
      table: entry.table,
      sqlite: [
        `CREATE TRIGGER ${quote(name)}`,
        `AFTER ${event.toUpperCase()}${of} ON ${quote(entry.table)}`,
        ...(guard ? [`WHEN ${guard}`] : []),
        "BEGIN",
        `  ${body(entry, event)}`,
        "END",
      ].join("\n"),
    };
  }));
}

/**
 * The store-wide revision's triggers (0048 to 0188) that 0199 drops with
 * `checkout_authority`, by table.
 */
export const CHECKOUT_AUTHORITY_TRIGGERS: Readonly<Record<string, readonly Event[]>> = {
  admin_fcm_tokens: ALL,
  delivery_zone_locations: ALL,
  delivery_zone_regions: ALL,
  delivery_zones: ALL,
  market_countries: ALL,
  markets: ["update"],
  media: ["update"],
  places: ALL,
  price_list_prices: ALL,
  price_lists: ALL,
  product_bundles: ALL,
  product_channel_publications: ["update", "delete"],
  product_media: ALL,
  product_option_definitions: ALL,
  product_option_values: ALL,
  product_variant_option_values: ALL,
  product_variants: ALL,
  products: ALL,
  sales_channels: ["update"],
  settings: ALL,
  shipping_methods: ALL,
  tax_classes: ALL,
  tax_rates: ALL,
  tax_regions: ALL,
  tax_settings: ALL,
};

function droppedAuthorityTriggers(): Array<{ name: string; table: string }> {
  return Object.entries(CHECKOUT_AUTHORITY_TRIGGERS).flatMap(([table, events]) =>
    events.map((event) => ({ name: `${table}_checkout_authority_${event}`, table })));
}

const SQLITE_TABLE = [
  "CREATE TABLE `checkout_fences` (",
  "\t`scope` text PRIMARY KEY NOT NULL,",
  "\t`revision` integer DEFAULT 1 NOT NULL,",
  "\tCONSTRAINT \"checkout_fences_revision_positive\" CHECK(\"checkout_fences\".\"revision\" >= 1)",
  ");",
].join("\n");

const POSTGRES_TABLE = [
  "CREATE TABLE \"checkout_fences\" (",
  "\t\"scope\" text COLLATE \"C\" PRIMARY KEY NOT NULL,",
  "\t\"revision\" bigint DEFAULT 1 NOT NULL,",
  "\tCONSTRAINT \"checkout_fences_revision_positive\" CHECK(\"checkout_fences\".\"revision\" >= 1)",
  ");",
].join("\n");

/** 0199's statements before its ledger row, D1/Turso. */
export function checkoutFenceSqliteStatements(): string[] {
  return [
    ...droppedAuthorityTriggers().map(({ name }) => `DROP TRIGGER IF EXISTS ${quote(name)};`),
    "DROP TABLE `checkout_authority`;",
    SQLITE_TABLE,
    ...generateCheckoutFenceTriggers().map((trigger) => `${trigger.sqlite};`),
  ];
}

/** 0199's statements before its ledger row, PostgreSQL. */
export function checkoutFencePostgresStatements(): string[] {
  return [
    ...droppedAuthorityTriggers().map(({ name, table }) =>
      `DROP TRIGGER IF EXISTS "${name}" ON "${table}";\nDROP FUNCTION IF EXISTS scalius_compat."${name}_fn"();`),
    "DROP TABLE \"checkout_authority\";",
    POSTGRES_TABLE,
    ...generateCheckoutFenceTriggers().map((trigger) =>
      compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
  ];
}

const HEADER = [
  "-- The checkout fence (scripts/checkout-fence-triggers.ts; regenerate with --write).",
  "-- checkout_authority was one store-wide revision that about 70 triggers",
  "-- advanced, so any staff save (a push token, an analytics setting, another",
  "-- product's price) sent every in-flight checkout back to its cart, and every",
  "-- write serialized on that row. Each change now advances only its own scope:",
  "-- the product, the settings document, or shipping, tax or markets. A checkout",
  "-- reads the scopes it priced against and its commit refuses only when one of",
  "-- them moved. A scope with no row is revision 0. Not buyer-visible.",
];

/** The migration and its PostgreSQL sidecar, ledger row included. */
export function renderCheckoutFenceMigration() {
  const [firstSqlite, ...sqlite] = checkoutFenceSqliteStatements();
  const body = [`${HEADER.join("\n")}\n${firstSqlite}`, ...sqlite];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (${CHECKOUT_FENCE_VERSION}, '${CHECKOUT_FENCE_MIGRATION}', '${digest}');`;
  const [firstPostgres, ...postgres] = checkoutFencePostgresStatements();
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [`-- The checkout fence: see ../${CHECKOUT_FENCE_MIGRATION}.sql.\n${firstPostgres}`, ...postgres, ledger]
      .join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const result = renderCheckoutFenceMigration();
  writeFileSync(new URL(`../migrations/${CHECKOUT_FENCE_MIGRATION}.sql`, import.meta.url), result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${CHECKOUT_FENCE_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  const entry = `  {\n    version: ${CHECKOUT_FENCE_VERSION},\n    name: "${CHECKOUT_FENCE_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  let contract = readFileSync(contractPath, "utf8")
    .replace(/version: 198,\n {2}name: "0198_order_event_app_actor"/, `version: ${CHECKOUT_FENCE_VERSION},\n  name: "${CHECKOUT_FENCE_MIGRATION}"`);
  contract = contract.includes(`version: ${CHECKOUT_FENCE_VERSION},\n    name:`)
    ? contract.replace(new RegExp(` {2}\\{\\n {4}version: ${CHECKOUT_FENCE_VERSION},[\\s\\S]*?\\n {2}\\},\\n`), entry)
    : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${CHECKOUT_FENCE_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
