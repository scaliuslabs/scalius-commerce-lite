// The store's shape for theme fit rules (`@scalius/shared/storefront-theme`
// fit.ts): a few bounded counts plus the header menu tree. Every count reads
// at most STORE_SHAPE_COUNT_CAP rows, so a 50,000-SKU catalogue costs the
// same as a 1,000-SKU one, and the whole read is one statement that joins
// the layout batch (no extra D1 round trip).
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  STORE_SHAPE_COUNT_CAP,
  storeShapeFromFacts,
  type StoreShape,
  type StoreShapeMenuItem,
} from "@scalius/shared/storefront-theme";
import { getPublishedNavigationPlacements } from "../navigation/navigation.authority.service";
import { SETTINGS_DOCUMENT_ROW_KEY } from "../settings/settings-store";

const cap = STORE_SHAPE_COUNT_CAP;

/**
 * One row of capped counts; add it to a batch or run it alone. Column names
 * are written qualified by hand: drizzle renders a column reference inside a
 * raw subquery unqualified, which is ambiguous across the SKU join.
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
      topCategoryCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "categories" c
        WHERE c."deleted_at" IS NULL AND c."status" = 'published'
        LIMIT ${cap}
      ) AS capped_categories)`,
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
      // Reviews show only when the reviews document is enabled (a missing or
      // malformed document reads as disabled) and one review is published.
      publishedReviewCount: sql<number>`(SELECT count(*) FROM (
        SELECT 1 FROM "settings" s
        WHERE s."key" = ${SETTINGS_DOCUMENT_ROW_KEY} AND s."category" = 'reviews'
          AND (CASE WHEN json_valid(s."value") THEN json_type(s."value", '$.enabled') END) = 'true'
          AND EXISTS (SELECT 1 FROM "product_reviews" r WHERE r."status" = 'published')
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

export interface StoreShapeCountsRow {
  productCount: number | string | bigint;
  skuCount: number | string | bigint;
  topCategoryCount: number | string | bigint;
  collectionCount: number | string | bigint;
  deliveryMethodCount: number | string | bigint;
  publishedReviewCount?: number | string | bigint;
  digitalSkuCount?: number | string | bigint;
}

/** The shape from the counts row and the header menu tree. */
export function storeShapeFromCounts(
  row: StoreShapeCountsRow | undefined,
  menu: readonly StoreShapeMenuItem[],
): StoreShape {
  const number = (value: number | string | bigint | undefined) => Number(value ?? 0) || 0;
  const topCategoryCount = number(row?.topCategoryCount);
  return storeShapeFromFacts({
    productCount: number(row?.productCount),
    skuCount: number(row?.skuCount),
    topCategoryCount,
    // Categories are flat until the category tree lands.
    categoryDepth: topCategoryCount > 0 ? 1 : 0,
    menu,
    hasCollections: number(row?.collectionCount) > 0,
    hasDeliveryMethods: number(row?.deliveryMethodCount) > 0,
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
