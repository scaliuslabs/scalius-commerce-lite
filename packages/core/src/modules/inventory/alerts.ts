// src/lib/inventory/alerts.ts
// Low-stock alert creation and management.
// Called after stock deductions to check if any variant has dropped below threshold.

import { eq, and, ne, isNull, sql } from "drizzle-orm";
import { productVariants, productLowStockAlerts } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { effectiveLowStockThresholdSql, inventorySettingsDocument, isLowStockThresholdEnabled } from "./low-stock-policy";
import { lowStockThresholdSchema } from "./inventory.validation";
import { operationalSkuRowPredicate } from "../products/products.public-eligibility";

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

async function resolveInactiveLowStockAlert(
  db: Database,
  variantId: string,
  currentQty?: number,
): Promise<void> {
  await db
    .update(productLowStockAlerts)
    .set({
      ...(currentQty === undefined ? {} : { currentQty }),
      alertStatus: "resolved",
      resolvedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(productLowStockAlerts.variantId, variantId),
      ne(productLowStockAlerts.alertStatus, "resolved"),
    ));
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
      lowStockThreshold: effectiveLowStockThresholdSql(),
      trackInventory: productVariants.trackInventory,
    })
    .from(productVariants)
    .where(and(
      eq(productVariants.id, variantId),
      operationalSkuRowPredicate(),
    ))
    .get();

  if (!variant) {
    await resolveInactiveLowStockAlert(db, variantId);
    return null;
  }

  const available = variant.stock - variant.reservedStock;
  // A sold-out SKU always needs review; the alert level that applies (its own,
  // else the store default) also flags low stock.
  const threshold = isLowStockThresholdEnabled(variant.lowStockThreshold)
    ? variant.lowStockThreshold
    : 0;
  if (!variant.trackInventory || (threshold === 0 && available > 0)) {
    await resolveInactiveLowStockAlert(db, variantId, available);
    return null;
  }

  const isLow = available <= threshold;

  const result: LowStockAlertResult = {
    isLow,
    alertCreated: false,
    alertReactivated: false,
    alertResolved: false,
    availableStock: available,
    threshold,
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
        threshold,
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
          threshold,
          alertStatus: "active",
          alertSentAt: now,
          acknowledgedAt: null,
          resolvedAt: null,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(productLowStockAlerts.variantId, variantId));
      result.alertReactivated = true;
    } else {
      // Already active or acknowledged: refresh the quantity and alert level.
      await db
        .update(productLowStockAlerts)
        .set({
          currentQty: available,
          threshold,
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
 * Mark a SKU that needs review as seen. The alert row is refreshed from live
 * stock first, so a SKU that went low without one (a new store default, a
 * product-page edit) can be marked too. Returns false when it no longer needs
 * review.
 */
export async function acknowledgeLowStockAlert(
  db: Database,
  variantId: string
): Promise<boolean> {
  await checkAndAlertLowStock(db, variantId);
  const acknowledged = await db
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
    )
    .returning({ id: productLowStockAlerts.id });
  return acknowledged.length === 1;
}

/**
 * Save the store-wide alert level used by SKUs without their own (`null`
 * turns it off). The Low stock list reads live stock against it, so no SKU
 * is rewritten; the caller bumps the public cache generation because the
 * level shapes buyer availability bands.
 */
export async function setDefaultLowStockThreshold(
  db: Database,
  level: number | null,
): Promise<{ defaultLowStockThreshold: number | null }> {
  const parsed = lowStockThresholdSchema.safeParse(level);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Enter a whole number.", {
      field: "defaultLowStockThreshold",
    });
  }
  const { value } = await inventorySettingsDocument.write(db, { defaultLowStockThreshold: parsed.data });
  return { defaultLowStockThreshold: value.defaultLowStockThreshold };
}

/**
 * Set a tracked SKU's alert level (`null` uses the store default, 0 turns it
 * off) and re-check its alert
 * at once. This is not a stock mutation: no movement row, no stockVersion.
 * The level shapes the buyer availability band, so the caller bumps the
 * public cache generation after this commits.
 */
export async function setLowStockThreshold(
  db: Database,
  variantId: string,
  lowStockThreshold: number | null,
): Promise<{ variantId: string; lowStockThreshold: number | null }> {
  const parsed = lowStockThresholdSchema.safeParse(lowStockThreshold);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Enter a whole number.", {
      field: "lowStockThreshold",
    });
  }
  const updated = await db
    .update(productVariants)
    .set({ lowStockThreshold: parsed.data, updatedAt: sql`unixepoch()` })
    .where(and(
      eq(productVariants.id, variantId),
      eq(productVariants.trackInventory, true),
      isNull(productVariants.deletedAt),
      sql`EXISTS (
        SELECT 1 FROM products
        WHERE products.id = ${productVariants.productId} AND products.deleted_at IS NULL
      )`,
      operationalSkuRowPredicate(),
    ))
    .returning({ id: productVariants.id });
  if (updated.length !== 1) throw new NotFoundError("Variant not found");
  await checkAndAlertLowStock(db, variantId);
  return { variantId, lowStockThreshold: parsed.data };
}
