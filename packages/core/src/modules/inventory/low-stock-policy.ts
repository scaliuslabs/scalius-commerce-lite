import { z } from "zod";
import { productVariants, settings } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import { defineSettingsDocument, SETTINGS_DOCUMENT_ROW_KEY } from "../settings/settings-store";
import { lowStockThresholdSchema } from "./inventory.validation";

/** A null or non-positive threshold explicitly disables low-stock alerts. */
export function isLowStockThresholdEnabled(
  threshold: number | null | undefined,
): threshold is number {
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0;
}

/**
 * The store-wide alert level (Shopify's default low-stock level). A SKU with
 * no level of its own uses it; a SKU level of 0 turns alerts off for that SKU.
 */
export const inventorySettingsDocument = defineSettingsDocument<{ defaultLowStockThreshold: number | null }>({
  key: "inventory",
  schema: z.object({ defaultLowStockThreshold: lowStockThresholdSchema }),
  defaults: { defaultLowStockThreshold: null },
});

/** The saved store default as a scalar subquery, so a read carries it without an extra statement. */
export function storeDefaultLowStockThresholdSql(): SQL<number | null> {
  return sql<number | null>`(
    SELECT CASE WHEN json_valid(${settings.value})
      THEN CAST(json_extract(${settings.value}, '$.defaultLowStockThreshold') AS INTEGER) END
    FROM ${settings}
    WHERE ${settings.category} = ${inventorySettingsDocument.key} AND ${settings.key} = ${SETTINGS_DOCUMENT_ROW_KEY}
  )`;
}

/**
 * The alert level that applies to a SKU: its own level, else the store
 * default. Every reader (low-stock list, alerts and the buyer availability
 * band) resolves it the same way, in the same statement.
 */
export function effectiveLowStockThresholdSql(): SQL<number | null> {
  return sql<number | null>`COALESCE(${productVariants.lowStockThreshold}, ${storeDefaultLowStockThresholdSql()})`;
}

const availableSql = sql`(${productVariants.stock} - ${productVariants.reservedStock})`;

/**
 * Dashboard "low" inventory: in stock, at or under the alert level that
 * applies. Sold-out SKUs have their own status.
 */
export function buildInventoryLowStockCondition(): SQL {
  const threshold = effectiveLowStockThresholdSql();
  return sql`(${availableSql} > 0 AND ${availableSql} <= ${threshold})`;
}

/**
 * A tracked SKU needs the merchant's attention: sold out, or at or under the
 * alert level that applies.
 */
export function buildNeedsRestockCondition(): SQL {
  return sql`(${availableSql} <= COALESCE(${effectiveLowStockThresholdSql()}, 0))`;
}
