// src/modules/products/products.variants.ts
// Variant-specific queries and mutations + barcode lookup.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import {
    orders,
    orderItems,
    OrderStatus,
    products,
    productVariants,
} from "@scalius/database/schema";
import { and, sql, eq, inArray, isNull, ne, not } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import { checkAndAlertLowStock } from "../inventory/alerts";
import { buildStockMovementClaim } from "../inventory/stock-movement-claims";
import {
    createVariantSchema,
    updateVariantSchema,
    updateSortOrderSchema,
    bulkVariantSchema,
    variantEditPlanSchema,
    type VariantEditPlan,
} from "./products.types";
import {
    normalizeDefaultSkuOptions,
    operationalSkuRowPredicate,
} from "./products.public-eligibility";
import { classifyProductVariantOptionAxes } from "@scalius/shared/product-options";
import {
    getBarcodeIdentityKey,
    getBarcodeValidationError,
    normalizeBarcodeValue,
    type BarcodeType,
} from "@scalius/shared/barcode-identity";
import {
    executeProductAggregateMutationBatch as executeProductAggregateMutationBatchRaw,
    type ProductAggregateRevisionResult,
} from "./products.aggregate-revision";
import {
    productVariantBarcodeIdentityEquals,
    productVariantBarcodeIdentityIn,
} from "./products.variant-identity";

export function rethrowProductVariantIdentityConstraint(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("product_variants_sku_identity_uidx")) {
        throw new ConflictError("A SKU with this identifier already exists.");
    }
    if (message.includes("product_variants_barcode_identity_uidx")) {
        throw new ConflictError("A SKU with this barcode already exists.");
    }
    if (message.includes("product_variants_active_option_identity_uidx")) {
        throw new ConflictError("A SKU with this option combination already exists.");
    }
    if (message.includes("INVALID_PRODUCT_VARIANT_IDENTITY")) {
        throw new ValidationError("SKU, option, or barcode identity is not canonical.");
    }
    throw error;
}

async function executeProductAggregateMutationBatch(
    ...args: Parameters<typeof executeProductAggregateMutationBatchRaw>
): ReturnType<typeof executeProductAggregateMutationBatchRaw> {
    try {
        return await executeProductAggregateMutationBatchRaw(...args);
    } catch (error) {
        return rethrowProductVariantIdentityConstraint(error);
    }
}

function normalizeOptionValue(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function hasCustomerOption(value: { size?: string | null; color?: string | null }): boolean {
    return Boolean(normalizeOptionValue(value.size) || normalizeOptionValue(value.color));
}

const ORDER_STATUSES_THAT_ALLOW_SKU_RETIREMENT = [
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
];

export function assertConsistentVariantOptionAxes(variants: Array<{ size?: string | null; color?: string | null }>) {
    if (classifyProductVariantOptionAxes(variants) === "mixed") {
        throw new ValidationError("Use the same option fields for every SKU on this product: Option 1 only, Option 2 only, or both options on every SKU.");
    }
}

type TransitionSku = {
    isDefault?: boolean;
    size?: string | null;
    color?: string | null;
    stock: number;
    reservedStock?: number;
    preorderStock?: number;
    trackInventory?: boolean;
};

export function assertSimpleSkuTransitionStockAllocation(
    currentVariants: TransitionSku[],
    creates: Array<Pick<TransitionSku, "stock" | "trackInventory">>,
): void {
    if (creates.length === 0) return;
    if (currentVariants.some((variant) => !variant.isDefault && hasCustomerOption(variant))) {
        return;
    }

    const defaultSku = currentVariants.find((variant) => variant.isDefault);
    if (!defaultSku) return;
    if ((defaultSku.reservedStock ?? 0) > 0 || (defaultSku.preorderStock ?? 0) > 0) {
        throw new ConflictError(
            "This product has reserved stock. Finish or release those orders before adding customer options.",
        );
    }
    if (defaultSku.trackInventory === false) return;

    const allocatedStock = creates.reduce(
        (total, variant) => total + (variant.trackInventory === false ? 0 : variant.stock),
        0,
    );
    if (allocatedStock !== defaultSku.stock) {
        throw new ValidationError(
            `Allocate exactly ${defaultSku.stock} on-hand units across the new options before converting this product. Currently allocated: ${allocatedStock}.`,
        );
    }
}

function normalizedOptionCombinationKey(value: {
    size?: string | null;
    color?: string | null;
}): string {
    return JSON.stringify([
        normalizeOptionValue(value.size)?.toLowerCase() ?? "",
        normalizeOptionValue(value.color)?.toLowerCase() ?? "",
    ]);
}

function normalizeSku(value: string): string {
    return value.trim();
}

function normalizedSkuKey(value: string): string {
    return normalizeSku(value).toLocaleLowerCase("en-US");
}

export function normalizeVariantBarcode(
    barcode: string | null | undefined,
    barcodeType: BarcodeType | null | undefined,
): { barcode: string | null; barcodeType: BarcodeType | null } {
    const normalizedBarcode = normalizeBarcodeValue(barcode);
    const normalizedType = barcodeType ?? null;
    const validationError = getBarcodeValidationError(normalizedBarcode, normalizedType);
    if (validationError) throw new ValidationError(validationError);
    return { barcode: normalizedBarcode, barcodeType: normalizedType };
}

export async function assertUniqueVariantBarcodes(
    db: DrizzleD1Database<typeof schema>,
    candidates: Array<{
        id?: string;
        barcode: string | null;
        barcodeType: BarcodeType | null;
    }>,
): Promise<void> {
    const keyedCandidates = candidates.flatMap((candidate, index) => {
        const key = getBarcodeIdentityKey(candidate.barcode);
        return key ? [{ ...candidate, key, owner: candidate.id ?? `new:${index}` }] : [];
    });
    const ownerByKey = new Map<string, string>();
    for (const candidate of keyedCandidates) {
        if (ownerByKey.has(candidate.key)) {
            throw new ValidationError("Each SKU must use a unique barcode.");
        }
        ownerByKey.set(candidate.key, candidate.owner);
    }
    if (ownerByKey.size === 0) return;

    const candidateById = new Map(
        keyedCandidates.flatMap((candidate) =>
            candidate.id ? [[candidate.id, candidate] as const] : []
        ),
    );
    const rows = await db
        .select({ id: productVariants.id, barcode: productVariants.barcode })
        .from(productVariants)
        .where(productVariantBarcodeIdentityIn([...ownerByKey.keys()]));
    for (const row of rows) {
        const rowKey = getBarcodeIdentityKey(row.barcode);
        if (!rowKey) continue;
        const plannedRow = candidateById.get(row.id);
        if (plannedRow && plannedRow.key !== rowKey) continue;
        if (ownerByKey.get(rowKey) !== row.id) {
            throw new ConflictError("A SKU with this barcode already exists.");
        }
    }
}

function assertUniqueNormalizedValues(
    values: string[],
    label: string,
): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        const key = normalizedSkuKey(value);
        if (seen.has(key)) duplicates.add(normalizeSku(value));
        seen.add(key);
    }
    if (duplicates.size > 0) {
        throw new ValidationError(
            `${label}: ${Array.from(duplicates).join(", ")}`,
        );
    }
}

export function assertUniqueChangedVariantOptions(
    changedVariants: Array<{ size?: string | null; color?: string | null }>,
    existingVariants: Array<{ size?: string | null; color?: string | null }> = [],
): void {
    const changedKeys = changedVariants.map(normalizedOptionCombinationKey);
    if (new Set(changedKeys).size !== changedKeys.length) {
        throw new ValidationError(
            "Each active SKU must use a unique option combination.",
        );
    }

    const existingKeys = new Set(existingVariants.map(normalizedOptionCombinationKey));
    if (changedKeys.some((key) => existingKeys.has(key))) {
        throw new ConflictError(
            "An active SKU already uses this option combination.",
        );
    }
}

export async function assertProductVariantOptionAxes(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    changedVariants: Array<{ id?: string; size?: string | null; color?: string | null }>,
    excludedVariantIds: string[] = [],
) {
    assertConsistentVariantOptionAxes(changedVariants);
    assertUniqueChangedVariantOptions(changedVariants);

    const conditions = [
        eq(productVariants.productId, productId),
        eq(productVariants.isDefault, false),
        isNull(productVariants.deletedAt),
    ];
    if (excludedVariantIds.length > 0) {
        conditions.push(not(inArray(productVariants.id, excludedVariantIds)));
    }

    const existingVariants = await db
        .select({
            id: productVariants.id,
            size: productVariants.size,
            color: productVariants.color,
        })
        .from(productVariants)
        .where(and(...conditions));

    assertConsistentVariantOptionAxes([...existingVariants, ...changedVariants]);
    assertUniqueChangedVariantOptions(changedVariants, existingVariants);
}

function assertNormalVariantHasCustomerOption(value: { size?: string | null; color?: string | null }) {
    if (!hasCustomerOption(value)) {
        throw new ValidationError("Add at least one customer option. Products without options use the built-in simple SKU.");
    }
}

function customerOptionPredicate() {
    return sql`(trim(coalesce(${productVariants.size}, '')) <> '' OR trim(coalesce(${productVariants.color}, '')) <> '')`;
}

async function variantHasOpenOrderReference(db: DrizzleD1Database<typeof schema>, variantId: string): Promise<boolean> {
    const openOrderReference = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(
            eq(orderItems.variantId, variantId),
            isNull(orders.deletedAt),
            not(inArray(orders.status, ORDER_STATUSES_THAT_ALLOW_SKU_RETIREMENT)),
        ))
        .get();

    return (openOrderReference?.count ?? 0) > 0;
}

async function loadOpenOrderBackedVariantIds(db: DrizzleD1Database<typeof schema>, variantIds: string[]): Promise<Set<string>> {
    const openOrderReferences = await db
        .select({ variantId: orderItems.variantId })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(
            inArray(orderItems.variantId, variantIds),
            isNull(orders.deletedAt),
            not(inArray(orders.status, ORDER_STATUSES_THAT_ALLOW_SKU_RETIREMENT)),
        ))
        .groupBy(orderItems.variantId);

    return new Set(openOrderReferences.map((row) => row.variantId).filter((id): id is string => Boolean(id)));
}

function uniqueVariantIds(variantIds: string[]): string[] {
    return Array.from(new Set(variantIds.map((id) => id.trim()).filter(Boolean)));
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
    const barcodeKey = getBarcodeIdentityKey(barcode);
    if (!barcodeKey) return null;
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
            variantIsDefault: productVariants.isDefault,
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
                productVariantBarcodeIdentityEquals(barcodeKey),
                isNull(productVariants.deletedAt),
                isNull(products.deletedAt),
                operationalSkuRowPredicate(),
            ),
        )
        .get();

    if (!variant) return null;

    const normalizedVariant = normalizeDefaultSkuOptions({
        id: variant.variantId,
        sku: variant.variantSku,
        size: variant.variantSize,
        color: variant.variantColor,
        isDefault: variant.variantIsDefault,
    });

    return {
        variant: {
            id: variant.variantId,
            sku: variant.variantSku,
            size: normalizedVariant.size,
            color: normalizedVariant.color,
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
        ...normalizeDefaultSkuOptions(variant),
        createdAt: new Date(variant.createdAt),
        updatedAt: new Date(variant.updatedAt),
    }));
}

export async function createVariant(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    data: z.infer<typeof createVariantSchema>,
): Promise<PersistedVariant & ProductAggregateRevisionResult> {
    assertNormalVariantHasCustomerOption(data);
    const size = normalizeOptionValue(data.size);
    const color = normalizeOptionValue(data.color);
    const sku = normalizeSku(data.sku);
    const skuKey = normalizedSkuKey(sku);
    const barcodeIdentity = normalizeVariantBarcode(data.barcode, data.barcodeType);
    const currentVariants = await db
        .select({
            isDefault: productVariants.isDefault,
            size: productVariants.size,
            color: productVariants.color,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            preorderStock: productVariants.preorderStock,
            trackInventory: productVariants.trackInventory,
        })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
        ));
    assertSimpleSkuTransitionStockAllocation(currentVariants, [data]);
    await assertProductVariantOptionAxes(db, productId, [{ size, color }]);
    await assertUniqueVariantBarcodes(db, [{ ...barcodeIdentity }]);

    const existingVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`lower(trim(${productVariants.sku})) = ${skuKey}`)
        .get();

    if (existingVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const variantId = `var_${nanoid()}`;
    const variantValues = {
        id: variantId,
        productId,
        size,
        color,
        weight: data.weight,
        sku,
        price: data.price,
        stock: data.stock > 0 ? 0 : data.stock,
        reservedStock: 0,
        preorderStock: 0,
        stockVersion: 1,
        isDefault: false,
        trackInventory: data.trackInventory ?? true,
        barcode: barcodeIdentity.barcode,
        barcodeType: barcodeIdentity.barcodeType,
        discountType: data.discountType || "percentage",
        discountPercentage: (data.discountType || "percentage") === "percentage" ? (data.discountPercentage || null) : 0,
        discountAmount: (data.discountType || "percentage") === "flat" ? (data.discountAmount || null) : 0,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    };
    const insert = db.insert(productVariants).values(variantValues).returning();
    if (data.stock === 0) {
        const result = await executeProductAggregateMutationBatch(
            db,
            productId,
            data.expectedAggregateRevision,
            [insert],
        );
        const variant = (result.mutationResults[0] as PersistedVariant[] | undefined)?.[0];
        if (!variant) throw new ConflictError("The created variant could not be confirmed.");
        return { ...variant, aggregateRevision: result.aggregateRevision };
    }

    const movement = buildStockMovementClaim(db, {
        movementId: crypto.randomUUID(),
        variantId,
        pool: "regular",
        quantity: data.stock,
        before: {
            stock: 0,
            reservedStock: 0,
            preorderStock: 0,
            stockVersion: 1,
        },
        after: {
            stock: data.stock,
            reservedStock: 0,
            preorderStock: 0,
            stockVersion: 2,
        },
        notes: "Stocktake: Initial product variant stock",
    });
    const update = db.update(productVariants)
        .set({
            stock: data.stock,
            stockVersion: sql`${productVariants.stockVersion} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(productVariants.id, variantId),
            eq(productVariants.stockVersion, 1),
            isNull(productVariants.deletedAt),
        ))
        .returning();
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        data.expectedAggregateRevision,
        [insert, movement, update],
    );
    const [, movementRows, updatedRows] = result.mutationResults as [
        PersistedVariant[],
        Array<{ id: string }>,
        PersistedVariant[],
    ];
    if ((movementRows?.length ?? 0) === 0 || (updatedRows?.length ?? 0) === 0) {
        throw new ConflictError("Initial variant stock could not be recorded");
    }
    await checkAndAlertLowStock(db, variantId);
    return { ...updatedRows[0]!, aggregateRevision: result.aggregateRevision };
}

export async function updateVariant(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    variantId: string,
    data: z.infer<typeof updateVariantSchema>,
    adminUserId?: string,
): Promise<PersistedVariant & ProductAggregateRevisionResult> {
    const existingVariant = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
            size: productVariants.size,
            color: productVariants.color,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            preorderStock: productVariants.preorderStock,
            stockVersion: productVariants.stockVersion,
            trackInventory: productVariants.trackInventory,
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
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
        await assertProductVariantOptionAxes(db, productId, [{ id: variantId, size, color }], [variantId]);
    }

    const sku = normalizeSku(data.sku);
    const skuKey = normalizedSkuKey(sku);
    const existingSkuVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`lower(trim(${productVariants.sku})) = ${skuKey} AND ${productVariants.id} != ${variantId}`)
        .get();

    if (existingSkuVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const barcodeIdentity = normalizeVariantBarcode(
        data.barcode === undefined ? existingVariant.barcode : data.barcode,
        data.barcodeType === undefined ? existingVariant.barcodeType : data.barcodeType,
    );
    await assertUniqueVariantBarcodes(db, [{
        id: variantId,
        ...barcodeIdentity,
    }]);

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
        sku,
        price: simpleProductPricing?.price ?? data.price,
        trackInventory: data.trackInventory ?? existingVariant.trackInventory,
        barcode: barcodeIdentity.barcode,
        barcodeType: barcodeIdentity.barcodeType,
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
            pool: "regular",
            quantity: delta,
            before: {
                stock: existingVariant.stock,
                reservedStock: existingVariant.reservedStock,
                preorderStock: existingVariant.preorderStock,
                stockVersion: existingVariant.stockVersion,
            },
            after: {
                stock: data.stock,
                reservedStock: existingVariant.reservedStock,
                preorderStock: existingVariant.preorderStock,
                stockVersion: existingVariant.stockVersion + 1,
            },
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
        const stockGuard = db.run(sql`
            SELECT CASE WHEN EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.id} = ${variantId}
                  AND ${productVariants.productId} = ${productId}
                  AND ${productVariants.stockVersion} = ${existingVariant.stockVersion}
                  AND ${productVariants.deletedAt} IS NULL
            ) THEN 1 ELSE json_extract('VARIANT_EDIT_CONFLICT', '$') END
        `);

        let result;
        try {
            result = await executeProductAggregateMutationBatch(
                db,
                productId,
                data.expectedAggregateRevision,
                [stockGuard, movementInsert, variantUpdate],
            );
        } catch (error) {
            if (isAtomicVariantConflict(error)) {
                throw new ConflictError(
                    "Stock changed concurrently before the SKU could be saved. Reload and try again.",
                );
            }
            throw error;
        }
        const [, movementRows, variantRows] = result.mutationResults as [
            unknown,
            Array<{ id: string }>,
            PersistedVariant[],
        ];

        if ((movementRows?.length ?? 0) === 0 || (variantRows?.length ?? 0) === 0) {
            throw new ConflictError("Stock changed concurrently before variant update could be saved");
        }

        await checkAndAlertLowStock(db, variantId);

        return { ...variantRows[0]!, aggregateRevision: result.aggregateRevision };
    }

    const variantUpdate = db
        .update(productVariants)
        .set(updateValues)
        .where(and(
            eq(productVariants.id, variantId),
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
        ))
        .returning();
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        data.expectedAggregateRevision,
        [variantUpdate],
    );
    const variant = (result.mutationResults[0] as PersistedVariant[] | undefined)?.[0];
    if (!variant) throw new NotFoundError("Variant not found");
    return { ...variant, aggregateRevision: result.aggregateRevision };
}

export async function deleteVariant(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    variantId: string,
    expectedAggregateRevision: number,
): Promise<ProductAggregateRevisionResult> {
    const existingVariant = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
            reservedStock: productVariants.reservedStock,
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

    if (existingVariant.reservedStock > 0) {
        throw new ConflictError("Cannot delete a SKU while stock is reserved for open orders.");
    }

    if (await variantHasOpenOrderReference(db, variantId)) {
        throw new ConflictError("Cannot delete a SKU while open orders still reference it.");
    }

    const product = await db
        .select({ isActive: products.isActive })
        .from(products)
        .where(eq(products.id, productId))
        .get();
    const remainingCustomerOptionCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            ne(productVariants.id, variantId),
            isNull(productVariants.deletedAt),
            customerOptionPredicate(),
        ))
        .get();
    if (product?.isActive && (remainingCustomerOptionCount?.count ?? 0) === 0) {
        throw new ValidationError("Add another customer option, or deactivate this product, before removing its final customer option.");
    }

    const deleteGuard = and(
        eq(productVariants.id, variantId),
        eq(productVariants.productId, productId),
        isNull(productVariants.deletedAt),
        eq(productVariants.reservedStock, 0),
    );

    const transactionalDeleteGuard = db.run(sql`
        SELECT CASE WHEN EXISTS (
            SELECT 1 FROM ${productVariants}
            WHERE ${productVariants.id} = ${variantId}
              AND ${productVariants.productId} = ${productId}
              AND ${productVariants.isDefault} = 0
              AND ${productVariants.reservedStock} = 0
              AND ${productVariants.deletedAt} IS NULL
        ) AND NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            INNER JOIN ${orders} ON ${orderItems.orderId} = ${orders.id}
            WHERE ${orderItems.variantId} = ${variantId}
              AND ${orders.deletedAt} IS NULL
              AND ${not(inArray(orders.status, ORDER_STATUSES_THAT_ALLOW_SKU_RETIREMENT))}
        ) AND (
            coalesce((
                SELECT ${products.isActive} FROM ${products}
                WHERE ${products.id} = ${productId}
            ), 0) = 0
            OR EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.productId} = ${productId}
                  AND ${productVariants.id} != ${variantId}
                  AND ${productVariants.deletedAt} IS NULL
                  AND ${customerOptionPredicate()}
            )
        ) THEN 1 ELSE json_extract('VARIANT_DELETE_CONFLICT', '$') END
    `);
    const deleteStatement = db
        .update(productVariants)
        .set({
            deletedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(deleteGuard)
        .returning({ id: productVariants.id });

    let result;
    try {
        result = await executeProductAggregateMutationBatch(
            db,
            productId,
            expectedAggregateRevision,
            [transactionalDeleteGuard, deleteStatement],
        );
    } catch (error) {
        if (isAtomicVariantConflict(error)) {
            throw new ConflictError(
                "The SKU can no longer be removed. Reload the latest product and try again.",
            );
        }
        throw error;
    }
    const affectedRows = result.mutationResults[1] as Array<{ id: string }> | undefined;

    if ((affectedRows?.length ?? 0) === 0) {
        throw new ConflictError("Variant changed before it could be deleted. Refresh and try again.");
    }
    return { aggregateRevision: result.aggregateRevision };
}

type PersistedVariant = typeof productVariants.$inferSelect;

const LOW_STOCK_RECONCILIATION_WAVE_SIZE = 5;

export async function reconcileVariantLowStockAlerts(
    db: DrizzleD1Database<typeof schema>,
    variantIds: string[],
): Promise<void> {
    const uniqueVariantIds = Array.from(new Set(variantIds));
    for (let index = 0; index < uniqueVariantIds.length; index += LOW_STOCK_RECONCILIATION_WAVE_SIZE) {
        const wave = uniqueVariantIds.slice(index, index + LOW_STOCK_RECONCILIATION_WAVE_SIZE);
        await Promise.allSettled(
            wave.map((variantId) => checkAndAlertLowStock(db, variantId)),
        );
    }
}

function firstValidationMessage(error: z.ZodError): string {
    return error.issues[0]?.message ?? "Variant edit plan is invalid";
}

function isAtomicVariantConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /constraint|unique|malformed json|variant_edit_conflict/i.test(message);
}

/**
 * Applies a mixed set of new and existing SKU edits in one D1 transaction.
 *
 * Validation happens before statement construction. Each write is deliberately
 * one row per statement so it remains comfortably below D1's 100-bound-
 * parameter ceiling, while safeBatch keeps the complete plan all-or-nothing.
 */
export async function applyVariantEditPlan(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    input: VariantEditPlan,
    adminUserId?: string,
): Promise<{
    created: PersistedVariant[];
    updated: PersistedVariant[];
    aggregateRevision: number;
}> {
    const parsed = variantEditPlanSchema.safeParse(input);
    if (!parsed.success) {
        throw new ValidationError(firstValidationMessage(parsed.error));
    }
    const plan = parsed.data;

    const updateIds = plan.updates.map((update) => update.id);
    if (new Set(updateIds).size !== updateIds.length) {
        throw new ValidationError("Each variant may appear only once in an edit plan.");
    }
    assertUniqueNormalizedValues(
        plan.creates.map((variant) => variant.sku),
        "Duplicate SKUs found in edit plan",
    );

    const product = await db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, productId), isNull(products.deletedAt)))
        .get();
    if (!product) throw new NotFoundError("Product not found");

    const currentVariants = await db
        .select()
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
        ));
    assertSimpleSkuTransitionStockAllocation(currentVariants, plan.creates);
    const currentById = new Map(currentVariants.map((variant) => [variant.id, variant]));

    for (const update of plan.updates) {
        const current = currentById.get(update.id);
        if (!current) throw new NotFoundError(`Variant ${update.id} was not found`);
        if (current.isDefault || !hasCustomerOption(current)) {
            throw new ValidationError(
                "The protected simple product SKU cannot be edited from the option spreadsheet.",
            );
        }
    }

    const effectiveVariants: Array<{
        id: string;
        isDefault: boolean;
        size: string | null;
        color: string | null;
        sku: string;
        barcode: string | null;
        barcodeType: BarcodeType | null;
    }> = currentVariants.map((variant) => ({
        id: variant.id,
        isDefault: variant.isDefault,
        size: normalizeOptionValue(variant.size),
        color: normalizeOptionValue(variant.color),
        sku: normalizeSku(variant.sku),
        barcode: variant.barcode,
        barcodeType: variant.barcodeType,
    }));
    const effectiveById = new Map(effectiveVariants.map((variant) => [variant.id, variant]));

    for (const update of plan.updates) {
        const effective = effectiveById.get(update.id)!;
        if ("size" in update) effective.size = normalizeOptionValue(update.size);
        if ("color" in update) effective.color = normalizeOptionValue(update.color);
        if ("sku" in update && update.sku) effective.sku = normalizeSku(update.sku);
        if ("barcode" in update) effective.barcode = normalizeBarcodeValue(update.barcode);
        if ("barcodeType" in update) effective.barcodeType = update.barcodeType ?? null;
        Object.assign(
            effective,
            normalizeVariantBarcode(effective.barcode, effective.barcodeType),
        );
        assertNormalVariantHasCustomerOption(effective);
    }

    const createsWithIds = plan.creates.map((variant) => {
        const barcodeIdentity = normalizeVariantBarcode(
            variant.barcode,
            variant.barcodeType,
        );
        return {
            ...variant,
            ...barcodeIdentity,
            id: `var_${nanoid()}`,
            size: normalizeOptionValue(variant.size),
            color: normalizeOptionValue(variant.color),
            sku: normalizeSku(variant.sku),
        };
    });
    effectiveVariants.push(...createsWithIds.map((variant) => ({
        id: variant.id,
        isDefault: false,
        size: variant.size,
        color: variant.color,
        sku: variant.sku,
        barcode: variant.barcode,
        barcodeType: variant.barcodeType,
    })));

    await assertUniqueVariantBarcodes(db, [
        ...createsWithIds.map((variant) => ({
            barcode: variant.barcode,
            barcodeType: variant.barcodeType,
        })),
        ...plan.updates.map((update) => {
            const effective = effectiveById.get(update.id)!;
            return {
                id: update.id,
                barcode: effective.barcode,
                barcodeType: effective.barcodeType,
            };
        }),
    ]);

    assertUniqueNormalizedValues(
        effectiveVariants.map((variant) => variant.sku),
        "Each active SKU must be unique",
    );
    const optionedVariants = effectiveVariants.filter((variant) => !variant.isDefault);
    optionedVariants.forEach(assertNormalVariantHasCustomerOption);
    assertConsistentVariantOptionAxes(optionedVariants);
    assertUniqueChangedVariantOptions(optionedVariants);

    const candidateSkuOwner = new Map<string, string | null>();
    const plannedUpdateSkuById = new Map(
        plan.updates.map((update) => [
            update.id,
            normalizedSkuKey(effectiveById.get(update.id)!.sku),
        ]),
    );
    for (const variant of createsWithIds) {
        candidateSkuOwner.set(normalizedSkuKey(variant.sku), null);
    }
    for (const update of plan.updates) {
        if ("sku" in update && update.sku) {
            candidateSkuOwner.set(normalizedSkuKey(update.sku), update.id);
        }
    }
    const candidateSkuKeys = Array.from(candidateSkuOwner.keys());
    if (candidateSkuKeys.length > 0) {
        const matchingSkuRows = await db
            .select({ id: productVariants.id, sku: productVariants.sku })
            .from(productVariants)
            .where(sql`lower(trim(${productVariants.sku})) IN (
                SELECT CAST(value AS TEXT)
                FROM json_each(${JSON.stringify(candidateSkuKeys)})
            )`);
        const collision = matchingSkuRows.find((row) => {
            const currentKey = normalizedSkuKey(row.sku);
            const plannedKey = plannedUpdateSkuById.get(row.id);
            if (plannedKey !== undefined && plannedKey !== currentKey) {
                return false;
            }
            return candidateSkuOwner.get(currentKey) !== row.id;
        });
        if (collision) {
            throw new ConflictError(`SKU ${collision.sku} is already in use.`);
        }
    }

    const statements = [];
    const createResultIndices: number[] = [];
    const updateResultIndices: number[] = [];
    const movementResultIndices: number[] = [];
    const stockChangedVariantIds: string[] = [];

    // Validate every optimistic version inside the transaction before its first
    // write. The false branch intentionally raises a SQLite JSON error, which
    // makes D1 roll the whole batch back instead of accepting a zero-row CAS.
    for (const update of plan.updates) {
        const current = currentById.get(update.id)!;
        const stockChanged = update.stock !== undefined && update.stock !== current.stock;
        statements.push(db.run(sql`
            SELECT CASE WHEN EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.id} = ${update.id}
                  AND ${productVariants.productId} = ${productId}
                  AND ${productVariants.deletedAt} IS NULL
                  AND ${productVariants.version} = ${current.version}
                  ${stockChanged
                    ? sql`AND ${productVariants.stockVersion} = ${current.stockVersion}`
                    : sql``}
            ) THEN 1 ELSE json_extract('VARIANT_EDIT_CONFLICT', '$') END
        `));
    }

    // SQLite unique constraints are immediate. Move edited SKU values to
    // transaction-private placeholders first so swaps and reuse of an edited-
    // away SKU remain atomic without a transient uniqueness failure.
    for (const update of plan.updates) {
        const current = currentById.get(update.id)!;
        if (update.sku === undefined || normalizeSku(update.sku) === current.sku) continue;
        statements.push(
            db.update(productVariants)
                .set({ sku: `__variant_edit_${update.id}_${nanoid()}` })
                .where(and(
                    eq(productVariants.id, update.id),
                    eq(productVariants.productId, productId),
                    isNull(productVariants.deletedAt),
                ))
                .returning({ id: productVariants.id }),
        );
    }

    for (const variant of createsWithIds) {
        const hasInitialStock = variant.stock > 0;
        const insertIndex = statements.length;
        statements.push(
            db.insert(productVariants).values({
                id: variant.id,
                productId,
                size: variant.size,
                color: variant.color,
                weight: variant.weight ?? null,
                sku: variant.sku,
                price: variant.price,
                stock: hasInitialStock ? 0 : variant.stock,
                reservedStock: 0,
                preorderStock: 0,
                isDefault: false,
                trackInventory: variant.trackInventory ?? true,
                version: 1,
                stockVersion: 1,
                allowPreorder: false,
                allowBackorder: false,
                backorderLimit: 0,
                barcode: variant.barcode,
                barcodeType: variant.barcodeType,
                discountType: variant.discountType,
                discountPercentage: variant.discountPercentage ?? 0,
                discountAmount: variant.discountAmount ?? 0,
                colorSortOrder: variant.colorSortOrder ?? 0,
                sizeSortOrder: variant.sizeSortOrder ?? 0,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }).returning(),
        );
        if (hasInitialStock) {
            movementResultIndices.push(statements.length);
            statements.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: variant.id,
                pool: "regular",
                quantity: variant.stock,
                before: {
                    stock: 0,
                    reservedStock: 0,
                    preorderStock: 0,
                    stockVersion: 1,
                },
                after: {
                    stock: variant.stock,
                    reservedStock: 0,
                    preorderStock: 0,
                    stockVersion: 2,
                },
                notes: "Stocktake: Initial product variant stock",
                adminUserId,
            }));
            createResultIndices.push(statements.length);
            statements.push(
                db.update(productVariants)
                    .set({
                        stock: variant.stock,
                        stockVersion: sql`${productVariants.stockVersion} + 1`,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(and(
                        eq(productVariants.id, variant.id),
                        eq(productVariants.productId, productId),
                        eq(productVariants.stockVersion, 1),
                        isNull(productVariants.deletedAt),
                    ))
                    .returning(),
            );
            // New option SKUs cannot configure a low-stock threshold in this
            // create contract, so there is no alert lifecycle to reconcile.
        } else {
            createResultIndices.push(insertIndex);
        }
    }

    for (const update of plan.updates) {
        const current = currentById.get(update.id)!;
        const effective = effectiveById.get(update.id)!;
        const stockChanged = update.stock !== undefined && update.stock !== current.stock;

        if (stockChanged) {
            movementResultIndices.push(statements.length);
            statements.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: update.id,
                pool: "regular",
                quantity: update.stock! - current.stock,
                before: {
                    stock: current.stock,
                    reservedStock: current.reservedStock,
                    preorderStock: current.preorderStock,
                    stockVersion: current.stockVersion,
                },
                after: {
                    stock: update.stock!,
                    reservedStock: current.reservedStock,
                    preorderStock: current.preorderStock,
                    stockVersion: current.stockVersion + 1,
                },
                notes: "Stocktake: Product variant edit plan",
                adminUserId,
            }));
            stockChangedVariantIds.push(update.id);
        }

        const updateValues = {
            ...(update.size !== undefined ? { size: normalizeOptionValue(update.size) } : {}),
            ...(update.color !== undefined ? { color: normalizeOptionValue(update.color) } : {}),
            ...(update.weight !== undefined ? { weight: update.weight } : {}),
            ...(update.sku !== undefined ? { sku: normalizeSku(update.sku) } : {}),
            ...(update.price !== undefined ? { price: update.price } : {}),
            ...(update.stock !== undefined ? { stock: update.stock } : {}),
            ...(update.trackInventory !== undefined ? { trackInventory: update.trackInventory } : {}),
            ...(update.barcode !== undefined || update.barcodeType !== undefined
                ? {
                    barcode: effective.barcode,
                    barcodeType: effective.barcodeType,
                }
                : {}),
            version: sql`${productVariants.version} + 1`,
            ...(stockChanged
                ? { stockVersion: sql`${productVariants.stockVersion} + 1` }
                : {}),
            updatedAt: sql`unixepoch()`,
        };
        updateResultIndices.push(statements.length);
        statements.push(
            db.update(productVariants)
                .set(updateValues)
                .where(and(
                    eq(productVariants.id, update.id),
                    eq(productVariants.productId, productId),
                    isNull(productVariants.deletedAt),
                ))
                .returning(),
        );
    }

    let results: Array<Array<PersistedVariant | { id: string }> | undefined>;
    let aggregateRevision: number;
    try {
        const aggregateResult = await executeProductAggregateMutationBatch(
            db,
            productId,
            plan.expectedAggregateRevision,
            statements,
        );
        results = aggregateResult.mutationResults as typeof results;
        aggregateRevision = aggregateResult.aggregateRevision;
    } catch (error) {
        if (isAtomicVariantConflict(error)) {
            throw new ConflictError(
                "One or more SKUs changed while you were editing. Review the latest values and try again.",
            );
        }
        throw error;
    }

    const created = createResultIndices.map((index) => results[index]?.[0] as PersistedVariant | undefined);
    const updated = updateResultIndices.map((index) => results[index]?.[0] as PersistedVariant | undefined);
    const hasMissingResult = [...created, ...updated].some((row) => !row)
        || movementResultIndices.some((index) => (results[index]?.length ?? 0) === 0);
    if (hasMissingResult) {
        // All guarded writes should return one row. Reaching this branch means
        // the storage adapter violated the D1 batch response contract.
        throw new ConflictError("The variant edit could not be confirmed. Reload and try again.");
    }

    // Alert reconciliation is secondary to the authoritative stock transaction.
    // Do not report the edit as failed after its D1 batch has already committed.
    await reconcileVariantLowStockAlerts(db, stockChangedVariantIds);

    return {
        created: created as PersistedVariant[],
        updated: updated as PersistedVariant[],
        aggregateRevision,
    };
}

export async function bulkCreateVariants(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    variants: z.infer<typeof bulkVariantSchema>[],
    expectedAggregateRevision: number,
): Promise<{
    variants: PersistedVariant[];
    aggregateRevision: number;
}> {
    variants.forEach(assertNormalVariantHasCustomerOption);
    assertConsistentVariantOptionAxes(variants);
    variants.forEach((variant) => {
        normalizeVariantBarcode(variant.barcode, variant.barcodeType);
    });
    const result = await applyVariantEditPlan(
        db,
        productId,
        {
            creates: variants,
            updates: [],
            expectedAggregateRevision,
        },
    );
    return {
        variants: result.created,
        aggregateRevision: result.aggregateRevision,
    };
}

export async function bulkDeleteVariants(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    variantIds: string[],
    expectedAggregateRevision: number,
): Promise<ProductAggregateRevisionResult> {
    const ids = uniqueVariantIds(variantIds);
    if (ids.length === 0) throw new ValidationError("No variant IDs provided");

    const variantsToDelete = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
            reservedStock: productVariants.reservedStock,
        })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            inArray(productVariants.id, ids),
            isNull(productVariants.deletedAt),
        ));
    const foundIds = new Set(variantsToDelete.map((variant) => variant.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
        throw new NotFoundError("Variant not found");
    }

    const protectedVariant = variantsToDelete.find((variant) => variant.isDefault);
    if (protectedVariant) {
        throw new ValidationError("The protected simple product SKU cannot be deleted from the generic option editor.");
    }

    const reservedVariant = variantsToDelete.find((variant) => variant.reservedStock > 0);
    if (reservedVariant) {
        throw new ConflictError("Cannot delete SKUs while stock is reserved for open orders.");
    }

    const openOrderBackedVariantIds = await loadOpenOrderBackedVariantIds(db, ids);
    if (openOrderBackedVariantIds.size > 0) {
        throw new ConflictError("Cannot delete SKUs while open orders still reference them.");
    }

    const product = await db
        .select({ isActive: products.isActive })
        .from(products)
        .where(eq(products.id, productId))
        .get();
    const remainingCustomerOptionCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            not(inArray(productVariants.id, ids)),
            isNull(productVariants.deletedAt),
            customerOptionPredicate(),
        ))
        .get();
    if (product?.isActive && (remainingCustomerOptionCount?.count ?? 0) === 0) {
        throw new ValidationError("Add another customer option, or deactivate this product, before removing the final customer option.");
    }

    const idSet = JSON.stringify(ids);
    const transactionalDeleteGuard = db.run(sql`
        SELECT CASE WHEN (
            SELECT count(*) FROM ${productVariants}
            WHERE ${productVariants.productId} = ${productId}
              AND ${productVariants.id} IN (
                  SELECT CAST(value AS TEXT) FROM json_each(${idSet})
              )
              AND ${productVariants.isDefault} = 0
              AND ${productVariants.reservedStock} = 0
              AND ${productVariants.deletedAt} IS NULL
        ) = ${ids.length} AND NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            INNER JOIN ${orders} ON ${orderItems.orderId} = ${orders.id}
            WHERE ${orderItems.variantId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            )
              AND ${orders.deletedAt} IS NULL
              AND ${not(inArray(orders.status, ORDER_STATUSES_THAT_ALLOW_SKU_RETIREMENT))}
        ) AND (
            coalesce((
                SELECT ${products.isActive} FROM ${products}
                WHERE ${products.id} = ${productId}
            ), 0) = 0
            OR EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.productId} = ${productId}
                  AND ${productVariants.id} NOT IN (
                      SELECT CAST(value AS TEXT) FROM json_each(${idSet})
                  )
                  AND ${productVariants.deletedAt} IS NULL
                  AND ${customerOptionPredicate()}
            )
        ) THEN 1 ELSE json_extract('VARIANT_DELETE_CONFLICT', '$') END
    `);
    const deleteStatement = db
        .update(productVariants)
        .set({
            deletedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(productVariants.productId, productId),
            sql`${productVariants.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            )`,
            isNull(productVariants.deletedAt),
            eq(productVariants.reservedStock, 0),
        ))
        .returning({ id: productVariants.id });

    let aggregateResult;
    try {
        aggregateResult = await executeProductAggregateMutationBatch(
            db,
            productId,
            expectedAggregateRevision,
            [transactionalDeleteGuard, deleteStatement],
        );
    } catch (error) {
        if (isAtomicVariantConflict(error)) {
            throw new ConflictError(
                "One or more SKUs can no longer be removed. Reload the latest product and try again.",
            );
        }
        throw error;
    }
    const affectedRows = aggregateResult.mutationResults[1] as Array<{ id: string }> | undefined;
    const affectedCount = affectedRows?.length ?? 0;
    if (affectedCount !== ids.length) {
        throw new ConflictError("One or more variants changed before they could be deleted. Refresh and try again.");
    }
    return { aggregateRevision: aggregateResult.aggregateRevision };
}

export async function getVariantSortOrder(db: DrizzleD1Database<typeof schema>, productId: string) {
    const variants = await db
        .select({
            color: productVariants.color,
            size: productVariants.size,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
            isDefault: productVariants.isDefault,
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

    variants.forEach((variant: { color: string | null; size: string | null; colorSortOrder: number | null; sizeSortOrder: number | null; isDefault: boolean }) => {
        if (variant.isDefault) return;
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

export async function updateVariantSortOrder(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    data: z.infer<typeof updateSortOrderSchema>,
): Promise<ProductAggregateRevisionResult> {
    const batchOps = [];

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

    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        data.expectedAggregateRevision,
        batchOps,
    );
    return { aggregateRevision: result.aggregateRevision };
}
