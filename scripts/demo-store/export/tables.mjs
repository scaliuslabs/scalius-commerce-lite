/**
 * The portable demo-store seed contract.
 *
 * A seed bundle is the catalog a fresh deployment needs in order to look like
 * the demo store, and nothing else. The allow-list below is the whole contract:
 * the exporter reads these fifteen tables in this exact order and never opens
 * any other table for export. Orders, customers, users, sessions, accounts,
 * settings, discounts, promotions, inventory ledgers, checkout state and the
 * FTS shadow tables are therefore unreachable by construction rather than by a
 * filter someone has to remember to keep current.
 *
 * The order is a dependency order: every foreign key an exported row carries
 * points at a table that appears earlier in the list (or at the same table, in
 * the case of `media.poster_media_id`). `seed.sql` emits its inserts in this
 * order so that a loader without deferred foreign keys still sees parents
 * before children.
 */

/** Bundle format identity, the sibling of `scalius-d1-migration-plan/v1`. */
export const DEMO_STORE_SEED_CONTRACT = "scalius-demo-store-seed/v1";

export const BUNDLE_MANIFEST_FILENAME = "bundle.json";
export const SEED_SQL_FILENAME = "seed.sql";
export const MEDIA_MANIFEST_FILENAME = "media-manifest.json";
export const MEDIA_DIRECTORY_NAME = "media";

/**
 * Every entry this exporter owns inside an export directory. Re-running an
 * export into the same directory is expected; clobbering anything else is not,
 * so an output directory that holds any other entry is refused.
 */
export const BUNDLE_ENTRIES = Object.freeze([
  BUNDLE_MANIFEST_FILENAME,
  SEED_SQL_FILENAME,
  MEDIA_MANIFEST_FILENAME,
  MEDIA_DIRECTORY_NAME,
]);

/** Provider-neutral release ledger every migration from 0050 onward writes. */
export const SCHEMA_LEDGER_TABLE = "scalius_schema_migrations";

/** The complete catalog allow-list, in dependency order. */
export const EXPORTED_TABLES = Object.freeze([
  "media_folders",
  "media",
  "categories",
  "collections",
  "product_attributes",
  "products",
  "product_media",
  "product_option_definitions",
  "product_option_values",
  "product_variants",
  "product_variant_option_values",
  "product_attribute_values",
  "product_rich_content",
  "hero_sections",
  "hero_sliders",
]);

/**
 * Extra row filters beyond the generic `deleted_at IS NULL` rule. `media` keeps
 * a lifecycle column of its own, and `product_media_insert_ready_guard` aborts
 * any insert whose asset is not `ready`, so a seed that carried a trashed asset
 * could never be loaded.
 */
export const EXPORT_ROW_FILTERS = Object.freeze({
  media: "\"status\" = 'ready'",
});

/**
 * Live commerce state that must never ride along in a portable seed. Each probe
 * names the table, how to describe one of its rows to an operator, and which of
 * its columns reach into the exported catalog.
 */
export const COMMERCE_ENTANGLEMENT_PROBES = Object.freeze([
  Object.freeze({
    table: "order_items",
    label: "order line",
    identitySql: "\"id\"",
    variantColumn: "variant_id",
    productColumn: "product_id",
  }),
]);
