// src/lib/inventory/alerts.ts
// Low-stock alert creation and management.
// Called after stock deductions to check if any variant has dropped below threshold.

import { eq, and, sql } from "drizzle-orm";
import { productVariants, productLowStockAlerts } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

/**
 * Result of a low-stock check, for observability.
 */
export interface LowStockAlertResult {
  /** Whether stock is currently below threshold */
  isLow: boolean;
  /** Whether a NEW alert was created (first time below threshold) */
  alertCreated: boolean;
  /** Whether a previously resolved alert was re-activated */
  alertReactivated: boolean;
  /** Whether an existing alert was resolved (stock replenished) */
  alertResolved: boolean;
  /** Current available stock (stock - reservedStock) */
  availableStock: number;
  /** The threshold that triggered/resolved the alert */
  threshold: number;
  /** The variant ID checked */
  variantId: string;
  /** The product ID (for notification routing) */
  productId: string;
}

/**
 * Check if a variant's available stock has dropped below its threshold.
 * Creates or updates a low-stock alert record accordingly.
 * Resolves existing alerts when stock is replenished above threshold.
 *
 * Returns a result indicating what happened, so callers (e.g. payment
 * processing) can trigger notifications when a new alert is created.
 *
 * Available stock = stock - reservedStock
 */
export async function checkAndAlertLowStock(
  db: Database,
  variantId: string
): Promise<LowStockAlertResult | null> {
  const variant = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      lowStockThreshold: productVariants.lowStockThreshold,
      trackInventory: productVariants.trackInventory,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .get();

  if (!variant || !variant.trackInventory || variant.lowStockThreshold === null || variant.lowStockThreshold <= 0) {
    // No threshold configured — nothing to do
    return null;
  }

  const available = variant.stock - variant.reservedStock;
  const isLow = available <= variant.lowStockThreshold;

  const result: LowStockAlertResult = {
    isLow,
    alertCreated: false,
    alertReactivated: false,
    alertResolved: false,
    availableStock: available,
    threshold: variant.lowStockThreshold,
    variantId,
    productId: variant.productId,
  };

  // Find existing alert for this variant
  const existingAlert = await db
    .select({
      id: productLowStockAlerts.id,
      alertStatus: productLowStockAlerts.alertStatus,
    })
    .from(productLowStockAlerts)
    .where(eq(productLowStockAlerts.variantId, variantId))
    .get();

  if (isLow) {
    const now = new Date();

    if (!existingAlert) {
      // Create new alert
      await db.insert(productLowStockAlerts).values({
        id: crypto.randomUUID(),
        variantId,
        productId: variant.productId,
        currentQty: available,
        threshold: variant.lowStockThreshold,
        alertStatus: "active",
        alertSentAt: now,
        createdAt: now,
        updatedAt: now,
      });
      result.alertCreated = true;
    } else if (existingAlert.alertStatus === "resolved") {
      // Re-activate a previously resolved alert
      await db
        .update(productLowStockAlerts)
        .set({
          currentQty: available,
          threshold: variant.lowStockThreshold,
          alertStatus: "active",
          alertSentAt: now,
          acknowledgedAt: null,
          resolvedAt: null,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(productLowStockAlerts.variantId, variantId));
      result.alertReactivated = true;
    } else {
      // Already active or acknowledged — just update currentQty
      await db
        .update(productLowStockAlerts)
        .set({
          currentQty: available,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(productLowStockAlerts.variantId, variantId));
    }
  } else if (existingAlert && existingAlert.alertStatus !== "resolved") {
    // Stock is back above threshold — resolve the alert
    await db
      .update(productLowStockAlerts)
      .set({
        currentQty: available,
        alertStatus: "resolved",
        resolvedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(productLowStockAlerts.variantId, variantId));
    result.alertResolved = true;
  }

  return result;
}

/**
 * Acknowledge a low-stock alert (admin has seen it).
 */
export async function acknowledgeLowStockAlert(
  db: Database,
  variantId: string
): Promise<void> {
  await db
    .update(productLowStockAlerts)
    .set({
      alertStatus: "acknowledged",
      acknowledgedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(productLowStockAlerts.variantId, variantId),
        eq(productLowStockAlerts.alertStatus, "active")
      )
    );
}
