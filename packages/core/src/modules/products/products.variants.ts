// src/modules/products/products.variants.ts
// Variant-specific queries and mutations + barcode lookup.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { buildBatchGuard } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import {
    orders,
    orderItems,
    OrderStatus,
    products,
    productVariants,
    productVariantOptionValues,
    productMedia,
    media,
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
} from "./products.types";
import {
    operationalSkuRowPredicate,
} from "./products.public-eligibility";
import {
    generateInternalCode128Barcode,
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
import {
    loadVariantSelectedOptions,
    resolveSelectedOptionValueIds,
} from "./products.option-model";

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

function hasCustomerOption(value: {
    selectedOptionValueIds?: readonly string[];
    optionCombinationKey?: string | null;
}): boolean {
    return Boolean(value.selectedOptionValueIds?.length || value.optionCombinationKey?.trim());
}

const ORDER_STATUSES_THAT_ALLOW_SKU_RETIREMENT = [
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
];

export function assertConsistentVariantOptionAxes(
    variants: Array<{ selectedOptionValueIds?: readonly string[]; optionCombinationKey?: string | null }>,
) {
    if (variants.some((variant) => !hasCustomerOption(variant))) {
        throw new ValidationError("Every option SKU must select one value for every active product option.");
    }
}

type TransitionSku = {
    isDefault?: boolean;
    optionCombinationKey?: string | null;
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

function normalizeSku(value: string): string {
    return value.trim();
}

function normalizedSkuKey(value: string): string {
    return normalizeSku(value).toLocaleLowerCase("en-US");
}

async function assertSelectableVariantImage(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    imageId: string | null,
    retainedImageId: string | null = null,
): Promise<void> {
    if (!imageId) return;
    const association = await db
        .select({ status: media.status })
        .from(productMedia)
        .innerJoin(media, eq(media.id, productMedia.mediaId))
        .where(and(
            eq(productMedia.id, imageId),
            eq(productMedia.productId, productId),
            eq(media.kind, "image"),
        ))
        .get();
    const retainedTrash = imageId === retainedImageId && association?.status === "trashed";
    if (!association || (association.status !== "ready" && !retainedTrash)) {
        throw new ValidationError("The selected SKU image must be a ready image attached to this product.");
    }
}

function isAtomicVariantConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /constraint|unique|malformed json|variant_edit_conflict/i.test(message);
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

/**
 * New SKU rows receive a platform-owned Code 128 scan identity when the
 * merchant did not provide a retail or custom barcode. Existing SKU updates
 * deliberately continue to use normalizeVariantBarcode() so clearing a saved
 * barcode remains an explicit, durable choice.
 */
export function resolveNewVariantBarcode(
    variantId: string,
    barcode: string | null | undefined,
    barcodeType: BarcodeType | null | undefined,
): { barcode: string; barcodeType: BarcodeType } {
    const normalized = normalizeVariantBarcode(barcode, barcodeType);
    if (normalized.barcode && normalized.barcodeType) {
        return {
            barcode: normalized.barcode,
            barcodeType: normalized.barcodeType,
        };
    }
    return {
        barcode: generateInternalCode128Barcode(variantId),
        barcodeType: "code128",
    };
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

export function assertUniqueChangedVariantOptions(
    changedVariants: Array<{ optionCombinationKey: string }>,
    existingVariants: Array<{ optionCombinationKey: string | null }> = [],
): void {
    const changedKeys = changedVariants.map((variant) => variant.optionCombinationKey);
    if (new Set(changedKeys).size !== changedKeys.length) {
        throw new ValidationError(
            "Each active SKU must use a unique option combination.",
        );
    }

    const existingKeys = new Set(existingVariants.flatMap((variant) =>
        variant.optionCombinationKey ? [variant.optionCombinationKey] : []
    ));
    if (changedKeys.some((key) => existingKeys.has(key))) {
        throw new ConflictError(
            "An active SKU already uses this option combination.",
        );
    }
}

export async function assertProductVariantOptionAxes(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    changedVariants: Array<{ id?: string; selectedOptionValueIds: string[] }>,
    excludedVariantIds: string[] = [],
) {
    const resolved = await Promise.all(changedVariants.map((variant) =>
        resolveSelectedOptionValueIds(db, productId, variant.selectedOptionValueIds)
    ));
    const changedKeys = resolved.map((item) => ({ optionCombinationKey: item.combinationKey }));
    assertUniqueChangedVariantOptions(changedKeys);

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
            optionCombinationKey: productVariants.optionCombinationKey,
        })
        .from(productVariants)
        .where(and(...conditions));

    assertUniqueChangedVariantOptions(changedKeys, existingVariants);
}

function assertNormalVariantHasCustomerOption(value: { selectedOptionValueIds?: readonly string[]; optionCombinationKey?: string | null }) {
    if (!hasCustomerOption(value)) {
        throw new ValidationError("Add at least one customer option. Products without options use the built-in simple SKU.");
    }
}

function customerOptionPredicate() {
    return sql`trim(coalesce(${productVariants.optionCombinationKey}, '')) <> ''`;
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
            variantImageId: productVariants.imageId,
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

    const selectedOptions = (await loadVariantSelectedOptions(db, [variant.variantId]))
        .get(variant.variantId) ?? [];

    return {
        variant: {
            id: variant.variantId,
            sku: variant.variantSku,
            imageId: variant.variantImageId,
            selectedOptions,
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
    const variants = await db.select()
        .from(productVariants)
        .where(
            sql`${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
        )
        .orderBy(productVariants.createdAt);
    const selectedOptionsByVariant = await loadVariantSelectedOptions(
        db,
        variants.map((variant) => variant.id),
    );
    return variants.map((variant) => ({
        ...variant,
        selectedOptions: selectedOptionsByVariant.get(variant.id) ?? [],
    }));
}

export async function createVariant(
    db: DrizzleD1Database<typeof schema>,
    productId: string,
    data: z.infer<typeof createVariantSchema>,
): Promise<PersistedVariant & ProductAggregateRevisionResult> {
    assertNormalVariantHasCustomerOption(data);
    const selection = await resolveSelectedOptionValueIds(
        db,
        productId,
        data.selectedOptionValueIds,
    );
    const sku = normalizeSku(data.sku);
    const skuKey = normalizedSkuKey(sku);
    const variantId = `var_${nanoid()}`;
    const barcodeIdentity = resolveNewVariantBarcode(variantId, data.barcode, data.barcodeType);
    const currentVariants = await db
        .select({
            isDefault: productVariants.isDefault,
            optionCombinationKey: productVariants.optionCombinationKey,
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
    await assertProductVariantOptionAxes(db, productId, [{ selectedOptionValueIds: selection.valueIds }]);
    await assertUniqueVariantBarcodes(db, [{ ...barcodeIdentity }]);

    await assertSelectableVariantImage(db, productId, data.imageId);

    const existingVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`lower(trim(${productVariants.sku})) = ${skuKey}`)
        .get();

    if (existingVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const variantValues = {
        id: variantId,
        productId,
        optionCombinationKey: selection.combinationKey,
        imageId: data.imageId,
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
    const assignmentInserts = selection.assignments.map((assignment) =>
        db.insert(productVariantOptionValues).values({
            variantId,
            optionDefinitionId: assignment.optionDefinitionId,
            optionValueId: assignment.optionValueId,
        })
    );
    if (data.stock === 0) {
        const result = await executeProductAggregateMutationBatch(
            db,
            productId,
            data.expectedAggregateRevision,
            [insert, ...assignmentInserts],
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
        [insert, ...assignmentInserts, movement, update],
    );
    const movementRows = result.mutationResults[1 + assignmentInserts.length] as Array<{ id: string }>;
    const updatedRows = result.mutationResults[2 + assignmentInserts.length] as PersistedVariant[];
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
            optionCombinationKey: productVariants.optionCombinationKey,
            imageId: productVariants.imageId,
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

    const existingIsSimpleSku = existingVariant.isDefault;
    const selection = existingIsSimpleSku
        ? { valueIds: [], combinationKey: null, assignments: [] }
        : await resolveSelectedOptionValueIds(db, productId, data.selectedOptionValueIds);
    if (existingIsSimpleSku) {
        if (data.selectedOptionValueIds.length > 0) {
            throw new ValidationError("The simple product SKU cannot be turned into an option. Add a new variant instead.");
        }
    } else {
        assertNormalVariantHasCustomerOption(data);
        await assertProductVariantOptionAxes(
            db,
            productId,
            [{ id: variantId, selectedOptionValueIds: selection.valueIds }],
            [variantId],
        );
    }

    await assertSelectableVariantImage(
        db,
        productId,
        data.imageId,
        existingVariant.imageId,
    );

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
        optionCombinationKey: selection.combinationKey,
        imageId: data.imageId,
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
    const assignmentStatements = existingIsSimpleSku
        ? []
        : [
            db.delete(productVariantOptionValues).where(eq(productVariantOptionValues.variantId, variantId)),
            ...selection.assignments.map((assignment) =>
                db.insert(productVariantOptionValues).values({
                    variantId,
                    optionDefinitionId: assignment.optionDefinitionId,
                    optionValueId: assignment.optionValueId,
                })
            ),
        ];

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
        const stockGuard = buildBatchGuard(db, sql`
            CASE WHEN EXISTS (
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
                [stockGuard, ...assignmentStatements, movementInsert, variantUpdate],
            );
        } catch (error) {
            if (isAtomicVariantConflict(error)) {
                throw new ConflictError(
                    "Stock changed concurrently before the SKU could be saved. Reload and try again.",
                );
            }
            throw error;
        }
        const movementRows = result.mutationResults[1 + assignmentStatements.length] as Array<{ id: string }>;
        const variantRows = result.mutationResults[2 + assignmentStatements.length] as PersistedVariant[];

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
        [...assignmentStatements, variantUpdate],
    );
    const variant = (result.mutationResults[assignmentStatements.length] as PersistedVariant[] | undefined)?.[0];
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

    const transactionalDeleteGuard = buildBatchGuard(db, sql`
        CASE WHEN EXISTS (
            SELECT 1 FROM ${productVariants}
            WHERE ${productVariants.id} = ${variantId}
              AND ${productVariants.productId} = ${productId}
              AND ${productVariants.isDefault} = 0
              AND ${productVariants.reservedStock} = 0
              AND ${productVariants.deletedAt} IS NULL
        ) AND NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            INNER JOIN ${orders}
              ON ${sql.raw('"order_items"."order_id"')} = ${sql.raw('"orders"."id"')}
            WHERE ${sql.raw('"order_items"."variant_id"')} = ${variantId}
              AND ${sql.raw('"orders"."deleted_at"')} IS NULL
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
