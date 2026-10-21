// Exact public facet counts per category and per brand (migration 0174,
// `product_facet_scope_counts`): the triggers that keep them and their
// backfill. A scope is a product's own category (`category`, its
// `category_id`) or brand (`brand`, its `brand_id`); a category subtree's
// counts are the sum of its published categories' rows. While a product is
// public (`product_buyer_state.is_public`) it counts once in each of its
// scopes for:
//
// - every distinct facet value of its facet rows (`attribute`, `option`);
// - the scope's products (`products`, key and value '');
// - the other scope (`brand` in its category, `category` in its brand);
// - its whole-star rating (`rating`, '0'-'5', floor of the review average)
//   while it has a published review.
//
// A facet value's row also keeps a sample: one public product of the scope
// that has the value (`sample_product_id`), whose row gives the value's
// label, order and option axis on the listing. It stays until that product
// stops counting there, and is then replaced by the scope's next product with
// the value, so a product outside the scope never presents its values.
//
// Each trigger body is one INSERT ... SELECT ... ON CONFLICT statement with
// its guard in WHEN (remote D1 rejects a CASE in a trigger body), forming
// the new count before the upsert so the CHECK never sees a negative value.
// A trigger only adds or only removes, so its sample rule needs no CASE: an
// update that does both is two triggers.
import { facetScopeCountsSelect } from "../src/derived-projections";

const BREAKPOINT = "--> statement-breakpoint";
const KEYS = ["scope_kind", "scope_id", "facet_kind", "facet_key", "value_key"] as const;

/** A facet row the facet table accepts (BEFORE triggers also run for a row SQLite then rejects). */
function validFacet(ref: string): string {
  return `${ref}.owner_id IS NOT NULL AND ${ref}.product_id IS NOT NULL AND ${ref}.sort_order IS NOT NULL
    AND ${ref}.owner_id = coalesce(${ref}.variant_id, ${ref}.product_id)
    AND ((${ref}.facet_kind = 'attribute' AND ${ref}.variant_id IS NULL)
      OR (${ref}.facet_kind = 'option' AND ${ref}.variant_id IS NOT NULL AND substr(${ref}.facet_key, 1, 7) = 'option.'))
    AND length(${ref}.facet_key) BETWEEN 1 AND 120 AND length(${ref}.value_key) BETWEEN 1 AND 200
    AND length(${ref}.value_label) BETWEEN 1 AND 200`;
}

/** The public scopes of a product's buyer row `b` (a category and a brand, when set). */
function scopesOf(buyer: string): string {
  return `SELECT 'category' AS scope_kind, ${buyer}.category_id AS scope_id WHERE ${buyer}.category_id IS NOT NULL
      UNION ALL SELECT 'brand', ${buyer}.brand_id WHERE ${buyer}.brand_id IS NOT NULL`;
}

/** The public scopes of the product `product` names: its category and its brand, each when set. */
function publicScopesOf(product: string): string {
  return `SELECT 'category' AS scope_kind, scope_buyer.category_id AS scope_id FROM product_buyer_state scope_buyer
      WHERE scope_buyer.product_id = ${product} AND scope_buyer.is_public = 1 AND scope_buyer.category_id IS NOT NULL
      UNION ALL SELECT 'brand', scope_buyer.brand_id FROM product_buyer_state scope_buyer
      WHERE scope_buyer.product_id = ${product} AND scope_buyer.is_public = 1 AND scope_buyer.brand_id IS NOT NULL`;
}

/** One facet row's change: its value counts in the product's scopes unless a sibling row of the product holds it too. */
function facetDelta(ref: "OLD" | "NEW", delta: number, excludeOld: boolean): string {
  return `SELECT scope.scope_kind, scope.scope_id, ${ref}.facet_kind AS facet_kind, ${ref}.facet_key AS facet_key, ${ref}.value_key AS value_key, ${delta} AS delta
    FROM (${publicScopesOf(`${ref}.product_id`)}) scope
    WHERE NOT EXISTS (
      SELECT 1 FROM product_facet_values sibling WHERE sibling.product_id = ${ref}.product_id
      AND sibling.facet_kind = ${ref}.facet_kind AND sibling.facet_key = ${ref}.facet_key AND sibling.value_key = ${ref}.value_key${excludeOld ? " AND (sibling.owner_id != OLD.owner_id OR sibling.facet_key != OLD.facet_key)" : ""})`;
}

/** Everything a public buyer row `ref` counts in its scopes. */
function buyerDelta(ref: "OLD" | "NEW", delta: number): string {
  return `SELECT scope.scope_kind, scope.scope_id, item.facet_kind, item.facet_key, item.value_key, ${delta} AS delta
    FROM (${scopesOf(ref)}) scope CROSS JOIN (
      SELECT DISTINCT facet.facet_kind AS facet_kind, facet.facet_key AS facet_key, facet.value_key AS value_key
        FROM product_facet_values facet WHERE facet.product_id = ${ref}.product_id
      UNION ALL SELECT 'products', '', ''
      UNION ALL SELECT 'brand', 'brand', ${ref}.brand_id WHERE ${ref}.brand_id IS NOT NULL
      UNION ALL SELECT 'category', 'category', ${ref}.category_id WHERE ${ref}.category_id IS NOT NULL
      UNION ALL SELECT 'rating', 'rating', CAST(CAST(stats.rating_avg_centi / 100 AS INTEGER) AS TEXT)
        FROM product_review_stats stats WHERE stats.product_id = ${ref}.product_id AND stats.rating_avg_centi IS NOT NULL
    ) item
    WHERE ${ref}.is_public = 1 AND item.facet_kind != scope.scope_kind`;
}

/** A review-stat row's rating bucket in its public product's scopes. */
function ratingDelta(ref: "OLD" | "NEW", delta: number): string {
  return `SELECT scope.scope_kind, scope.scope_id, 'rating' AS facet_kind, 'rating' AS facet_key,
      CAST(CAST(${ref}.rating_avg_centi / 100 AS INTEGER) AS TEXT) AS value_key, ${delta} AS delta
    FROM (${publicScopesOf(`${ref}.product_id`)}) scope
    WHERE ${ref}.rating_avg_centi IS NOT NULL`;
}

/**
 * Applies the deltas of one product (`product`, a NEW/OLD reference) to the
 * counts. `sample`: "add" keeps a row's sample, or makes the product its
 * first; "remove" replaces the sample when it is the product leaving, with
 * the scope's smallest other product of the value (the value index's own
 * order, stopping at the first in the scope); "remove-moved" is that after
 * the product's buyer row changed (AFTER UPDATE): its new row decides whether
 * it still belongs there, so it is not excluded. null leaves samples alone.
 */
function applyDelta(source: string, sample: "add" | "remove" | "remove-moved" | null, product: string): string {
  const match = KEYS.map((key) => `c.${key} = d.${key}`).join(" AND ");
  const current = `(SELECT c.sample_product_id FROM product_facet_scope_counts c WHERE ${match})`;
  const next = `(SELECT sample_row.product_id FROM product_facet_values sample_row
        JOIN product_buyer_state sample_buyer ON sample_buyer.product_id = sample_row.product_id AND sample_buyer.is_public = 1
          AND ((d.scope_kind = 'category' AND sample_buyer.category_id = d.scope_id) OR (d.scope_kind = 'brand' AND sample_buyer.brand_id = d.scope_id))
        WHERE sample_row.facet_kind = d.facet_kind AND sample_row.facet_key = d.facet_key AND sample_row.value_key = d.value_key
          ${sample === "remove" ? `AND sample_row.product_id != ${product}` : ""}
        ORDER BY sample_row.product_id LIMIT 1)`;
  const sampleValue = sample === "add" ? `coalesce(${current}, ${product})`
    : sample === "remove" || sample === "remove-moved" ? `coalesce(nullif(${current}, ${product}), ${next})`
    : current;
  return `INSERT INTO product_facet_scope_counts (${KEYS.join(", ")}, product_count, sample_product_id)
    SELECT ${KEYS.map((key) => `d.${key}`).join(", ")},
      coalesce((SELECT c.product_count FROM product_facet_scope_counts c WHERE ${match}), 0) + sum(d.delta),
      ${sampleValue}
    FROM (${source}) d GROUP BY ${KEYS.map((key) => `d.${key}`).join(", ")} HAVING sum(d.delta) != 0
    ON CONFLICT (${KEYS.join(", ")}) DO UPDATE SET product_count = excluded.product_count, sample_product_id = excluded.sample_product_id`;
}

export function generateFacetScopeCountsTriggers(): Array<{ name: string; sqlite: string }> {
  const trigger = (name: string, timing: string, event: string, table: string, source: string, guard: string | undefined,
    sample: "add" | "remove" | "remove-moved" | null, product: string) => ({
    name,
    sqlite: `CREATE TRIGGER ${name}\n${timing} ${event} ON ${table}${guard ? `\nWHEN ${guard}` : ""}\nBEGIN\n  ${applyDelta(source, sample, product)};\nEND`,
  });
  const groupChanged = ["product_id", "facet_kind", "facet_key", "value_key"].map((key) => `OLD.${key} IS NOT NEW.${key}`).join(" OR ");
  const bucket = (ref: string) => `CAST(${ref}.rating_avg_centi / 100 AS INTEGER)`;
  const facetUpdate = `(${groupChanged}) AND ${validFacet("NEW")} AND NOT EXISTS (SELECT 1 FROM product_facet_values f
        WHERE f.owner_id = NEW.owner_id AND f.facet_key = NEW.facet_key
        AND (f.owner_id != OLD.owner_id OR f.facet_key != OLD.facet_key))`;
  const buyerUpdate = "OLD.is_public IS NOT NEW.is_public OR OLD.product_id IS NOT NEW.product_id OR OLD.category_id IS NOT NEW.category_id OR OLD.brand_id IS NOT NEW.brand_id";
  return [
    trigger("facet_scope_counts_insert", "BEFORE", "INSERT", "product_facet_values", facetDelta("NEW", 1, false),
      `${validFacet("NEW")} AND NOT EXISTS (SELECT 1 FROM product_facet_values f WHERE f.owner_id = NEW.owner_id AND f.facet_key = NEW.facet_key)`,
      "add", "NEW.product_id"),
    trigger("facet_scope_counts_delete", "BEFORE", "DELETE", "product_facet_values", facetDelta("OLD", -1, true), undefined,
      "remove", "OLD.product_id"),
    trigger("facet_scope_counts_update_remove", "BEFORE", "UPDATE", "product_facet_values", facetDelta("OLD", -1, true), facetUpdate,
      "remove", "OLD.product_id"),
    trigger("facet_scope_counts_update_add", "BEFORE", "UPDATE", "product_facet_values", facetDelta("NEW", 1, true), facetUpdate,
      "add", "NEW.product_id"),
    // AFTER: an ignored or conflicting buyer insert counts nothing. DELETE
    // accounts before the FK cascade removes the product's facet rows.
    trigger("facet_scope_counts_buyer_insert", "AFTER", "INSERT", "product_buyer_state", buyerDelta("NEW", 1), "NEW.is_public = 1",
      "add", "NEW.product_id"),
    trigger("facet_scope_counts_buyer_delete", "BEFORE", "DELETE", "product_buyer_state", buyerDelta("OLD", -1), "OLD.is_public = 1",
      "remove", "OLD.product_id"),
    trigger("facet_scope_counts_buyer_update_remove", "AFTER", "UPDATE", "product_buyer_state", buyerDelta("OLD", -1), buyerUpdate,
      "remove-moved", "OLD.product_id"),
    trigger("facet_scope_counts_buyer_update_add", "AFTER", "UPDATE", "product_buyer_state", buyerDelta("NEW", 1), buyerUpdate,
      "add", "NEW.product_id"),
    // A rating bucket has no sample.
    trigger("facet_scope_counts_rating_insert", "AFTER", "INSERT", "product_review_stats", ratingDelta("NEW", 1),
      "NEW.rating_avg_centi IS NOT NULL", null, "NEW.product_id"),
    trigger("facet_scope_counts_rating_delete", "BEFORE", "DELETE", "product_review_stats", ratingDelta("OLD", -1),
      "OLD.rating_avg_centi IS NOT NULL", null, "OLD.product_id"),
    trigger("facet_scope_counts_rating_update", "AFTER", "UPDATE", "product_review_stats",
      `${ratingDelta("OLD", -1)} UNION ALL ${ratingDelta("NEW", 1)}`,
      `OLD.product_id IS NOT NEW.product_id OR ${bucket("OLD")} IS NOT ${bucket("NEW")}`, null, "NEW.product_id"),
  ];
}

export const facetScopeCountsBackfill = `INSERT INTO product_facet_scope_counts (${KEYS.join(", ")}, product_count, sample_product_id)
${facetScopeCountsSelect};`;

export { BREAKPOINT as FACET_SCOPE_COUNTS_BREAKPOINT };
