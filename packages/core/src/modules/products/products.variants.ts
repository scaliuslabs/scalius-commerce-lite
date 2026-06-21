// src/modules/products/products.variants.ts
// Variant-specific queries and mutations + barcode lookup.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import {
    products,
    productVariants,
} from "@scalius/database/schema";
import { and, sql, eq, inArray, isNull, ne, not } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import { safeBatch } from "@scalius/database/client";
import { checkAndAlertLowStock } from "../inventory/alerts";
import { buildStockMovementClaim } from "../inventory/stock-movement-claims";
import {
    createVariantSchema,
    updateVariantSchema,
    updateSortOrderSchema,
    bulkVariantSchema,
} from "./products.types";

function normalizeOptionValue(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function hasCustomerOption(value: { size?: string | null; color?: string | null }): boolean {
    return Boolean(normalizeOptionValue(value.size) || normalizeOptionValue(value.color));
}

function assertNormalVariantHasCustomerOption(value: { size?: string | null; color?: string | null }) {
    if (!hasCustomerOption(value)) {
        throw new ValidationError("Add at least one customer option, such as size or color. Products without options use the built-in simple SKU.");
    }
}

// ─────────────────────────────────────────
// Barcode lookup
// ─────────────────────────────────────────

/**
 * Looks up a product variant by barcode value.
 * Returns the variant with its parent product details, or null if not found.
 * Used by barcode scanners in the admin interface.
 */
export async function lookupByBarcode(db: DrizzleD1Database<typeof schema>, barcode: string) {
    const variant = await db
        .select({
            variantId: productVariants.id,
            variantSku: productVariants.sku,
            variantSize: productVariants.size,
            variantColor: productVariants.color,
            variantWeight: productVariants.weight,
            variantPrice: productVariants.price,
            variantStock: productVariants.stock,
            variantReservedStock: productVariants.reservedStock,
            variantBarcode: productVariants.barcode,
            variantBarcodeType: productVariants.barcodeType,
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
                eq(productVariants.barcode, barcode),
                isNull(productVariants.deletedAt),
                isNull(products.deletedAt),
            ),
        )
        .get();

    if (!variant) return null;

    return {
        variant: {
            id: variant.variantId,
            sku: variant.variantSku,
            size: variant.variantSize,
            color: variant.variantColor,
            weight: variant.variantWeight,
            price: variant.variantPrice,
            stock: variant.variantStock,
            reservedStock: variant.variantReservedStock,
            barcode: variant.variantBarcode,
            barcodeType: variant.variantBarcodeType,
        },
        product: {
            id: variant.productId,
            name: variant.productName,
            slug: variant.productSlug,
            price: variant.productPrice,
            isActive: variant.productIsActive,
        },
    };
}

// ─────────────────────────────────────────
// Variant specific mutations
// ─────────────────────────────────────────

export async function getProductVariants(db: DrizzleD1Database<typeof schema>, productId: string) {
    const variants = await db
        .select({
            id: productVariants.id,
            size: productVariants.size,
            color: productVariants.color,
            weight: productVariants.weight,
            sku: productVariants.sku,
            price: productVariants.price,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            isDefault: productVariants.isDefault,
            trackInventory: productVariants.trackInventory,
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
            discountType: productVariants.discountType,
            discountPercentage: productVariants.discountPercentage,
            discountAmount: productVariants.discountAmount,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
            createdAt: sql<string>`datetime(${productVariants.createdAt}, 'unixepoch', 'localtime')`,
            updatedAt: sql<string>`datetime(${productVariants.updatedAt}, 'unixepoch', 'localtime')`,
        })
        .from(productVariants)
        .where(
            sql`${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
        )
        .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder, productVariants.createdAt);

    return variants.map((variant: { id: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: string; updatedAt: string }) => ({
        ...variant,
        createdAt: new Date(variant.createdAt),
        updatedAt: new Date(variant.updatedAt),
    }));
}

export async function createVariant(db: DrizzleD1Database<typeof schema>, productId: string, data: z.infer<typeof createVariantSchema>) {
    assertNormalVariantHasCustomerOption(data);
    const size = normalizeOptionValue(data.size);
    const color = normalizeOptionValue(data.color);
    const existingVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`${productVariants.sku} = ${data.sku} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (existingVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const [variant] = await db
        .insert(productVariants)
        .values({
            id: "var_" + nanoid(),
            productId,
            size,
            color,
            weight: data.weight,
            sku: data.sku,
            price: data.price,
            stock: data.stock,
            isDefault: false,
            trackInventory: data.trackInventory ?? true,
            barcode: data.barcode || null,
            barcodeType: data.barcodeType || null,
            discountType: data.discountType || "percentage",
            discountPercentage: (data.discountType || "percentage") === "percentage" ? (data.discountPercentage || null) : 0,
            discountAmount: (data.discountType || "percentage") === "flat" ? (data.discountAmount || null) : 0,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    return variant;
}

export async function updateVariant(db: DrizzleD1Database<typeof schema>, productId: string, variantId: string, data: z.infer<typeof updateVariantSchema>, adminUserId?: string) {
    const existingVariant = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
            size: productVariants.size,
            color: productVariants.color,
            stock: productVariants.stock,
            stockVersion: productVariants.stockVersion,
            trackInventory: productVariants.trackInventory,
        })
        .from(productVariants)
        .where(sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (!existingVariant) {
        throw new NotFoundError("Variant not found");
    }

    const size = normalizeOptionValue(data.size);
    const color = normalizeOptionValue(data.color);
    const existingIsSimpleSku = existingVariant.isDefault;
    if (existingIsSimpleSku) {
        if (size || color) {
            throw new ValidationError("The simple product SKU cannot be turned into an option. Add a new variant instead.");
        }
    } else {
        assertNormalVariantHasCustomerOption({ size, color });
    }

    const existingSkuVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`${productVariants.sku} = ${data.sku} AND ${productVariants.id} != ${variantId} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (existingSkuVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const simpleProductPricing = existingIsSimpleSku
        ? await db
            .select({
                price: products.price,
            })
            .from(products)
            .where(and(eq(products.id, productId), isNull(products.deletedAt)))
            .get()
        : null;

    if (existingIsSimpleSku && !simpleProductPricing) {
        throw new NotFoundError("Product not found");
    }

    const updateValues = {
        size,
        color,
        weight: data.weight,
        sku: data.sku,
        price: simpleProductPricing?.price ?? data.price,
        trackInventory: data.trackInventory ?? existingVariant.trackInventory,
        barcode: data.barcode || null,
        barcodeType: data.barcodeType || null,
        discountType: existingIsSimpleSku ? "percentage" : data.discountType || "percentage",
        discountPercentage: existingIsSimpleSku
            ? 0
            : (data.discountType || "percentage") === "percentage" ? (data.discountPercentage || null) : 0,
        discountAmount: existingIsSimpleSku
            ? 0
            : (data.discountType || "percentage") === "flat" ? (data.discountAmount || null) : 0,
        updatedAt: sql`unixepoch()`,
    };

    if (data.stock !== existingVariant.stock) {
        const delta = data.stock - existingVariant.stock;
        const movementInsert = buildStockMovementClaim(db, {
            movementId: crypto.randomUUID(),
            variantId,
            stockVersion: existingVariant.stockVersion,
            quantity: delta,
            previousStock: existingVariant.stock,
            newStock: data.stock,
            notes: "Stocktake: Product variant edit",
            adminUserId,
        });
        const variantUpdate = db
            .update(productVariants)
            .set({
                ...updateValues,
                stock: data.stock,
                stockVersion: sql`${productVariants.stockVersion} + 1`,
            })
            .where(and(
                eq(productVariants.id, variantId),
                eq(productVariants.productId, productId),
                eq(productVariants.stockVersion, existingVariant.stockVersion),
                isNull(productVariants.deletedAt),
            ))
            .returning();

        const [movementRows, variantRows] = await safeBatch(
            db,
            [movementInsert, variantUpdate] as never,
        ) as [Array<{ id: string }>, Array<typeof productVariants.$inferSelect>];

        if ((movementRows?.length ?? 0) === 0 || (variantRows?.length ?? 0) === 0) {
            throw new ConflictError("Stock changed concurrently before variant update could be saved");
        }

        if (delta < 0) {
            await checkAndAlertLowStock(db, variantId);
        }

        return variantRows[0];
    }

    const [variant] = await db
        .update(productVariants)
        .set(updateValues)
        .where(and(
            eq(productVariants.id, variantId),
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
        ))
        .returning();

    return variant;
}

export async function deleteVariant(db: DrizzleD1Database<typeof schema>, productId: string, variantId: string) {
    const existingVariant = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
        })
        .from(productVariants)
        .where(sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (!existingVariant) {
        throw new NotFoundError("Variant not found");
    }

    if (existingVariant.isDefault) {
        throw new ValidationError("The protected simple product SKU cannot be deleted from the generic option editor.");
    }

    const product = await db
        .select({ isActive: products.isActive })
        .from(products)
        .where(eq(products.id, productId))
        .get();
    const remainingVariantCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            ne(productVariants.id, variantId),
            isNull(productVariants.deletedAt),
        ))
        .get();
    if (product?.isActive && (remainingVariantCount?.count ?? 0) === 0) {
        throw new ValidationError("Deactivate this product before removing its final SKU.");
    }

    await db.delete(productVariants).where(eq(productVariants.id, variantId));
}

export async function duplicateVariant(db: DrizzleD1Database<typeof schema>, productId: string, variantId: string) {
    const [existingVariant] = await db
        .select()
        .from(productVariants)
        .where(sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`)
        .limit(1);

    if (!existingVariant) {
        throw new NotFoundError("Variant not found");
    }

    if (existingVariant.isDefault || !hasCustomerOption(existingVariant)) {
        throw new ValidationError("The simple product SKU cannot be duplicated as a normal variant. Add a size or color variant instead.");
    }

    let newSku = `${existingVariant.sku}-COPY`;
    let counter = 1;

    while (true) {
        const existing = await db
            .select({ id: productVariants.id })
            .from(productVariants)
            .where(sql`${productVariants.sku} = ${newSku} AND ${productVariants.deletedAt} IS NULL`)
            .get();

        if (!existing) break;

        counter++;
        newSku = `${existingVariant.sku}-COPY${counter}`;
    }

    const [newVariant] = await db
        .insert(productVariants)
        .values({
            id: "var_" + nanoid(),
            productId,
            size: existingVariant.size,
            color: existingVariant.color,
            weight: existingVariant.weight,
            sku: newSku,
            price: existingVariant.price,
            stock: 0,
            reservedStock: 0,
            preorderStock: 0,
            isDefault: false,
            trackInventory: existingVariant.trackInventory,
            version: 1,
            stockVersion: 1,
            barcode: existingVariant.barcode,
            barcodeType: existingVariant.barcodeType,
            discountType: existingVariant.discountType,
            discountPercentage: existingVariant.discountPercentage,
            discountAmount: existingVariant.discountAmount,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    return newVariant;
}

export async function bulkCreateVariants(db: DrizzleD1Database<typeof schema>, productId: string, variants: z.infer<typeof bulkVariantSchema>[]) {
    variants.forEach(assertNormalVariantHasCustomerOption);
    const skus = variants.map((v) => v.sku);
    const duplicateSkus = skus.filter((sku, index) => skus.indexOf(sku) !== index);

    if (duplicateSkus.length > 0) {
        throw new ValidationError(`Duplicate SKUs found in request: ${duplicateSkus.join(", ")}`);
    }

    const existingVariants: Array<{ sku: string }> = await db
        .select({ sku: productVariants.sku })
        .from(productVariants)
        .where(sql`${productVariants.sku} IN ${skus} AND ${productVariants.deletedAt} IS NULL`)
        .all();

    if (existingVariants.length > 0) {
        throw new ConflictError(`One or more SKUs already exist: ${existingVariants.map((v) => v.sku).join(", ")}`);
    }

    const variantsToCreate = variants.map((variant) => ({
        id: "var_" + nanoid(),
        productId,
        size: normalizeOptionValue(variant.size),
        color: normalizeOptionValue(variant.color),
        weight: variant.weight || null,
        sku: variant.sku,
        price: variant.price ?? 0,
        stock: variant.stock ?? 0,
        isDefault: false,
        trackInventory: variant.trackInventory ?? true,
        reservedStock: 0,
        preorderStock: 0,
        version: 1,
        stockVersion: 1,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        barcode: variant.barcode || null,
        barcodeType: variant.barcodeType || null,
        discountType: variant.discountType || "percentage",
        discountPercentage: variant.discountPercentage ?? 0,
        discountAmount: variant.discountAmount ?? 0,
        colorSortOrder: variant.colorSortOrder ?? 0,
        sizeSortOrder: variant.sizeSortOrder ?? 0,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }));

    const createdVariants = [];
    // D1 has a 100 bound parameter limit per query.
    // Each variant has ~22 params, so max 4 per chunk (4 × 22 = 88 < 100).
    const chunkSize = 4;
    for (let i = 0; i < variantsToCreate.length; i += chunkSize) {
        const chunk = variantsToCreate.slice(i, i + chunkSize);
        const result = await db
            .insert(productVariants)
            .values(chunk)
            .returning();
        createdVariants.push(...result);
    }

    return createdVariants;
}

export async function bulkDeleteVariants(db: DrizzleD1Database<typeof schema>, productId: string, variantIds: string[]) {
    if (variantIds.length === 0) throw new ValidationError("No variant IDs provided");

    const protectedVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            inArray(productVariants.id, variantIds),
            eq(productVariants.isDefault, true),
            isNull(productVariants.deletedAt),
        ))
        .get();
    if (protectedVariant) {
        throw new ValidationError("The protected simple product SKU cannot be deleted from the generic option editor.");
    }

    const product = await db
        .select({ isActive: products.isActive })
        .from(products)
        .where(eq(products.id, productId))
        .get();
    const remainingVariantCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            not(inArray(productVariants.id, variantIds)),
            isNull(productVariants.deletedAt),
        ))
        .get();
    if (product?.isActive && (remainingVariantCount?.count ?? 0) === 0) {
        throw new ValidationError("Deactivate this product before removing its final SKU.");
    }

    await db
        .delete(productVariants)
        .where(and(inArray(productVariants.id, variantIds), eq(productVariants.productId, productId)));
}

export async function getVariantSortOrder(db: DrizzleD1Database<typeof schema>, productId: string) {
    const variants = await db
        .select({
            color: productVariants.color,
            size: productVariants.size,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
        })
        .from(productVariants)
        .where(
            and(
                eq(productVariants.productId, productId),
                isNull(productVariants.deletedAt)
            )
        );

    const colorMap = new Map<string, number>();
    const sizeMap = new Map<string, number>();

    variants.forEach((variant: { color: string | null; size: string | null; colorSortOrder: number | null; sizeSortOrder: number | null }) => {
        if (variant.color && !colorMap.has(variant.color)) {
            colorMap.set(variant.color, variant.colorSortOrder || 0);
        }
        if (variant.size && !sizeMap.has(variant.size)) {
            sizeMap.set(variant.size, variant.sizeSortOrder || 0);
        }
    });

    const colors = Array.from(colorMap.entries())
        .map(([value, sortOrder]) => ({ value, sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder);

    const sizes = Array.from(sizeMap.entries())
        .map(([value, sortOrder]) => ({ value, sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder);

    return { colors, sizes };
}

export async function updateVariantSortOrder(db: DrizzleD1Database<typeof schema>, productId: string, data: z.infer<typeof updateSortOrderSchema>) {
    const batchOps: unknown[] = [];

    for (const color of data.colors) {
        batchOps.push(
            db
                .update(productVariants)
                .set({
                    colorSortOrder: color.sortOrder,
                    updatedAt: sql`unixepoch()`,
                })
                .where(
                    and(
                        eq(productVariants.productId, productId),
                        eq(productVariants.color, color.value),
                        isNull(productVariants.deletedAt)
                    )
                )
        );
    }

    for (const size of data.sizes) {
        batchOps.push(
            db
                .update(productVariants)
                .set({
                    sizeSortOrder: size.sortOrder,
                    updatedAt: sql`unixepoch()`,
                })
                .where(
                    and(
                        eq(productVariants.productId, productId),
                        eq(productVariants.size, size.value),
                        isNull(productVariants.deletedAt)
                    )
                )
        );
    }

    if (batchOps.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        await db.batch(batchOps as any);
    }
}
