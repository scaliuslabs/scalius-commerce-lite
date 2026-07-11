// src/modules/products/products.variants.ts
// Variant-specific queries and mutations + barcode lookup.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import {
    inventoryMovements,
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
import { safeBatch } from "@scalius/database/client";
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
import { normalizeDefaultSkuOptions } from "./products.public-eligibility";
import { classifyProductVariantOptionAxes } from "@scalius/shared/product-options";

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

async function variantHasOrderOrInventoryHistory(db: DrizzleD1Database<typeof schema>, variantId: string): Promise<boolean> {
    const orderReference = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderItems)
        .where(eq(orderItems.variantId, variantId))
        .get();
    if ((orderReference?.count ?? 0) > 0) return true;

    const movementReference = await db
        .select({ count: sql<number>`count(*)` })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.variantId, variantId))
        .get();

    return (movementReference?.count ?? 0) > 0;
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

async function loadHistoryBackedVariantIds(db: DrizzleD1Database<typeof schema>, variantIds: string[]): Promise<Set<string>> {
    const [orderReferences, movementReferences] = await Promise.all([
        db
            .select({ variantId: orderItems.variantId })
            .from(orderItems)
            .where(inArray(orderItems.variantId, variantIds))
            .groupBy(orderItems.variantId),
        db
            .select({ variantId: inventoryMovements.variantId })
            .from(inventoryMovements)
            .where(inArray(inventoryMovements.variantId, variantIds))
            .groupBy(inventoryMovements.variantId),
    ]);

    return new Set(
        [...orderReferences, ...movementReferences]
            .map((row) => row.variantId)
            .filter((id): id is string => Boolean(id)),
    );
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
                eq(productVariants.barcode, barcode),
                isNull(productVariants.deletedAt),
                isNull(products.deletedAt),
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

export async function createVariant(db: DrizzleD1Database<typeof schema>, productId: string, data: z.infer<typeof createVariantSchema>) {
    assertNormalVariantHasCustomerOption(data);
    const size = normalizeOptionValue(data.size);
    const color = normalizeOptionValue(data.color);
    await assertProductVariantOptionAxes(db, productId, [{ size, color }]);

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
        await assertProductVariantOptionAxes(db, productId, [{ id: variantId, size, color }], [variantId]);
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

        await checkAndAlertLowStock(db, variantId);

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

    const hasHistory = await variantHasOrderOrInventoryHistory(db, variantId);
    const deleteGuard = and(
        eq(productVariants.id, variantId),
        eq(productVariants.productId, productId),
        isNull(productVariants.deletedAt),
        eq(productVariants.reservedStock, 0),
    );

    const affectedRows = hasHistory
        ? await db
            .update(productVariants)
            .set({
                deletedAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })
            .where(deleteGuard)
            .returning({ id: productVariants.id })
        : await db
            .delete(productVariants)
            .where(deleteGuard)
            .returning({ id: productVariants.id });

    if ((affectedRows?.length ?? 0) === 0) {
        throw new ConflictError("Variant changed before it could be deleted. Refresh and try again.");
    }
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
        throw new ValidationError("The simple product SKU cannot be duplicated as a normal option. Add a customer option instead.");
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

type PersistedVariant = typeof productVariants.$inferSelect;

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
): Promise<{ created: PersistedVariant[]; updated: PersistedVariant[] }> {
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
    }> = currentVariants.map((variant) => ({
        id: variant.id,
        isDefault: variant.isDefault,
        size: normalizeOptionValue(variant.size),
        color: normalizeOptionValue(variant.color),
        sku: normalizeSku(variant.sku),
    }));
    const effectiveById = new Map(effectiveVariants.map((variant) => [variant.id, variant]));

    for (const update of plan.updates) {
        const effective = effectiveById.get(update.id)!;
        if ("size" in update) effective.size = normalizeOptionValue(update.size);
        if ("color" in update) effective.color = normalizeOptionValue(update.color);
        if ("sku" in update && update.sku) effective.sku = normalizeSku(update.sku);
        assertNormalVariantHasCustomerOption(effective);
    }

    const createsWithIds = plan.creates.map((variant) => ({
        ...variant,
        id: `var_${nanoid()}`,
        size: normalizeOptionValue(variant.size),
        color: normalizeOptionValue(variant.color),
        sku: normalizeSku(variant.sku),
    }));
    effectiveVariants.push(...createsWithIds.map((variant) => ({
        id: variant.id,
        isDefault: false,
        size: variant.size,
        color: variant.color,
        sku: variant.sku,
    })));

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
            .where(and(
                isNull(productVariants.deletedAt),
                sql`lower(trim(${productVariants.sku})) IN (
                    SELECT CAST(value AS TEXT)
                    FROM json_each(${JSON.stringify(candidateSkuKeys)})
                )`,
            ));
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
        createResultIndices.push(statements.length);
        statements.push(
            db.insert(productVariants).values({
                id: variant.id,
                productId,
                size: variant.size,
                color: variant.color,
                weight: variant.weight ?? null,
                sku: variant.sku,
                price: variant.price,
                stock: variant.stock,
                reservedStock: 0,
                preorderStock: 0,
                isDefault: false,
                trackInventory: variant.trackInventory ?? true,
                version: 1,
                stockVersion: 1,
                allowPreorder: false,
                allowBackorder: false,
                backorderLimit: 0,
                barcode: variant.barcode || null,
                barcodeType: variant.barcodeType || null,
                discountType: variant.discountType,
                discountPercentage: variant.discountPercentage ?? 0,
                discountAmount: variant.discountAmount ?? 0,
                colorSortOrder: variant.colorSortOrder ?? 0,
                sizeSortOrder: variant.sizeSortOrder ?? 0,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }).returning(),
        );
        if (variant.stock > 0) {
            movementResultIndices.push(statements.length);
            statements.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: variant.id,
                stockVersion: 1,
                quantity: variant.stock,
                previousStock: 0,
                newStock: variant.stock,
                notes: "Stocktake: Initial product variant stock",
                adminUserId,
            }));
            stockChangedVariantIds.push(variant.id);
        }
    }

    for (const update of plan.updates) {
        const current = currentById.get(update.id)!;
        const stockChanged = update.stock !== undefined && update.stock !== current.stock;

        if (stockChanged) {
            movementResultIndices.push(statements.length);
            statements.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: update.id,
                stockVersion: current.stockVersion,
                quantity: update.stock! - current.stock,
                previousStock: current.stock,
                newStock: update.stock!,
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
            ...(update.barcode !== undefined ? { barcode: update.barcode || null } : {}),
            ...(update.barcodeType !== undefined ? { barcodeType: update.barcodeType } : {}),
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
    try {
        results = await safeBatch(db, statements as never) as typeof results;
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
    await Promise.allSettled(
        Array.from(new Set(stockChangedVariantIds)).map((variantId) =>
            checkAndAlertLowStock(db, variantId)
        ),
    );

    return {
        created: created as PersistedVariant[],
        updated: updated as PersistedVariant[],
    };
}

export async function bulkCreateVariants(db: DrizzleD1Database<typeof schema>, productId: string, variants: z.infer<typeof bulkVariantSchema>[]) {
    variants.forEach(assertNormalVariantHasCustomerOption);
    await assertProductVariantOptionAxes(
        db,
        productId,
        variants.map((variant) => ({
            size: normalizeOptionValue(variant.size),
            color: normalizeOptionValue(variant.color),
        })),
    );

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

    // D1 has a 100 bound parameter limit per query.
    // Each variant has ~22 params, so max 4 per chunk (4 × 22 = 88 < 100).
    const chunkSize = 4;
    const insertStatements = [];
    for (let i = 0; i < variantsToCreate.length; i += chunkSize) {
        const chunk = variantsToCreate.slice(i, i + chunkSize);
        insertStatements.push(
            db
                .insert(productVariants)
                .values(chunk)
                .returning(),
        );
    }

    // D1 batch is transactional: every chunk is committed together or none is.
    // Executing chunks one-by-one leaves an earlier chunk persisted if a later
    // insert encounters a concurrent SKU conflict.
    const results = await safeBatch(db, insertStatements as never) as Array<
        Array<typeof productVariants.$inferSelect> | undefined
    >;
    return results.flatMap((rows) => rows ?? []);
}

export async function bulkDeleteVariants(db: DrizzleD1Database<typeof schema>, productId: string, variantIds: string[]) {
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

    const historyBackedVariantIds = await loadHistoryBackedVariantIds(db, ids);
    const softDeleteIds = ids.filter((id) => historyBackedVariantIds.has(id));
    const hardDeleteIds = ids.filter((id) => !historyBackedVariantIds.has(id));
    const statements = [];

    if (softDeleteIds.length > 0) {
        statements.push(
            db
                .update(productVariants)
                .set({
                    deletedAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(productVariants.productId, productId),
                    inArray(productVariants.id, softDeleteIds),
                    isNull(productVariants.deletedAt),
                    eq(productVariants.reservedStock, 0),
                ))
                .returning({ id: productVariants.id }),
        );
    }

    if (hardDeleteIds.length > 0) {
        statements.push(
            db
                .delete(productVariants)
                .where(and(
                    eq(productVariants.productId, productId),
                    inArray(productVariants.id, hardDeleteIds),
                    isNull(productVariants.deletedAt),
                    eq(productVariants.reservedStock, 0),
                ))
                .returning({ id: productVariants.id }),
        );
    }

    const results = statements.length > 0
        ? await safeBatch(db, statements as never) as Array<Array<{ id: string }> | undefined>
        : [];
    const affectedCount = results.reduce((count, rows) => count + (rows?.length ?? 0), 0);
    if (affectedCount !== ids.length) {
        throw new ConflictError("One or more variants changed before they could be deleted. Refresh and try again.");
    }
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
