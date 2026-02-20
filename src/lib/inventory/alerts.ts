// src/lib/inventory/alerts.ts
// Low-stock alert creation and management.
// Called after stock deductions to check if any variant has dropped below threshold.

import { eq, and, sql } from "drizzle-orm";
import { productVariants, productLowStockAlerts } from "@/db/schema";
import type { Database } from "@/db";

/**
 * Check if a variant's available stock has dropped below its threshold.
 * Creates or updates a low-stock alert record accordingly.
 * Resolves existing alerts when stock is replenished above threshold.
 *
 * Available stock = stock - reservedStock
 */
export async function checkAndAlertLowStock(
  db: Database,
  variantId: string
): Promise<void> {
  const variant = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      lowStockThreshold: productVariants.lowStockThreshold,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .get();

  if (!variant || variant.lowStockThreshold === null || variant.lowStockThreshold <= 0) {
    // No threshold configured — nothing to do
    return;
  }

  const available = variant.stock - variant.reservedStock;
  const isLow = available <= variant.lowStockThreshold;

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
  }
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
