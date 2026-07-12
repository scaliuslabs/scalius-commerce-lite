import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { buildBatchGuard, type Database } from "@scalius/database/client";
import {
    orderItems,
    orders,
    OrderStatus,
    productImages,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
    productVariants,
    products,
} from "@scalius/database/schema";
import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
    MAX_PRODUCT_OPTION_AXES,
    MAX_PRODUCT_OPTION_COMBINATIONS,
    normalizeOptionIdentity,
} from "./products.option-model";
import { MAX_PRODUCT_PRICE, expectedProductAggregateRevisionSchema } from "./products.types";
import {
    normalizeVariantBarcode,
    assertUniqueVariantBarcodes,
    reconcileVariantLowStockAlerts,
} from "./products.variants";
import { executeProductAggregateMutationBatch } from "./products.aggregate-revision";
import { buildStockMovementClaim } from "../inventory/stock-movement-claims";

const optionValueInputSchema = z.object({
    id: z.string().trim().min(1),
    value: z.string().trim().min(1).max(100),
});

const optionDefinitionInputSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(40),
    standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
    values: z.array(optionValueInputSchema).min(1).max(MAX_PRODUCT_OPTION_COMBINATIONS),
});

const matrixVariantInputSchema = z.object({
    id: z.string().trim().min(1),
    selectedOptionValueIds: z.array(z.string().trim().min(1))
        .min(1)
        .max(MAX_PRODUCT_OPTION_AXES),
    imageId: z.string().trim().min(1).nullable(),
    sku: z.string().trim().min(3).max(100),
    price: z.number().min(0).max(MAX_PRODUCT_PRICE),
    stock: z.number().int().min(0),
    trackInventory: z.boolean(),
    weight: z.number().min(0).nullable(),
    barcode: z.string().trim().max(50).nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).nullable(),
    discountType: z.enum(["percentage", "flat"]),
    discountPercentage: z.number().min(0).max(100).nullable(),
    discountAmount: z.number().min(0).max(MAX_PRODUCT_PRICE).nullable(),
});

const productOptionMatrixBaseSchema = z.object({
    options: z.array(optionDefinitionInputSchema).min(1).max(MAX_PRODUCT_OPTION_AXES),
    variants: z.array(matrixVariantInputSchema).min(1).max(MAX_PRODUCT_OPTION_COMBINATIONS),
});

function validateOptionMatrix(
    input: z.infer<typeof productOptionMatrixBaseSchema>,
    ctx: z.RefinementCtx,
) {
    const optionNames = new Set<string>();
    const standardMappings = new Set<string>();
    const definitionIds = new Set<string>();
    const valueOwner = new Map<string, string>();

    input.options.forEach((option, optionIndex) => {
        const normalizedName = normalizeOptionIdentity(option.name);
        if (optionNames.has(normalizedName)) {
            ctx.addIssue({
                code: "custom",
                message: "Each product option needs a unique name.",
                path: ["options", optionIndex, "name"],
            });
        }
        optionNames.add(normalizedName);
        if (option.standardMapping !== "none") {
            if (standardMappings.has(option.standardMapping)) {
                ctx.addIssue({
                    code: "custom",
                    message: `Only one product option can map to ${option.standardMapping}.`,
                    path: ["options", optionIndex, "standardMapping"],
                });
            }
            standardMappings.add(option.standardMapping);
        }
        if (definitionIds.has(option.id)) {
            ctx.addIssue({ code: "custom", message: "Duplicate option identity.", path: ["options", optionIndex, "id"] });
        }
        definitionIds.add(option.id);

        const values = new Set<string>();
        option.values.forEach((value, valueIndex) => {
            const normalizedValue = normalizeOptionIdentity(value.value);
            if (values.has(normalizedValue)) {
                ctx.addIssue({
                    code: "custom",
                    message: `Each ${option.name} value must be unique.`,
                    path: ["options", optionIndex, "values", valueIndex, "value"],
                });
            }
            values.add(normalizedValue);
            if (valueOwner.has(value.id)) {
                ctx.addIssue({ code: "custom", message: "Duplicate option value identity.", path: ["options", optionIndex, "values", valueIndex, "id"] });
            }
            valueOwner.set(value.id, option.id);
        });
    });

    const expectedCount = input.options.reduce(
        (count, option) => count * option.values.length,
        1,
    );
    if (expectedCount > MAX_PRODUCT_OPTION_COMBINATIONS) {
        ctx.addIssue({
            code: "custom",
            message: `This option set creates ${expectedCount} combinations. The limit is ${MAX_PRODUCT_OPTION_COMBINATIONS}.`,
            path: ["options"],
        });
    }
    if (input.variants.length !== expectedCount) {
        ctx.addIssue({
            code: "custom",
            message: `Expected ${expectedCount} SKU combinations, received ${input.variants.length}.`,
            path: ["variants"],
        });
    }

    const combinationKeys = new Set<string>();
    const variantIds = new Set<string>();
    const skus = new Set<string>();
    const barcodes = new Set<string>();
    input.variants.forEach((variant, variantIndex) => {
        if (variantIds.has(variant.id)) {
            ctx.addIssue({ code: "custom", message: "Duplicate SKU row identity.", path: ["variants", variantIndex, "id"] });
        }
        variantIds.add(variant.id);

        const selectedByDefinition = new Map<string, string>();
        for (const valueId of variant.selectedOptionValueIds) {
            const owner = valueOwner.get(valueId);
            if (!owner) {
                ctx.addIssue({ code: "custom", message: "A selected value is not in this option set.", path: ["variants", variantIndex, "selectedOptionValueIds"] });
                continue;
            }
            if (selectedByDefinition.has(owner)) {
                ctx.addIssue({ code: "custom", message: "Select only one value per option.", path: ["variants", variantIndex, "selectedOptionValueIds"] });
            }
            selectedByDefinition.set(owner, valueId);
        }
        const orderedValueIds = input.options.flatMap((option) => {
            const valueId = selectedByDefinition.get(option.id);
            return valueId ? [valueId] : [];
        });
        if (orderedValueIds.length !== input.options.length) {
            ctx.addIssue({ code: "custom", message: "Select one value for every option.", path: ["variants", variantIndex, "selectedOptionValueIds"] });
        }
        const combinationKey = orderedValueIds.join("|");
        if (combinationKeys.has(combinationKey)) {
            ctx.addIssue({ code: "custom", message: "Duplicate option combination.", path: ["variants", variantIndex, "selectedOptionValueIds"] });
        }
        combinationKeys.add(combinationKey);

        const skuKey = variant.sku.toLocaleLowerCase("en-US");
        if (skus.has(skuKey)) {
            ctx.addIssue({ code: "custom", message: "Each SKU must be unique.", path: ["variants", variantIndex, "sku"] });
        }
        skus.add(skuKey);

        const barcodeKey = variant.barcode?.toLocaleLowerCase("en-US");
        if (barcodeKey) {
            if (barcodes.has(barcodeKey)) {
                ctx.addIssue({ code: "custom", message: "Each barcode must be unique.", path: ["variants", variantIndex, "barcode"] });
            }
            barcodes.add(barcodeKey);
        }
        if ((variant.barcode === null) !== (variant.barcodeType === null)) {
            ctx.addIssue({ code: "custom", message: "Barcode and barcode type must be supplied together.", path: ["variants", variantIndex, "barcode"] });
        }
        if (variant.discountType === "percentage" && variant.discountAmount) {
            ctx.addIssue({ code: "custom", message: "Percentage discounts cannot include a flat amount.", path: ["variants", variantIndex, "discountAmount"] });
        }
        if (variant.discountType === "flat" && variant.discountPercentage) {
            ctx.addIssue({ code: "custom", message: "Flat discounts cannot include a percentage.", path: ["variants", variantIndex, "discountPercentage"] });
        }
        if (
            variant.discountType === "flat"
            && variant.discountAmount !== null
            && variant.discountAmount > variant.price
        ) {
            ctx.addIssue({ code: "custom", message: "A flat discount cannot exceed the SKU price.", path: ["variants", variantIndex, "discountAmount"] });
        }
    });
}

export const createProductOptionMatrixSchema = productOptionMatrixBaseSchema
    .superRefine(validateOptionMatrix);

export const productOptionMatrixSchema = productOptionMatrixBaseSchema
    .extend({ expectedAggregateRevision: expectedProductAggregateRevisionSchema })
    .superRefine(validateOptionMatrix);

export type ProductOptionMatrixInput = z.infer<typeof productOptionMatrixSchema>;

export function parseProductOptionMatrix(input: unknown): ProductOptionMatrixInput {
    const result = productOptionMatrixSchema.safeParse(input);
    if (!result.success) {
        throw new ValidationError(result.error.issues[0]?.message ?? "The option matrix is invalid.");
    }
    return result.data;
}

const CLOSED_ORDER_STATUSES = [
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
];

function chunk<T>(values: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

function isDraftId(id: string): boolean {
    return id.startsWith("draft_") || id.startsWith("temp_") || id.startsWith("new_");
}

type MatrixOptionIdentity = {
    id: string;
    values: ReadonlyArray<{ id: string }>;
};

/**
 * Combination identity is always axis ordered. Request order must never create
 * a second identity for the same selected values.
 */
export function orderSelectedOptionValueIds(
    options: readonly MatrixOptionIdentity[],
    selectedOptionValueIds: readonly string[],
): string[] {
    const selected = new Set(selectedOptionValueIds);
    return options.flatMap((option) => {
        const value = option.values.find((candidate) => selected.has(candidate.id));
        return value ? [value.id] : [];
    });
}

export function assertVariantImageOwnership(
    imageId: string | null,
    productImageIds: ReadonlySet<string>,
): void {
    if (imageId && !productImageIds.has(imageId)) {
        throw new ValidationError("A selected SKU image is not on this product.");
    }
}

type StockAllocationVariant = {
    isDefault?: boolean;
    stock: number;
    reservedStock?: number;
    preorderStock?: number;
    trackInventory: boolean;
};

/**
 * Converting a tracked simple SKU to an option matrix is a stock allocation,
 * not a stock creation or deletion. Existing optioned products are unaffected.
 */
export function assertOptionMatrixStockAllocation(
    currentVariants: readonly StockAllocationVariant[],
    nextVariants: readonly Pick<StockAllocationVariant, "stock" | "trackInventory">[],
): void {
    const wasSimple = currentVariants.every((variant) => variant.isDefault);
    const defaultSku = currentVariants.find((variant) => variant.isDefault);
    if (!wasSimple || !defaultSku) return;

    if ((defaultSku.reservedStock ?? 0) > 0 || (defaultSku.preorderStock ?? 0) > 0) {
        throw new ConflictError(
            "Release reserved or preorder stock before converting this product to options.",
        );
    }
    if (!defaultSku.trackInventory) return;

    const allocated = nextVariants.reduce(
        (total, variant) => total + (variant.trackInventory ? variant.stock : 0),
        0,
    );
    if (allocated !== defaultSku.stock) {
        throw new ValidationError(
            `Allocate exactly ${defaultSku.stock} on-hand units across the new combinations. Currently allocated: ${allocated}.`,
        );
    }
}

/** Preserve physical stock when a topology edit replaces old combinations. */
export function assertOptionMatrixReplacementStockAllocation(
    retiringVariants: readonly Pick<StockAllocationVariant, "stock" | "trackInventory">[],
    creatingVariants: readonly Pick<StockAllocationVariant, "stock" | "trackInventory">[],
): void {
    if (retiringVariants.length === 0 || creatingVariants.length === 0) return;
    const retiringStock = retiringVariants.reduce(
        (total, variant) => total + (variant.trackInventory ? variant.stock : 0),
        0,
    );
    const creatingStock = creatingVariants.reduce(
        (total, variant) => total + (variant.trackInventory ? variant.stock : 0),
        0,
    );
    if (creatingStock !== retiringStock) {
        throw new ValidationError(
            `Allocate exactly ${retiringStock} on-hand units from the replaced combinations. Currently allocated: ${creatingStock}.`,
        );
    }
}

export async function saveProductOptionMatrix(
    db: Database,
    productId: string,
    rawInput: unknown,
    adminUserId?: string,
): Promise<{ aggregateRevision: number }> {
    const input = parseProductOptionMatrix(rawInput);
    const product = await db.select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, productId), isNull(products.deletedAt)))
        .get();
    if (!product) throw new NotFoundError("Product not found");

    const [existingDefinitions, existingValues, existingVariants, productImageRows] = await Promise.all([
        db.select().from(productOptionDefinitions).where(eq(productOptionDefinitions.productId, productId)),
        db.select({
            id: productOptionValues.id,
            optionDefinitionId: productOptionValues.optionDefinitionId,
            value: productOptionValues.value,
            position: productOptionValues.position,
            deletedAt: productOptionValues.deletedAt,
        }).from(productOptionValues)
            .innerJoin(
                productOptionDefinitions,
                eq(productOptionDefinitions.id, productOptionValues.optionDefinitionId),
            )
            .where(eq(productOptionDefinitions.productId, productId)),
        db.select().from(productVariants).where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
        )),
        db.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, productId)),
    ]);

    const definitionById = new Map(existingDefinitions.map((definition) => [definition.id, definition]));
    const valueById = new Map(existingValues.map((value) => [value.id, value]));
    const variantById = new Map(existingVariants.map((variant) => [variant.id, variant]));
    const productImageIds = new Set(productImageRows.map((image) => image.id));
    const definitionIdMap = new Map<string, string>();
    const valueIdMap = new Map<string, string>();

    for (const option of input.options) {
        if (!isDraftId(option.id) && !definitionById.has(option.id)) {
            throw new ValidationError("A product option changed or no longer exists. Reload and try again.");
        }
        definitionIdMap.set(option.id, definitionById.has(option.id) ? option.id : `popt_${nanoid()}`);
        for (const value of option.values) {
            const existing = valueById.get(value.id);
            if (!isDraftId(value.id) && !existing) {
                throw new ValidationError("An option value changed or no longer exists. Reload and try again.");
            }
            if (existing && existing.optionDefinitionId !== option.id) {
                throw new ValidationError("An option value belongs to a different option.");
            }
            valueIdMap.set(value.id, existing ? value.id : `pval_${nanoid()}`);
        }
    }

    const normalizedVariants = input.variants.map((variant) => {
        if (!isDraftId(variant.id) && !variantById.has(variant.id)) {
            throw new ValidationError("A SKU changed or no longer exists. Reload and try again.");
        }
        assertVariantImageOwnership(variant.imageId, productImageIds);
        const orderedInputValueIds = orderSelectedOptionValueIds(
            input.options,
            variant.selectedOptionValueIds,
        );
        const selectedOptionValueIds = orderedInputValueIds.map((id) => {
            const mapped = valueIdMap.get(id);
            if (!mapped) throw new ValidationError("A selected option value is not in this matrix.");
            return mapped;
        });
        const barcode = normalizeVariantBarcode(variant.barcode, variant.barcodeType);
        return {
            ...variant,
            id: variantById.has(variant.id) ? variant.id : `var_${nanoid()}`,
            selectedOptionValueIds,
            optionCombinationKey: selectedOptionValueIds.join("|"),
            ...barcode,
        };
    });

    await assertUniqueVariantBarcodes(db, normalizedVariants.map((variant) => ({
        id: variantById.has(variant.id) ? variant.id : undefined,
        barcode: variant.barcode,
        barcodeType: variant.barcodeType,
    })));

    const finalSkuOwner = new Map(
        normalizedVariants.map((variant) => [
            variant.sku.trim().toLocaleLowerCase("en-US"),
            variant.id,
        ]),
    );
    const finalSkuByVariantId = new Map(
        normalizedVariants.map((variant) => [
            variant.id,
            variant.sku.trim().toLocaleLowerCase("en-US"),
        ]),
    );
    const skuCollisions = await db.select({ id: productVariants.id, sku: productVariants.sku })
        .from(productVariants)
        .where(sql`lower(trim(${productVariants.sku})) IN (
            SELECT CAST(value AS TEXT)
            FROM json_each(${JSON.stringify([...finalSkuOwner.keys()])})
        )`);
    for (const row of skuCollisions) {
        const currentKey = row.sku.trim().toLocaleLowerCase("en-US");
        const plannedKey = finalSkuByVariantId.get(row.id);
        if (plannedKey !== undefined && plannedKey !== currentKey) continue;
        if (finalSkuOwner.get(currentKey) !== row.id) {
            throw new ConflictError(`SKU ${row.sku} is already in use.`);
        }
    }

    const defaultSku = existingVariants.find((variant) => variant.isDefault);
    const wasSimple = existingVariants.length > 0 && existingVariants.every((variant) => variant.isDefault);
    if (!wasSimple && defaultSku && (
        defaultSku.stock > 0
        || defaultSku.reservedStock > 0
        || defaultSku.preorderStock > 0
    )) {
        throw new ConflictError("Resolve stock on the legacy default SKU before saving this option matrix.");
    }

    const submittedVariantIds = new Set(normalizedVariants.map((variant) => variant.id));
    const retiringVariants = existingVariants.filter((variant) =>
        !variant.isDefault && !submittedVariantIds.has(variant.id)
    );
    const variantsRequiringRetirement = defaultSku
        ? [...retiringVariants, defaultSku]
        : retiringVariants;
    const creatingVariants = normalizedVariants.filter((variant) => !variantById.has(variant.id));
    assertOptionMatrixReplacementStockAllocation(retiringVariants, creatingVariants);
    if (variantsRequiringRetirement.some((variant) => variant.reservedStock > 0 || variant.preorderStock > 0)) {
        throw new ConflictError("Release reserved or preorder stock before retiring combinations.");
    }
    if (variantsRequiringRetirement.length > 0) {
        const openOrder = await db.select({ variantId: orderItems.variantId })
            .from(orderItems)
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .where(and(
                inArray(orderItems.variantId, variantsRequiringRetirement.map((variant) => variant.id)),
                isNull(orders.deletedAt),
                not(inArray(orders.status, CLOSED_ORDER_STATUSES)),
            ))
            .get();
        if (openOrder) throw new ConflictError("Finish or cancel open orders before retiring combinations.");
    }

    assertOptionMatrixStockAllocation(existingVariants, normalizedVariants);

    const statements = [];
    const submittedDefinitionIds = new Set<string>();
    const submittedValueIds = new Set<string>();

    // Temporarily release normalized identities so valid SKU/barcode swaps do
    // not hit SQLite's immediate unique indexes midway through the D1 batch.
    for (const variant of normalizedVariants) {
        const existing = variantById.get(variant.id);
        if (!existing) continue;
        const skuChanged = existing.sku.trim().toLocaleLowerCase("en-US")
            !== variant.sku.trim().toLocaleLowerCase("en-US");
        const barcodeChanged = (existing.barcode?.trim().toLocaleLowerCase("en-US") ?? null)
            !== (variant.barcode?.trim().toLocaleLowerCase("en-US") ?? null);
        if (!skuChanged && !barcodeChanged) continue;
        statements.push(db.update(productVariants)
            .set({
                ...(skuChanged ? { sku: `matrix_staging_${nanoid()}` } : {}),
                ...(barcodeChanged ? { barcode: null, barcodeType: null } : {}),
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(productVariants.id, variant.id),
                eq(productVariants.productId, productId),
                isNull(productVariants.deletedAt),
            )));
    }

    // Release partial unique indexes before reordering. Definition positions
    // are CHECK-constrained to 0..4, so out-of-range staging is not valid.
    for (const definition of existingDefinitions.filter((item) => item.deletedAt === null)) {
        statements.push(db.update(productOptionDefinitions)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(eq(productOptionDefinitions.id, definition.id)));
    }
    for (const value of existingValues.filter((item) => item.deletedAt === null)) {
        statements.push(db.update(productOptionValues)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(eq(productOptionValues.id, value.id)));
    }

    input.options.forEach((option, optionPosition) => {
        const optionId = definitionIdMap.get(option.id)!;
        submittedDefinitionIds.add(optionId);
        const definitionValues = {
            productId,
            name: option.name,
            normalizedName: normalizeOptionIdentity(option.name),
            position: optionPosition,
            standardMapping: option.standardMapping,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        };
        if (definitionById.has(optionId)) {
            statements.push(db.update(productOptionDefinitions)
                .set(definitionValues)
                .where(eq(productOptionDefinitions.id, optionId)));
        } else {
            statements.push(db.insert(productOptionDefinitions).values({
                id: optionId,
                ...definitionValues,
                createdAt: sql`unixepoch()`,
            }));
        }
        option.values.forEach((value, valuePosition) => {
            const valueId = valueIdMap.get(value.id)!;
            submittedValueIds.add(valueId);
            const valueFields = {
                optionDefinitionId: optionId,
                value: value.value,
                normalizedValue: normalizeOptionIdentity(value.value),
                position: valuePosition,
                updatedAt: sql`unixepoch()`,
                deletedAt: null,
            };
            if (valueById.has(valueId)) {
                statements.push(db.update(productOptionValues)
                    .set(valueFields)
                    .where(eq(productOptionValues.id, valueId)));
            } else {
                statements.push(db.insert(productOptionValues).values({
                    id: valueId,
                    ...valueFields,
                    createdAt: sql`unixepoch()`,
                }));
            }
        });
    });

    for (const definition of existingDefinitions) {
        if (definition.deletedAt === null && !submittedDefinitionIds.has(definition.id)) {
            statements.push(db.update(productOptionDefinitions)
                .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(eq(productOptionDefinitions.id, definition.id)));
        }
    }
    for (const value of existingValues) {
        if (value.deletedAt === null && !submittedValueIds.has(value.id)) {
            statements.push(db.update(productOptionValues)
                .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(eq(productOptionValues.id, value.id)));
        }
    }

    const assignmentRows: Array<{ variantId: string; optionDefinitionId: string; optionValueId: string }> = [];
    const changedStockVariantIds: string[] = [];

    // Stock can change independently of product metadata. Guard every edited
    // stock row inside the same D1 batch so a stale matrix never overwrites a
    // checkout, return, scanner, or inventory adjustment.
    for (const variant of normalizedVariants) {
        const existing = variantById.get(variant.id);
        if (!existing || variant.stock === existing.stock) continue;
        statements.push(buildBatchGuard(db, sql`
            CASE WHEN EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.id} = ${variant.id}
                  AND ${productVariants.productId} = ${productId}
                  AND ${productVariants.stockVersion} = ${existing.stockVersion}
                  AND ${productVariants.deletedAt} IS NULL
            ) THEN 1 ELSE json_extract('OPTION_MATRIX_STOCK_CONFLICT', '$') END
        `));
    }
    if (retiringVariants.length > 0) {
        const retiringIds = JSON.stringify(retiringVariants.map((variant) => variant.id));
        statements.push(buildBatchGuard(db, sql`
            CASE WHEN (
                SELECT count(*) FROM ${productVariants}
                WHERE ${productVariants.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${retiringIds})
                )
                  AND ${productVariants.productId} = ${productId}
                  AND ${productVariants.isDefault} = 0
                  AND ${productVariants.reservedStock} = 0
                  AND ${productVariants.preorderStock} = 0
                  AND ${productVariants.deletedAt} IS NULL
            ) = ${retiringVariants.length} AND NOT EXISTS (
                SELECT 1 FROM ${orderItems}
                INNER JOIN ${orders} ON ${orders.id} = ${orderItems.orderId}
                WHERE ${orderItems.variantId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${retiringIds})
                )
                  AND ${orders.deletedAt} IS NULL
                  AND ${not(inArray(orders.status, CLOSED_ORDER_STATUSES))}
            ) THEN 1 ELSE json_extract('OPTION_MATRIX_RETIRE_CONFLICT', '$') END
        `));
    }
    if (defaultSku) {
        statements.push(buildBatchGuard(db, sql`
            CASE WHEN EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.id} = ${defaultSku.id}
                  AND ${productVariants.productId} = ${productId}
                  AND ${productVariants.version} = ${defaultSku.version}
                  AND ${productVariants.stockVersion} = ${defaultSku.stockVersion}
                  AND ${productVariants.reservedStock} = 0
                  AND ${productVariants.preorderStock} = 0
                  AND ${productVariants.deletedAt} IS NULL
            ) THEN 1 ELSE json_extract('OPTION_MATRIX_DEFAULT_RETIRE_CONFLICT', '$') END
        `));
    }
    for (const variant of normalizedVariants) {
        const existing = variantById.get(variant.id);
        const selectedByInputId = new Map(
            variant.selectedOptionValueIds.map((valueId) => [valueId, valueId]),
        );
        const selectedDefinitions = input.options.map((option) => {
            const optionDefinitionId = definitionIdMap.get(option.id)!;
            const optionValueId = option.values
                .map((value) => valueIdMap.get(value.id)!)
                .find((valueId) => selectedByInputId.has(valueId));
            if (!optionValueId) throw new ValidationError(`Select one ${option.name} value.`);
            return { optionDefinitionId, optionValueId };
        });
        assignmentRows.push(...selectedDefinitions.map((assignment) => ({ variantId: variant.id, ...assignment })));

        const fields = {
            optionCombinationKey: variant.optionCombinationKey,
            imageId: variant.imageId,
            weight: variant.weight,
            sku: variant.sku,
            price: variant.price,
            trackInventory: variant.trackInventory,
            barcode: variant.barcode,
            barcodeType: variant.barcodeType,
            discountType: variant.discountType,
            discountPercentage: variant.discountType === "percentage" ? variant.discountPercentage ?? 0 : 0,
            discountAmount: variant.discountType === "flat" ? variant.discountAmount ?? 0 : 0,
            updatedAt: sql`unixepoch()`,
        };
        if (!existing) {
            statements.push(db.insert(productVariants).values({
                id: variant.id,
                productId,
                ...fields,
                stock: variant.stock > 0 ? 0 : variant.stock,
                reservedStock: 0,
                preorderStock: 0,
                isDefault: false,
                version: 1,
                stockVersion: 1,
                allowPreorder: false,
                allowBackorder: false,
                backorderLimit: 0,
                createdAt: sql`unixepoch()`,
                deletedAt: null,
            }));
            if (variant.stock > 0) {
                statements.push(buildStockMovementClaim(db, {
                    movementId: crypto.randomUUID(), variantId: variant.id, pool: "regular", quantity: variant.stock,
                    before: { stock: 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 },
                    after: { stock: variant.stock, reservedStock: 0, preorderStock: 0, stockVersion: 2 },
                    notes: "Stocktake: Initial option matrix stock", adminUserId,
                }));
                statements.push(db.update(productVariants)
                    .set({ stock: variant.stock, stockVersion: 2, updatedAt: sql`unixepoch()` })
                    .where(and(eq(productVariants.id, variant.id), eq(productVariants.stockVersion, 1))));
                changedStockVariantIds.push(variant.id);
            }
        } else {
            if (existing.isDefault) throw new ValidationError("The protected default SKU cannot become a combination row.");
            if (variant.stock !== existing.stock) {
                statements.push(buildStockMovementClaim(db, {
                    movementId: crypto.randomUUID(), variantId: variant.id, pool: "regular", quantity: variant.stock - existing.stock,
                    before: { stock: existing.stock, reservedStock: existing.reservedStock, preorderStock: existing.preorderStock, stockVersion: existing.stockVersion },
                    after: { stock: variant.stock, reservedStock: existing.reservedStock, preorderStock: existing.preorderStock, stockVersion: existing.stockVersion + 1 },
                    notes: "Stocktake: Option matrix edit", adminUserId,
                }));
                changedStockVariantIds.push(variant.id);
            }
            statements.push(db.update(productVariants).set({
                ...fields,
                stock: variant.stock,
                version: sql`${productVariants.version} + 1`,
                ...(variant.stock !== existing.stock
                    ? { stockVersion: sql`${productVariants.stockVersion} + 1` }
                    : {}),
            }).where(and(
                eq(productVariants.id, variant.id),
                eq(productVariants.version, existing.version),
                ...(variant.stock !== existing.stock
                    ? [eq(productVariants.stockVersion, existing.stockVersion)]
                    : []),
                isNull(productVariants.deletedAt),
            )));
            statements.push(db.delete(productVariantOptionValues)
                .where(eq(productVariantOptionValues.variantId, variant.id)));
        }
    }

    for (const rows of chunk(assignmentRows, 25)) {
        statements.push(db.insert(productVariantOptionValues).values(rows));
    }
    for (const variant of retiringVariants) {
        statements.push(db.update(productVariants)
            .set({ deletedAt: sql`unixepoch()`, version: sql`${productVariants.version} + 1`, updatedAt: sql`unixepoch()` })
            .where(and(eq(productVariants.id, variant.id), isNull(productVariants.deletedAt))));
    }
    if (wasSimple && defaultSku && defaultSku.stock > 0) {
        statements.push(buildStockMovementClaim(db, {
            movementId: crypto.randomUUID(), variantId: defaultSku.id, pool: "regular", quantity: -defaultSku.stock,
            before: { stock: defaultSku.stock, reservedStock: defaultSku.reservedStock, preorderStock: defaultSku.preorderStock, stockVersion: defaultSku.stockVersion },
            after: { stock: 0, reservedStock: defaultSku.reservedStock, preorderStock: defaultSku.preorderStock, stockVersion: defaultSku.stockVersion + 1 },
            notes: "Stocktake: Allocated default SKU stock to option matrix", adminUserId,
        }));
        statements.push(db.update(productVariants)
            .set({ stock: 0, stockVersion: sql`${productVariants.stockVersion} + 1`, updatedAt: sql`unixepoch()` })
            .where(and(eq(productVariants.id, defaultSku.id), eq(productVariants.stockVersion, defaultSku.stockVersion))));
    }
    if (defaultSku) {
        statements.push(db.update(productVariants)
            .set({
                deletedAt: sql`unixepoch()`,
                version: sql`${productVariants.version} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(productVariants.id, defaultSku.id),
                eq(productVariants.version, defaultSku.version),
                isNull(productVariants.deletedAt),
            )));
    }

    let result;
    try {
        result = await executeProductAggregateMutationBatch(
            db,
            productId,
            input.expectedAggregateRevision,
            statements,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/OPTION_MATRIX_(STOCK|RETIRE|DEFAULT_(?:STOCK|RETIRE))_CONFLICT|aggregate revision|constraint|unique/i.test(message)) {
            throw new ConflictError(
                "This product changed while you were editing. Reload the latest matrix and try again.",
            );
        }
        throw error;
    }
    await reconcileVariantLowStockAlerts(db, changedStockVariantIds);
    return { aggregateRevision: result.aggregateRevision };
}
