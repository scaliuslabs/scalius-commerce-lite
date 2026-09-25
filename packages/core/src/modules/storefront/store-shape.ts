// The store's shape for theme fit rules (`@scalius/shared/storefront-theme`
// fit.ts): a few bounded facts plus the header menu tree. The whole read is
// one statement that joins the layout batch (no extra D1 round trip), and
// every part is bounded: counts read at most STORE_SHAPE_COUNT_CAP rows,
// existence checks stop at the first match through an index, and the tree
// facts walk the categories table (a store's category list, not its
// products) once each.
//
// Category facts count what a buyer can reach, from the same authorities the
// storefront lists with: a category is public when it is published and live
// (and, for the tree, every ancestor too: `category_closure`), and a product
// is public when `product_buyer_state.is_public` says so.
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  STORE_SHAPE_COUNT_CAP,
  storeShapeFromFacts,
  type StoreShape,
  type StoreShapeMenuItem,
} from "@scalius/shared/storefront-theme";
import { getPublishedNavigationPlacements } from "../navigation/navigation.authority.service";
import { reviewsEnabledSql } from "../settings/documents";

const cap = STORE_SHAPE_COUNT_CAP;

/** The category (aliased) is published and live. */
const published = (alias: string) => sql.raw(`${alias}."status" = 'published' AND ${alias}."deleted_at" IS NULL`);

/** No ancestor of the category (aliased) is draft, internal or trashed. */
const everyAncestorPublished = (alias: string) => sql.raw(`NOT EXISTS (
  SELECT 1 FROM "category_closure" lineage
  INNER JOIN "categories" lineage_category ON lineage_category."id" = lineage."ancestor_id"
  WHERE lineage."descendant_id" = ${alias}."id"
    AND lineage."depth" > 0
    AND (lineage_category."status" <> 'published' OR lineage_category."deleted_at" IS NOT NULL)
)`);

/** The category (aliased) holds a public product of its own. */
const holdsPublicProduct = (alias: string) => sql.raw(`EXISTS (
  SELECT 1 FROM "product_buyer_state" own_product
  WHERE own_product."is_public" = 1 AND own_product."category_id" = ${alias}."id"
)`);

/**
 * One row of bounded facts; add it to a batch or run it alone. Column names
 * are written qualified by hand: drizzle renders a column reference inside a
 * raw subquery unqualified, which is ambiguous across the joins.
 */
export function selectStoreShapeCounts(db: Database) {
  return db
    .select({
      productCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "products" p
        WHERE p."deleted_at" IS NULL AND p."is_active" = 1
        LIMIT ${cap}
      ) AS capped_products)`,
      skuCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "product_variants" v
        INNER JOIN "products" p ON p."id" = v."product_id"
        WHERE v."deleted_at" IS NULL AND p."deleted_at" IS NULL AND p."is_active" = 1
        LIMIT ${cap}
      ) AS capped_skus)`,
      // Published roots with a public product in their published subtree
      // (the listing's own subtree rule, publicCategorySubtreeCondition). The
      // product check is its own EXISTS per subtree node so the planner walks
      // the closure first and probes (is_public, category_id) per node; a
      // join lets SQLite drive from every public product instead.
      topCategoryCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "categories" root
        WHERE root."parent_id" IS NULL AND ${published("root")}
          AND EXISTS (
            SELECT 1 FROM "category_closure" subtree
            INNER JOIN "categories" subtree_category ON subtree_category."id" = subtree."descendant_id"
            WHERE subtree."ancestor_id" = root."id" AND ${published("subtree_category")}
              AND ${holdsPublicProduct("subtree_category")}
          )
        LIMIT ${cap}
      ) AS capped_roots)`,
      // 1 + the deepest level (0-3) where a reachable category holds a
      // public product; 0 when none does.
      categoryDepth: sql<number>`(SELECT coalesce(max(reached."depth") + 1, 0) FROM "categories" reached
        WHERE ${published("reached")} AND ${everyAncestorPublished("reached")} AND ${holdsPublicProduct("reached")})`,
      // The most reachable second-level categories with two or more
      // reachable children under one root.
      categoryGroups: sql<number>`(SELECT coalesce(max(group_count.group_size), 0) FROM (
        SELECT count(*) AS group_size FROM "categories" branch
        WHERE branch."depth" = 1 AND ${published("branch")} AND ${everyAncestorPublished("branch")}
          AND (SELECT count(*) FROM (
            SELECT 1 FROM "categories" leaf
            WHERE leaf."parent_id" = branch."id" AND ${published("leaf")}
            LIMIT 2
          ) AS two_children) = 2
        GROUP BY branch."parent_id"
      ) AS group_count)`,
      brandCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "brands" brand
        WHERE brand."status" = 'published' AND brand."deleted_at" IS NULL
          AND EXISTS (
            SELECT 1 FROM "product_buyer_state" brand_product
            WHERE brand_product."is_public" = 1 AND brand_product."brand_id" = brand."id"
          )
        LIMIT ${cap}
      ) AS capped_brands)`,
      keySpecCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "product_attributes" spec
        WHERE spec."key_spec" = 1 AND spec."deleted_at" IS NULL
          AND EXISTS (
            SELECT 1 FROM "product_attribute_values" spec_value
            INNER JOIN "product_buyer_state" spec_product
              ON spec_product."product_id" = spec_value."product_id" AND spec_product."is_public" = 1
            WHERE spec_value."attribute_id" = spec."id"
          )
        LIMIT 1
      ) AS capped_key_specs)`,
      collectionCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "collections" c
        WHERE c."deleted_at" IS NULL AND c."is_active" = 1
        LIMIT 1
      ) AS capped_collections)`,
      deliveryMethodCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "shipping_methods" m
        WHERE m."deleted_at" IS NULL AND m."is_active" = 1
        LIMIT 1
      ) AS capped_shipping_methods)`,
      // Reviews show only when reviews are on (no document = the default,
      // on; a malformed one reads as off) and one review is published.
      publishedReviewCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "product_review_stats" rs0
        WHERE rs0."rating_rank_milli" IS NOT NULL AND ${reviewsEnabledSql()} = 1
        LIMIT 1
      ) AS capped_reviews)`,
      digitalSkuCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "product_variants" v
        INNER JOIN "products" p ON p."id" = v."product_id"
        WHERE v."fulfillment_kind" = 'digital' AND v."deleted_at" IS NULL
          AND p."deleted_at" IS NULL AND p."is_active" = 1
        LIMIT 1
      ) AS capped_digital_skus)`,
    })
    .from(sql`(SELECT 1 AS one) AS store_shape_row`);
}

type Counted = number | string | bigint;

export interface StoreShapeCountsRow {
  productCount: Counted;
  skuCount: Counted;
  topCategoryCount: Counted;
  categoryDepth: Counted;
  categoryGroups: Counted;
  brandCount: Counted;
  keySpecCount: Counted;
  collectionCount: Counted;
  deliveryMethodCount: Counted;
  publishedReviewCount?: Counted;
  digitalSkuCount?: Counted;
}

/** The shape from the counts row and the header menu tree. */
export function storeShapeFromCounts(
  row: StoreShapeCountsRow | undefined,
  menu: readonly StoreShapeMenuItem[],
): StoreShape {
  const number = (value: Counted | undefined) => Number(value ?? 0) || 0;
  return storeShapeFromFacts({
    productCount: number(row?.productCount),
    skuCount: number(row?.skuCount),
    topCategoryCount: number(row?.topCategoryCount),
    categoryDepth: number(row?.categoryDepth),
    categoryGroups: number(row?.categoryGroups),
    menu,
    brandCount: number(row?.brandCount),
    hasCollections: number(row?.collectionCount) > 0,
    hasDeliveryMethods: number(row?.deliveryMethodCount) > 0,
    hasKeySpecs: number(row?.keySpecCount) > 0,
    hasReviews: number(row?.publishedReviewCount) > 0,
    hasDigitalLines: number(row?.digitalSkuCount) > 0,
  });
}

/**
 * Read the shape on its own, with the published header menu (the
 * dashboard's theme read). The storefront gets the same shape from the
 * layout read, built from the same counts and the same menu.
 */
export async function readStoreShape(db: Database): Promise<StoreShape> {
  const [[row], placements] = await Promise.all([
    selectStoreShapeCounts(db),
    // A corrupt menu placement reads as no menu, as it does on the storefront.
    getPublishedNavigationPlacements(db).catch(() => []),
  ]);
  const header = placements.find((placement) => placement.surface === "header" && placement.slot === "primary");
  return storeShapeFromCounts(row as StoreShapeCountsRow | undefined, (header?.items ?? []) as StoreShapeMenuItem[]);
}
