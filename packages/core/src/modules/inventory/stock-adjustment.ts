// packages/core/src/modules/inventory/stock-adjustment.ts
// Dedicated stock adjustment operations for barcode scanner workflow.

import { productVariants, products, productImages } from "@scalius/database/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { recordMovement } from "./movements";
import { checkAndAlertLowStock } from "./alerts";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";

export interface StockAdjustResult {
  variantId: string;
  previousStock: number;
  newStock: number;
  delta: number;
}

export interface StockSetResult {
  variantId: string;
  previousStock: number;
  newStock: number;
  delta: number;
}

/**
 * Adjust stock by a relative delta (positive = add, negative = remove).
 * Records an inventory movement and checks low-stock alerts.
 */
export async function adjustStock(
  db: Database,
  variantId: string,
  adjustment: number,
  reason?: string,
  adminUserId?: string,
): Promise<StockAdjustResult> {
  const delta = Math.round(adjustment);

  const variant = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .get();

  if (!variant) {
    throw new NotFoundError("Variant not found");
  }

  const previousStock = variant.stock;
  const newStock = Math.max(0, previousStock + delta);

  await db
    .update(productVariants)
    .set({
      stock: sql`MAX(0, ${productVariants.stock} + ${delta})`,
      version: sql`${productVariants.version} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(productVariants.id, variantId));

  await recordMovement(db, {
    variantId,
    type: "adjusted",
    quantity: delta,
    previousStock,
    newStock,
    notes: reason ? `Scanner adjustment: ${reason}` : "Scanner adjustment",
    createdBy: adminUserId,
  });

  if (delta < 0) {
    await checkAndAlertLowStock(db, variantId);
  }

  return { variantId, previousStock, newStock, delta };
}

/**
 * Set stock to an absolute value (for stocktaking/reconciliation).
 * Calculates the delta from the current stock and records a movement.
 */
export async function setStock(
  db: Database,
  variantId: string,
  newStockValue: number,
  reason?: string,
  adminUserId?: string,
): Promise<StockSetResult> {
  const targetStock = Math.max(0, Math.round(newStockValue));

  const variant = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .get();

  if (!variant) {
    throw new NotFoundError("Variant not found");
  }

  const previousStock = variant.stock;
  const delta = targetStock - previousStock;

  // No change needed
  if (delta === 0) {
    return { variantId, previousStock, newStock: targetStock, delta: 0 };
  }

  await db
    .update(productVariants)
    .set({
      stock: targetStock,
      version: sql`${productVariants.version} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(productVariants.id, variantId));

  await recordMovement(db, {
    variantId,
    type: "adjusted",
    quantity: delta,
    previousStock,
    newStock: targetStock,
    notes: reason
      ? `Stocktake: ${reason}`
      : `Stocktake: set from ${previousStock} to ${targetStock}`,
    createdBy: adminUserId,
  });

  if (delta < 0) {
    await checkAndAlertLowStock(db, variantId);
  }

  return { variantId, previousStock, newStock: targetStock, delta };
}

/**
 * Enhanced barcode/SKU lookup that also fetches the product's primary image.
 * Searches by barcode first, falls back to SKU match.
 */
export async function lookupByBarcodeOrSku(
  db: Database,
  code: string,
) {
  // Try barcode first
  let variant = await db
    .select({
      variantId: productVariants.id,
      variantSku: productVariants.sku,
      variantSize: productVariants.size,
      variantColor: productVariants.color,
      variantPrice: productVariants.price,
      variantStock: productVariants.stock,
      variantReservedStock: productVariants.reservedStock,
      variantBarcode: productVariants.barcode,
      variantBarcodeType: productVariants.barcodeType,
      variantLowStockThreshold: productVariants.lowStockThreshold,
      productId: products.id,
      productName: products.name,
      productSlug: products.slug,
      productPrice: products.price,
      productIsActive: products.isActive,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(productVariants.barcode, code),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
      ),
    )
    .get();

  // Fall back to SKU match
  if (!variant) {
    variant = await db
      .select({
        variantId: productVariants.id,
        variantSku: productVariants.sku,
        variantSize: productVariants.size,
        variantColor: productVariants.color,
        variantPrice: productVariants.price,
        variantStock: productVariants.stock,
        variantReservedStock: productVariants.reservedStock,
        variantBarcode: productVariants.barcode,
        variantBarcodeType: productVariants.barcodeType,
        variantLowStockThreshold: productVariants.lowStockThreshold,
        productId: products.id,
        productName: products.name,
        productSlug: products.slug,
        productPrice: products.price,
        productIsActive: products.isActive,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(productVariants.sku, code),
          isNull(productVariants.deletedAt),
          isNull(products.deletedAt),
        ),
      )
      .get();
  }

  if (!variant) return null;

  // Fetch primary image
  const image = await db
    .select({ url: productImages.url })
    .from(productImages)
    .where(
      and(
        eq(productImages.productId, variant.productId),
        eq(productImages.isPrimary, true),
      ),
    )
    .get();

  return {
    variant: {
      id: variant.variantId,
      sku: variant.variantSku,
      size: variant.variantSize,
      color: variant.variantColor,
      price: variant.variantPrice,
      stock: variant.variantStock,
      reservedStock: variant.variantReservedStock,
      available: variant.variantStock - variant.variantReservedStock,
      barcode: variant.variantBarcode,
      barcodeType: variant.variantBarcodeType,
      lowStockThreshold: variant.variantLowStockThreshold,
    },
    product: {
      id: variant.productId,
      name: variant.productName,
      slug: variant.productSlug,
      price: variant.productPrice,
      isActive: variant.productIsActive,
      imageUrl: image?.url ?? null,
    },
  };
}
