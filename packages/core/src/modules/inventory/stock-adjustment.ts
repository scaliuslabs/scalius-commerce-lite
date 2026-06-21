// packages/core/src/modules/inventory/stock-adjustment.ts
// Dedicated stock adjustment operations for barcode scanner and stocktake workflows.

import { productVariants, products, productImages } from "@scalius/database/schema";
import { safeBatch } from "@scalius/database/client";
import { eq, sql, and, isNull } from "drizzle-orm";
import { checkAndAlertLowStock } from "./alerts";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ConflictError } from "@scalius/core/errors";
import { buildStockMovementClaim } from "./stock-movement-claims";

const MAX_CAS_RETRIES = 3;
const BASE_BACKOFF_MS = 50;

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

type StockVariantState = {
  id: string;
  stock: number;
  stockVersion: number;
};

async function applyStrictStockSet(
  db: Database,
  variant: StockVariantState,
  targetStock: number,
  notes: string,
  adminUserId?: string,
): Promise<StockSetResult> {
  const previousStock = variant.stock;
  const delta = targetStock - previousStock;

  if (delta === 0) {
    return { variantId: variant.id, previousStock, newStock: targetStock, delta: 0 };
  }

  const movementInsert = buildStockMovementClaim(db, {
    movementId: crypto.randomUUID(),
    variantId: variant.id,
    stockVersion: variant.stockVersion,
    quantity: delta,
    previousStock,
    newStock: targetStock,
    notes,
    adminUserId,
  });
  const stockUpdate = db
    .update(productVariants)
    .set({
      stock: targetStock,
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(productVariants.id, variant.id),
        eq(productVariants.stockVersion, variant.stockVersion),
        isNull(productVariants.deletedAt),
      ),
    )
    .returning({ id: productVariants.id });

  const [movementRows, updateRows] = await safeBatch(
    db,
    [movementInsert, stockUpdate] as never,
  ) as { id: string }[][];

  if ((movementRows?.length ?? 0) > 0 && (updateRows?.length ?? 0) > 0) {
    if (delta < 0) {
      await checkAndAlertLowStock(db, variant.id);
    }

    return { variantId: variant.id, previousStock, newStock: targetStock, delta };
  }

  throw new ConflictError("Stock changed concurrently before movement could be recorded");
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

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        stockVersion: productVariants.stockVersion,
      })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
      .get();

    if (!variant) {
      throw new NotFoundError("Variant not found");
    }

    const previousStock = variant.stock;
    const newStock = Math.max(0, previousStock + delta);

    try {
      return await applyStrictStockSet(
        db,
        variant,
        newStock,
        reason ? `Scanner adjustment: ${reason}` : "Scanner adjustment",
        adminUserId,
      );
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }

    // CAS conflict — retry with backoff
    if (attempt < MAX_CAS_RETRIES - 1) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new ConflictError(
    `Failed to adjust stock after ${MAX_CAS_RETRIES} retries due to concurrent modifications`,
  );
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

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        stockVersion: productVariants.stockVersion,
      })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
      .get();

    if (!variant) {
      throw new NotFoundError("Variant not found");
    }

    const previousStock = variant.stock;

    // No change needed
    if (targetStock === previousStock) {
      return { variantId, previousStock, newStock: targetStock, delta: 0 };
    }

    try {
      return await applyStrictStockSet(
        db,
        variant,
        targetStock,
        reason
          ? `Stocktake: ${reason}`
          : `Stocktake: set from ${previousStock} to ${targetStock}`,
        adminUserId,
      );
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }

    // CAS conflict — retry with backoff
    if (attempt < MAX_CAS_RETRIES - 1) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new ConflictError(
    `Failed to set stock after ${MAX_CAS_RETRIES} retries due to concurrent modifications`,
  );
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
