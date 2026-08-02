// packages/core/src/modules/inventory/stock-adjustment.ts
// Dedicated stock adjustment operations for barcode scanner and stocktake workflows.

import { productVariants, products } from "@scalius/database/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
import {
  getBarcodeIdentityKey,
  normalizeBarcodeValue,
} from "@scalius/shared/barcode-identity";
import { productVariantBarcodeIdentityEquals } from "../products/products.variant-identity";
import { operationalSkuRowPredicate } from "../products/products.public-eligibility";
import { variantOptionLabelSql } from "../products/products.option-model";
import { executeInventoryOperation } from "./inventory-operations";
import {
  loadProductMediaProjections,
  resolveSkuImageRepresentation,
} from "../products/products.media";

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
  operationKey: string,
  reason?: string,
  adminUserId?: string,
): Promise<StockAdjustResult> {
  return executeInventoryOperation(db, {
    operationKey,
    operationType: "scanner_adjustment",
    variantId,
    pool: "stock",
    mode: "relative",
    delta: adjustment,
    reason: reason?.trim() || "Scanner adjustment",
  }, adminUserId);
}

/**
 * Set stock to an absolute value (for stocktaking/reconciliation).
 * Calculates the delta from the current stock and records a movement.
 */
export async function setStock(
  db: Database,
  variantId: string,
  newStockValue: number,
  operationKey: string,
  reason?: string,
  adminUserId?: string,
): Promise<StockSetResult> {
  return executeInventoryOperation(db, {
    operationKey,
    operationType: "stocktake",
    variantId,
    pool: "stock",
    mode: "stocktake",
    newStock: newStockValue,
    reason: reason?.trim() || "Stocktake",
  }, adminUserId);
}

/**
 * Enhanced barcode/SKU lookup that also fetches the product's primary image.
 * Searches by barcode first, falls back to SKU match.
 */
export async function lookupByBarcodeOrSku(
  db: Database,
  code: string,
) {
  const normalizedCode = normalizeBarcodeValue(code);
  if (!normalizedCode) return null;

  const barcodeIdentity = getBarcodeIdentityKey(normalizedCode)!;
  const lookupFields = {
    variantId: productVariants.id,
    variantImageId: productVariants.imageId,
    variantSku: productVariants.sku,
    variantLabel: variantOptionLabelSql(productVariants.id),
    variantPrice: productVariants.price,
    variantStock: productVariants.stock,
    variantReservedStock: effectiveRegularReservedStockSql(),
    variantBarcode: productVariants.barcode,
    variantBarcodeType: productVariants.barcodeType,
    variantLowStockThreshold: productVariants.lowStockThreshold,
    productId: products.id,
    productName: products.name,
    productSlug: products.slug,
    productPrice: products.price,
    productIsActive: products.isActive,
  };

  let variant = await db
    .select(lookupFields)
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        productVariantBarcodeIdentityEquals(barcodeIdentity),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        operationalSkuRowPredicate(),
      ),
    )
    .get();

  // Barcode and SKU identities share the same trimmed, case-insensitive
  // database contract, so scanners behave consistently for either code.
  if (!variant) {
    variant = await db
      .select(lookupFields)
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          sql`lower(trim(${productVariants.sku})) = ${barcodeIdentity}`,
          isNull(productVariants.deletedAt),
          isNull(products.deletedAt),
          operationalSkuRowPredicate(),
        ),
      )
      .get();
  }

  if (!variant) return null;

  const mediaMap = await loadProductMediaProjections(db, [variant.productId]);
  const image = resolveSkuImageRepresentation(
    mediaMap.get(variant.productId) ?? [],
    variant.variantImageId,
  );

  return {
    variant: {
      id: variant.variantId,
      sku: variant.variantSku,
      optionLabel: variant.variantLabel,
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
      imageMediaId: image?.mediaId ?? null,
    },
  };
}
