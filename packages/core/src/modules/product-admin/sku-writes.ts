// One SKU at a time, for PIM and ERP sync (the stable app API's
// `variants.create`, `variants.update` and `variants.restore`): options named
// by name and value, prices in minor units, through the editor's own commands
// under the product's aggregate revision, which advances once per write.
//
// A new SKU, a changed combination and a restored SKU go through the option
// matrix: it adds a value an option lacks, brings a retired combination back
// on its old SKU row (with its stock and history), and keeps every option and
// identity invariant. Any other SKU edit is the editor's single-SKU edit.
// Stock never changes here: quantities move through inventory.
import type { Database } from "@scalius/database/client";
import { productMedia, productVariants, products } from "@scalius/database/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { bpsToPercent, fromMinor } from "@scalius/shared/money";
import type { BarcodeType } from "@scalius/shared/barcode-identity";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { loadProductOptions, loadVariantSelectedOptions, normalizeOptionIdentity } from "../products";
import { readStoreCurrency } from "../markets";
import {
    commitProductOptionMatrixPlan,
    planProductOptionMatrix,
    productOptionMatrixBodySchema,
    type ProductOptionMatrixBody,
} from "./option-matrix";
import { executeProductAggregateMutationBatch } from "./aggregate-revision";
import { planProductBaseSection } from "./semantic-sections";
import { planVariantUpdate, rethrowProductVariantIdentityConstraint, updateVariant, type VariantUpdateFacts } from "./variants";

/** A SKU's own facts, as the stable API writes them. Omitted keeps the stored value. */
export type SkuFactsInput = {
    sku?: string;
    priceMinor?: number;
    /** Null clears it. */
    barcode?: string | null;
    barcodeType?: BarcodeType | null;
    trackInventory?: boolean;
    weightGrams?: number | null;
    /** A media file the product's gallery shows; null shows the product's featured image. */
    mediaId?: string | null;
};

/** One value of every option, by option name (`{ "Size": "M" }`). */
export type SkuOptionValues = Record<string, string>;

type VariantRow = typeof productVariants.$inferSelect;
type MatrixOption = ProductOptionMatrixBody["options"][number];
type MatrixVariant = ProductOptionMatrixBody["variants"][number];

type MatrixDraft = {
    isActive: boolean;
    decimalPlaces: number;
    options: MatrixOption[];
    variants: MatrixVariant[];
};

const NEW_ROW = "draft_var_sku";

/** A stored SKU as an editor matrix row: its facts as saved, its stock untouched (omitted keeps it). */
function matrixRow(row: VariantRow, selectedOptionValueIds: string[], decimalPlaces: number): MatrixVariant {
    const flat = row.discountType === "flat";
    return {
        id: row.id,
        selectedOptionValueIds,
        imageId: row.imageId,
        sku: row.sku,
        price: fromMinor(row.priceMinor, decimalPlaces),
        trackInventory: row.trackInventory,
        weight: row.weight,
        barcode: row.barcode,
        barcodeType: row.barcodeType as MatrixVariant["barcodeType"],
        discountType: flat ? "flat" : "percentage",
        discountPercentage: flat ? null : bpsToPercent(row.discountBps),
        discountAmount: flat ? fromMinor(row.discountAmountMinor, decimalPlaces) : null,
    };
}

/** The product's options and live option SKUs as the matrix input the editor would send. */
async function readMatrixDraft(db: Database, productId: string): Promise<MatrixDraft> {
    const [product, optionsByProduct, rows, currency] = await Promise.all([
        db.select({ isActive: products.isActive }).from(products).where(eq(products.id, productId)).get(),
        loadProductOptions(db, [productId]),
        db.select().from(productVariants)
            .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
            .orderBy(asc(productVariants.createdAt), asc(productVariants.id)),
        readStoreCurrency(db),
    ]);
    if (!product) throw new NotFoundError("Product not found");
    const options: MatrixOption[] = (optionsByProduct.get(productId) ?? []).map((option) => ({
        id: option.id,
        name: option.name,
        standardMapping: option.standardMapping,
        values: option.values.map((value) => ({ id: value.id, value: value.value })),
    }));
    const liveValueIds = new Set(options.flatMap((option) => option.values.map((value) => value.id)));
    const optionRows = rows.filter((row) => !row.isDefault);
    const selections = await loadVariantSelectedOptions(db, optionRows.map((row) => row.id));
    return {
        isActive: product.isActive,
        decimalPlaces: currency.decimalPlaces,
        options,
        variants: optionRows.map((row) => matrixRow(
            row,
            (selections.get(row.id) ?? []).map((selection) => selection.optionValueId).filter((id) => liveValueIds.has(id)),
            currency.decimalPlaces,
        )),
    };
}

/**
 * The value ids a SKU names by option name and value (any case), in option
 * order. A value an option does not have yet is added to it.
 */
function selectOptionValues(options: MatrixOption[], optionValues: SkuOptionValues): string[] {
    const names = options.map((option) => option.name).join(", ");
    const named = new Map<string, string>();
    for (const [name, value] of Object.entries(optionValues)) {
        const key = normalizeOptionIdentity(name);
        if (named.has(key)) throw new ValidationError(`Name each option once (${names}).`, { field: "optionValues" });
        named.set(key, value.trim());
    }
    const selected = options.map((option, optionIndex) => {
        const wanted = named.get(normalizeOptionIdentity(option.name));
        if (wanted === undefined) {
            throw new ValidationError(`Name one value for each option (${names}) and no other.`, { field: `optionValues.${option.name}` });
        }
        named.delete(normalizeOptionIdentity(option.name));
        const existing = option.values.find((value) => normalizeOptionIdentity(value.value) === normalizeOptionIdentity(wanted));
        if (existing) return existing.id;
        const added = { id: `draft_val_${optionIndex}_${option.values.length}`, value: wanted };
        option.values.push(added);
        return added.id;
    });
    if (named.size > 0) {
        throw new ValidationError(`This product's options are ${names}: name one value for each and no other.`, { field: "optionValues" });
    }
    return selected;
}

/** The gallery use of a media file this product shows, for a SKU's own image. */
async function skuImageId(db: Database, productId: string, mediaId: string | null): Promise<string | null> {
    if (mediaId === null) return null;
    const association = await db.select({ id: productMedia.id }).from(productMedia)
        .where(and(eq(productMedia.productId, productId), eq(productMedia.mediaId, mediaId)))
        .get();
    if (!association) {
        throw new ValidationError("Add the file to the product's gallery first (products.update mediaIds).", { field: "mediaId" });
    }
    return association.id;
}

/**
 * Plans a whole-matrix save of `variants` (option values no SKU uses any more
 * leave their option; a retired SKU's values come back by name). Nothing is
 * written until `commit`.
 */
async function planMatrix(db: Database, productId: string, draft: MatrixDraft, variants: MatrixVariant[]) {
    const used = new Set(variants.flatMap((variant) => variant.selectedOptionValueIds));
    const parsed = productOptionMatrixBodySchema.safeParse({
        options: draft.options.map((option) => ({ ...option, values: option.values.filter((value) => used.has(value.id)) })),
        variants,
    });
    if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the SKU's options.", {
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
    }
    return planProductOptionMatrix(db, productId, parsed.data, { isActive: draft.isActive });
}

function assertSellablePrice(isActive: boolean, priceMinor: number | undefined): void {
    if (isActive && priceMinor !== undefined && priceMinor <= 0) {
        throw new ValidationError("An active product needs a price above 0 on every SKU.", { field: "priceMinor" });
    }
}

function noOptionsError(): ValidationError {
    return new ValidationError(
        "This product is sold as one SKU, without options, so it takes no other SKU. Give it options in the dashboard, or create a product with options.",
        { field: "optionValues" },
    );
}

/** The barcode a write leaves: omitted keeps the stored one, null clears it, a new one keeps the stored type unless another is sent. */
function nextBarcode(row: Pick<VariantRow, "barcode" | "barcodeType">, input: SkuFactsInput) {
    if (input.barcode === null) return { barcode: null, barcodeType: null };
    const barcode = input.barcode ?? row.barcode;
    const barcodeType = (input.barcodeType === undefined ? row.barcodeType : input.barcodeType) as BarcodeType | null;
    return { barcode, barcodeType: barcode ? barcodeType : null };
}

/**
 * Adds a SKU to a product with options (`variants.create`). A combination a
 * retired SKU had brings that SKU back (its stock and history) under the new
 * code and price; otherwise the SKU starts with 0 on hand.
 */
export async function addProductSku(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    input: Omit<SkuFactsInput, "sku" | "priceMinor"> & { sku: string; priceMinor: number; optionValues: SkuOptionValues },
): Promise<{ variantId: string; aggregateRevision: number }> {
    const draft = await readMatrixDraft(db, productId);
    if (draft.options.length === 0) throw noOptionsError();
    assertSellablePrice(draft.isActive, input.priceMinor);
    const selectedOptionValueIds = selectOptionValues(draft.options, input.optionValues);
    const barcode = input.barcode ?? null;
    const plan = await planMatrix(db, productId, draft, [...draft.variants, {
        id: NEW_ROW,
        selectedOptionValueIds,
        imageId: await skuImageId(db, productId, input.mediaId ?? null),
        sku: input.sku,
        price: fromMinor(input.priceMinor, draft.decimalPlaces),
        trackInventory: input.trackInventory ?? true,
        weight: input.weightGrams ?? null,
        barcode,
        barcodeType: barcode ? input.barcodeType ?? null : null,
        discountType: "percentage",
        discountPercentage: null,
        discountAmount: null,
    }]);
    const { aggregateRevision } = await commitProductOptionMatrixPlan(db, productId, expectedAggregateRevision, plan);
    return { variantId: plan.variantIds.get(NEW_ROW)!, aggregateRevision };
}

/**
 * Changes one live SKU (`variants.update`): its code, price, barcode, weight,
 * tracking, image or option values. A product without options has one SKU,
 * whose price is the product's.
 */
export async function updateProductSku(
    db: Database,
    productId: string,
    variantId: string,
    expectedAggregateRevision: number,
    input: SkuFactsInput & { optionValues?: SkuOptionValues },
): Promise<{ aggregateRevision: number }> {
    const [row, product] = await Promise.all([
        db.select().from(productVariants)
            .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId)))
            .get(),
        db.select({ isActive: products.isActive }).from(products).where(eq(products.id, productId)).get(),
    ]);
    if (!row || !product) throw new NotFoundError("Variant not found");
    if (row.deletedAt) throw new ConflictError("This SKU is retired: bring it back with variants.restore first.");
    assertSellablePrice(product.isActive, input.priceMinor);
    const imageId = input.mediaId === undefined ? row.imageId : await skuImageId(db, productId, input.mediaId);
    const barcode = nextBarcode(row, input);
    const weight = input.weightGrams === undefined ? row.weight : input.weightGrams;
    const sku = input.sku ?? row.sku;
    const trackInventory = input.trackInventory ?? row.trackInventory;

    if (input.optionValues !== undefined) {
        if (row.isDefault) throw noOptionsError();
        const draft = await readMatrixDraft(db, productId);
        const selectedOptionValueIds = selectOptionValues(draft.options, input.optionValues);
        const plan = await planMatrix(db, productId, draft, draft.variants.map((variant) => variant.id !== variantId ? variant : {
            ...variant,
            selectedOptionValueIds,
            imageId,
            sku,
            ...(input.priceMinor !== undefined ? { price: fromMinor(input.priceMinor, draft.decimalPlaces) } : {}),
            trackInventory,
            weight,
            barcode: barcode.barcode,
            barcodeType: barcode.barcodeType as MatrixVariant["barcodeType"],
        }));
        return commitProductOptionMatrixPlan(db, productId, expectedAggregateRevision, plan);
    }

    const decimalPlaces = (await readStoreCurrency(db)).decimalPlaces;
    const flat = row.discountType === "flat";
    const facts: VariantUpdateFacts = {
        selectedOptionValueIds: row.isDefault ? [] : await liveSelection(db, productId, variantId),
        imageId,
        weight,
        sku,
        // A product without options prices its SKU through the product (below).
        price: fromMinor(row.isDefault ? row.priceMinor : input.priceMinor ?? row.priceMinor, decimalPlaces),
        trackInventory,
        barcode: barcode.barcode,
        barcodeType: barcode.barcodeType,
        discountType: flat ? "flat" : "percentage",
        discountPercentage: flat ? null : bpsToPercent(row.discountBps),
        discountAmount: flat ? fromMinor(row.discountAmountMinor, decimalPlaces) : null,
    };
    if (!row.isDefault || input.priceMinor === undefined) {
        const { aggregateRevision } = await updateVariant(db, productId, variantId, { ...facts, expectedAggregateRevision });
        return { aggregateRevision };
    }
    // The single SKU of a product without options: its price is the product's,
    // so the product price and the SKU edit commit in one batch.
    const base = await planProductBaseSection(db, productId, { price: fromMinor(input.priceMinor, decimalPlaces) });
    if (!base) throw new NotFoundError("Product not found");
    const edit = await planVariantUpdate(db, productId, variantId, facts, { simplePriceMinor: input.priceMinor });
    try {
        const { aggregateRevision } = await executeProductAggregateMutationBatch(db, productId, expectedAggregateRevision, [...base, ...edit.statements]);
        return { aggregateRevision };
    } catch (error) {
        return rethrowProductVariantIdentityConstraint(error);
    }
}

/** A live option SKU's value ids of the product's live options. */
async function liveSelection(db: Database, productId: string, variantId: string): Promise<string[]> {
    const [optionsByProduct, selections] = await Promise.all([
        loadProductOptions(db, [productId]),
        loadVariantSelectedOptions(db, [variantId]),
    ]);
    const live = new Set((optionsByProduct.get(productId) ?? []).flatMap((option) => option.values.map((value) => value.id)));
    return (selections.get(variantId) ?? []).map((selection) => selection.optionValueId).filter((id) => live.has(id));
}

/**
 * Brings a retired option SKU back (`variants.restore`, the inverse of
 * `variants.retire`): the same row, code, barcode, stock and history, under
 * its old combination. Refused when the product's options no longer have
 * that combination's options, or a live SKU already sells it.
 */
export async function restoreProductSku(
    db: Database,
    productId: string,
    variantId: string,
    expectedAggregateRevision: number,
): Promise<{ aggregateRevision: number }> {
    const row = await db.select().from(productVariants)
        .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId)))
        .get();
    if (!row) throw new NotFoundError("Variant not found");
    if (!row.deletedAt) throw new ConflictError("This SKU is not retired.");
    if (row.isDefault) {
        throw new ValidationError("This was the product's single SKU before it had options; it cannot sell beside them.", { field: "variantId" });
    }
    const draft = await readMatrixDraft(db, productId);
    if (draft.options.length === 0) throw noOptionsError();
    const mismatch = new ConflictError("This SKU's options no longer match the product's options. Add it again with variants.create.");
    const selections = (await loadVariantSelectedOptions(db, [variantId])).get(variantId) ?? [];
    const chosenByOption = new Map(selections.map((selection) => [selection.optionDefinitionId, selection]));
    const optionValues: SkuOptionValues = {};
    for (const option of draft.options) {
        const chosen = chosenByOption.get(option.id);
        if (!chosen) throw mismatch;
        optionValues[option.name] = chosen.value;
    }
    const imageId = row.imageId
        ? (await db.select({ id: productMedia.id }).from(productMedia)
            .where(and(eq(productMedia.id, row.imageId), eq(productMedia.productId, productId))).get())?.id ?? null
        : null;
    const plan = await planMatrix(db, productId, draft, [...draft.variants, {
        ...matrixRow(row, selectOptionValues(draft.options, optionValues), draft.decimalPlaces),
        id: NEW_ROW,
        imageId,
        // Null keeps the retired row's own barcode.
        barcode: null,
        barcodeType: null,
    }]);
    if (plan.variantIds.get(NEW_ROW) !== variantId) throw mismatch;
    return commitProductOptionMatrixPlan(db, productId, expectedAggregateRevision, plan);
}
