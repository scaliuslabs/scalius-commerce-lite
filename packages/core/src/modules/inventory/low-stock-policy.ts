import { productVariants } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";

/** A null or non-positive threshold explicitly disables low-stock alerts. */
export function isLowStockThresholdEnabled(
  threshold: number | null | undefined,
): threshold is number {
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0;
}

/**
 * Dashboard "low" inventory excludes out-of-stock SKUs, which have their own
 * status, and only applies to variants with an explicitly enabled threshold.
 */
export function buildInventoryLowStockCondition(): SQL {
  return sql`(
    ${productVariants.lowStockThreshold} IS NOT NULL
    AND ${productVariants.lowStockThreshold} > 0
    AND (${productVariants.stock} - ${productVariants.reservedStock}) > 0
    AND (${productVariants.stock} - ${productVariants.reservedStock}) <= ${productVariants.lowStockThreshold}
  )`;
}
