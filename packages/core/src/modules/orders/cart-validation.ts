import type { Database } from "@scalius/database/client";
import { products, productVariants } from "@scalius/database/schema";
import { DEFAULT_CURRENCY, getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { discountedPriceMinor, fromMinor, toMinor } from "@scalius/shared/money";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { variantOptionLabelSql } from "../products/products.option-model";
import {
    loadProductMediaProjections,
    type ProductMediaProjection,
    resolveSkuImageRepresentation,
} from "../products/products.media";

export type StorefrontCartIssueCode =
    | "PRODUCT_UNAVAILABLE"
    | "VARIANT_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "QUANTITY_UNAVAILABLE"
    | "PRICE_CHANGED";

export type StorefrontCartIssueAction =
    | "remove"
    | "select_variant"
    | "reduce_quantity"
    | "refresh_item";

export interface StorefrontCartValidationItem {
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    price?: number;
    productName?: string | null;
    variantLabel?: string | null;
}

export interface StorefrontCartItemIssue {
    index: number;
    cartKey?: string | null;
    productId: string;
    variantId: string | null;
    code: StorefrontCartIssueCode;
    action: StorefrontCartIssueAction;
    message: string;
    productName: string | null;
    variantLabel: string | null;
    requestedQuantity: number;
    availableQuantity?: number;
    submittedPrice?: number;
    currentPrice?: number;
}

export interface StorefrontCartValidatedItem {
    index: number;
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    unitPriceMinor: number;
    productName: string;
    variantLabel: string | null;
    freeDelivery: boolean;
    inventoryTracked: boolean;
    availableQuantity: number | null;
    taxClassId: string | null;
    /** Actual image/poster Media asset selected by the authoritative SKU resolver. */
    productImageMediaId: string | null;
    /** Derived presentation URL; never a video URL and never trusted for checkout facts. */
    productImage: string | null;
}

export interface StorefrontCartValidationResult {
    valid: boolean;
    issues: StorefrontCartItemIssue[];
    items: StorefrontCartValidatedItem[];
    subtotalMinor: number;
    hasFreeDeliveryProduct: boolean;
}

const STOREFRONT_CART_VALIDATION_RESULT_PROOF = Symbol("scalius.storefrontCartValidationResult");

function markTrustedStorefrontCartValidationResult(
    result: StorefrontCartValidationResult,
): StorefrontCartValidationResult {
    Object.defineProperty(result, STOREFRONT_CART_VALIDATION_RESULT_PROOF, {
        value: true,
        enumerable: false,
    });
    return result;
}

export function isTrustedStorefrontCartValidationResult(
    result: StorefrontCartValidationResult | undefined,
): result is StorefrontCartValidationResult {
    return Boolean(result && Reflect.get(result, STOREFRONT_CART_VALIDATION_RESULT_PROOF) === true);
}

type InventoryPool = "regular" | "preorder" | "backorder";

export interface StorefrontCartProductRow {
    id: string;
    name: string;
    isActive: boolean;
    priceMinor: number;
    discountBps: number;
    discountType: string | null;
    discountAmountMinor: number;
    freeDelivery: boolean;
    taxClassId: string | null;
}

export interface StorefrontCartVariantRow {
    id: string;
    productId: string;
    optionCombinationKey: string | null;
    optionLabel: string | null;
    stock: number;
    reservedStock: number;
    preorderStock: number;
    isDefault: boolean;
    trackInventory: boolean;
    allowPreorder: boolean;
    allowBackorder: boolean;
    backorderLimit: number;
    priceMinor: number;
    discountBps: number;
    discountType: string | null;
    discountAmountMinor: number;
    taxClassId: string | null;
    imageId: string | null;
}

function variantLabel(variant: Pick<StorefrontCartVariantRow, "isDefault" | "optionLabel"> | undefined): string | null {
    if (!variant || variant.isDefault) return null;
    return variant.optionLabel;
}

function hasCustomerOption(variant: Pick<StorefrontCartVariantRow, "optionCombinationKey">): boolean {
    return Boolean(variant.optionCombinationKey?.trim());
}

function isSimpleDefaultSku(variant: Pick<StorefrontCartVariantRow, "isDefault">): boolean {
    return variant.isDefault === true;
}

function isPersistedVariantId(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "" && value.trim() !== "default";
}

function displayProductName(item: StorefrontCartValidationItem, product?: StorefrontCartProductRow): string | null {
    return product?.name ?? item.productName ?? null;
}

function displayVariantLabel(item: StorefrontCartValidationItem, variant?: StorefrontCartVariantRow): string | null {
    if (variant?.isDefault) return null;
    return variantLabel(variant) ?? item.variantLabel ?? null;
}

/** A SKU's own discount wins; otherwise the product discount applies to the SKU price. */
function calculateUnitPriceMinor(
    product: StorefrontCartProductRow,
    variant: StorefrontCartVariantRow,
): number {
    const variantHasDiscount =
        (variant.discountType === "percentage" && variant.discountBps > 0) ||
        (variant.discountType === "flat" && variant.discountAmountMinor > 0);
    const discount = variantHasDiscount ? variant : product;
    return discountedPriceMinor(
        variant.priceMinor,
        discount.discountType,
        discount.discountBps,
        discount.discountAmountMinor,
    );
}

function availableForVariant(variant: StorefrontCartVariantRow, pool: InventoryPool): number {
    if (!variant.trackInventory) {
        return Number.POSITIVE_INFINITY;
    }

    if (pool === "preorder") {
        return variant.allowPreorder ? Math.max(0, variant.preorderStock) : 0;
    }

    if (pool === "backorder") {
        if (!variant.allowBackorder) return 0;
        return variant.backorderLimit > 0
            ? Math.max(0, variant.backorderLimit - variant.reservedStock)
            : Number.POSITIVE_INFINITY;
    }

    return Math.max(0, variant.stock - variant.reservedStock);
}

function addIssue(
    issues: StorefrontCartItemIssue[],
    item: StorefrontCartValidationItem,
    index: number,
    issue: Omit<StorefrontCartItemIssue, "index" | "cartKey" | "productId" | "variantId" | "requestedQuantity">,
): void {
    issues.push({
        index,
        cartKey: item.cartKey ?? null,
        productId: item.productId,
        variantId: isPersistedVariantId(item.variantId) ? item.variantId : null,
        requestedQuantity: item.quantity,
        ...issue,
    });
}

export function selectStorefrontCartProductRows(
    db: Database,
    productIds: readonly string[],
) {
    const productIdSet = JSON.stringify([...new Set(productIds)]);
    return db
        .select({
            id: products.id,
            name: products.name,
            isActive: products.isActive,
            priceMinor: products.priceMinor,
            discountBps: products.discountBps,
            discountType: products.discountType,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            taxClassId: products.taxClassId,
        })
        .from(products)
        .where(
            and(
                sql`${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                )`,
                eq(products.isActive, true),
                isNull(products.deletedAt),
            ),
        );
}

export function selectStorefrontCartVariantRows(
    db: Database,
    productIds: readonly string[],
    variantIds: readonly string[],
) {
    const productIdSet = JSON.stringify([...new Set(productIds)]);
    const variantIdSet = JSON.stringify([...new Set(variantIds)]);
    return db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            optionCombinationKey: productVariants.optionCombinationKey,
            optionLabel: variantOptionLabelSql(productVariants.id),
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            preorderStock: productVariants.preorderStock,
            isDefault: productVariants.isDefault,
            trackInventory: productVariants.trackInventory,
            allowPreorder: productVariants.allowPreorder,
            allowBackorder: productVariants.allowBackorder,
            backorderLimit: productVariants.backorderLimit,
            priceMinor: productVariants.priceMinor,
            discountBps: productVariants.discountBps,
            discountType: productVariants.discountType,
            discountAmountMinor: productVariants.discountAmountMinor,
            taxClassId: productVariants.taxClassId,
            imageId: productVariants.imageId,
        })
        .from(productVariants)
        .where(and(
            or(
                sql`${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                )`,
                sql`${productVariants.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${variantIdSet})
                )`,
            ),
            isNull(productVariants.deletedAt),
        ));
}

export function resolveStorefrontCartValidationFromRows(
    items: StorefrontCartValidationItem[],
    options: {
        inventoryPool?: string | null;
        currencyCode?: string | null;
    },
    productRows: readonly StorefrontCartProductRow[],
    variantRows: readonly StorefrontCartVariantRow[],
    mediaByProduct: ReadonlyMap<string, ProductMediaProjection[]>,
): StorefrontCartValidationResult {
    // API callers pass the normalized merchant setting. Direct Core callers
    // intentionally retain the historical BDT checkout authority fallback.
    const decimalPlaces = getDecimalPlaces(
        normalizeSupportedCurrencyCode(options.currencyCode) ?? DEFAULT_CURRENCY.code,
    );

    if (items.length === 0) {
        return markTrustedStorefrontCartValidationResult({
            valid: true,
            issues: [],
            items: [],
            subtotalMinor: 0,
            hasFreeDeliveryProduct: false,
        });
    }

    const malformedVariantIssues: StorefrontCartItemIssue[] = [];
    items.forEach((item, index) => {
        if (isPersistedVariantId(item.variantId)) return;
        const productName = displayProductName(item);
        addIssue(malformedVariantIssues, item, index, {
            code: "VARIANT_REQUIRED",
            action: "select_variant",
            message: `${productName ?? "This item"} needs a saved option selection before checkout.`,
            productName,
            variantLabel: displayVariantLabel(item),
        });
    });
    if (malformedVariantIssues.length > 0) {
        return markTrustedStorefrontCartValidationResult({
            valid: false,
            issues: malformedVariantIssues,
            items: [],
            subtotalMinor: 0,
            hasFreeDeliveryProduct: false,
        });
    }

    const pool = options.inventoryPool === "preorder" || options.inventoryPool === "backorder"
        ? options.inventoryPool
        : "regular";

    const productMap = new Map(productRows.map((product) => [product.id, product]));
    const variantsByProduct = new Map<string, StorefrontCartVariantRow[]>();
    const variantMap = new Map<string, StorefrontCartVariantRow>();
    const persistedVariantRows = variantRows
        .filter((variant) => isPersistedVariantId(variant.id));
    for (const variant of persistedVariantRows) {
        variantMap.set(variant.id, variant);
        const productVariantsForProduct = variantsByProduct.get(variant.productId) ?? [];
        productVariantsForProduct.push(variant);
        variantsByProduct.set(variant.productId, productVariantsForProduct);
    }

    const issues: StorefrontCartItemIssue[] = [];
    const validatedItems: StorefrontCartValidatedItem[] = [];
    let subtotalMinor = 0;
    let hasFreeDeliveryProduct = false;

    items.forEach((item, index) => {
        const product = productMap.get(item.productId);
        const productName = displayProductName(item, product);

        if (!product) {
            addIssue(issues, item, index, {
                code: "PRODUCT_UNAVAILABLE",
                action: "remove",
                message: `${productName ?? "This item"} is no longer available.`,
                productName,
                variantLabel: displayVariantLabel(item),
            });
            return;
        }

        const productVariantsForProduct = variantsByProduct.get(product.id) ?? [];
        const nonDefaultVariants = productVariantsForProduct.filter((variant) =>
            !variant.isDefault
        );
        const hasCustomerOptions = nonDefaultVariants.length > 0;
        const hasInvalidNoOptionSku = nonDefaultVariants.some(
            (variant) => !hasCustomerOption(variant)
        );
        const hasConsistentCustomerOptions = hasCustomerOptions && !hasInvalidNoOptionSku;
        const requestedVariant = variantMap.get(item.variantId);
        const requestedVariantLabel = displayVariantLabel(item, requestedVariant);

        if (!requestedVariant) {
            addIssue(issues, item, index, {
                code: "VARIANT_UNAVAILABLE",
                action: "remove",
                message: `${product.name}${requestedVariantLabel ? ` (${requestedVariantLabel})` : ""} is no longer available.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
            });
            return;
        }

        if (requestedVariant.productId !== product.id) {
            addIssue(issues, item, index, {
                code: "VARIANT_MISMATCH",
                action: "remove",
                message: `${product.name} has changed. Please remove it and add the option again.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
            });
            return;
        }

        const buyerResolvableVariants = hasConsistentCustomerOptions
            ? nonDefaultVariants.filter(hasCustomerOption)
            : productVariantsForProduct.length === 1 && isSimpleDefaultSku(productVariantsForProduct[0]!)
                ? productVariantsForProduct
                : [];
        if (!buyerResolvableVariants.some((variant) => variant.id === requestedVariant.id)) {
            const hasInvalidOptionTopology = hasInvalidNoOptionSku;
            addIssue(issues, item, index, {
                code: hasCustomerOptions && !hasInvalidOptionTopology ? "VARIANT_REQUIRED" : "PRODUCT_UNAVAILABLE",
                action: hasCustomerOptions && !hasInvalidOptionTopology ? "select_variant" : "remove",
                message: hasCustomerOptions && !hasInvalidOptionTopology
                    ? `${product.name} needs an option selection before checkout.`
                    : `${product.name} is not available for checkout right now.`,
                productName: product.name,
                variantLabel: null,
            });
            return;
        }

        const variant = requestedVariant;
        const availableQuantity = availableForVariant(variant, pool);
        if (availableQuantity < item.quantity) {
            addIssue(issues, item, index, {
                code: "QUANTITY_UNAVAILABLE",
                action: availableQuantity > 0 ? "reduce_quantity" : "remove",
                message: availableQuantity > 0
                    ? `Only ${availableQuantity} left for ${product.name}${requestedVariantLabel ? ` (${requestedVariantLabel})` : ""}.`
                    : `${product.name}${requestedVariantLabel ? ` (${requestedVariantLabel})` : ""} is out of stock.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
                availableQuantity: Number.isFinite(availableQuantity) ? availableQuantity : undefined,
            });
            return;
        }

        const unitPriceMinor = calculateUnitPriceMinor(product, variant);
        const submittedPriceMinor = typeof item.price === "number"
            ? Number.isFinite(item.price) && item.price >= 0 ? toMinor(item.price, decimalPlaces) : -1
            : undefined;
        if (submittedPriceMinor !== undefined && submittedPriceMinor !== unitPriceMinor) {
            addIssue(issues, item, index, {
                code: "PRICE_CHANGED",
                action: "refresh_item",
                message: `The price for ${product.name}${requestedVariantLabel ? ` (${requestedVariantLabel})` : ""} changed. Please review the updated cart total.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
                submittedPrice: item.price,
                currentPrice: fromMinor(unitPriceMinor, decimalPlaces),
            });
            return;
        }

        const image = resolveSkuImageRepresentation(
            mediaByProduct.get(product.id) ?? [],
            variant.imageId,
        );
        subtotalMinor += unitPriceMinor * item.quantity;
        hasFreeDeliveryProduct ||= product.freeDelivery === true;
        validatedItems.push({
            index,
            cartKey: item.cartKey ?? null,
            productId: product.id,
            variantId: variant.id,
            quantity: item.quantity,
            unitPriceMinor,
            productName: product.name,
            variantLabel: requestedVariantLabel,
            freeDelivery: product.freeDelivery,
            inventoryTracked: variant.trackInventory,
            availableQuantity: Number.isFinite(availableQuantity) ? availableQuantity : null,
            taxClassId: variant.taxClassId ?? product.taxClassId,
            productImageMediaId: image?.mediaId ?? null,
            productImage: image?.url ?? null,
        });
    });

    return markTrustedStorefrontCartValidationResult({
        valid: issues.length === 0,
        issues,
        items: validatedItems,
        subtotalMinor,
        hasFreeDeliveryProduct,
    });
}

export async function validateStorefrontCartItems(
    db: Database,
    items: StorefrontCartValidationItem[],
    options: { inventoryPool?: string | null; currencyCode?: string | null } = {},
): Promise<StorefrontCartValidationResult> {
    if (items.length === 0 || items.some((item) => !isPersistedVariantId(item.variantId))) {
        return resolveStorefrontCartValidationFromRows(items, options, [], [], new Map());
    }

    const productIds = [...new Set(items.map((item) => item.productId))];
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const [productRows, variantRows] = await Promise.all([
        selectStorefrontCartProductRows(db, productIds),
        selectStorefrontCartVariantRows(db, productIds, variantIds),
    ]);
    // Media is presentation snapshot data, so keep it outside catalog authority
    // checks while still persisting the exact image asset chosen at checkout.
    const mediaByProduct = await loadProductMediaProjections(db, productIds);

    return resolveStorefrontCartValidationFromRows(
        items,
        options,
        productRows as StorefrontCartProductRow[],
        variantRows as StorefrontCartVariantRow[],
        mediaByProduct,
    );
}

/** Cart validation in the decimal HTTP contract (prices in major units). */
export function presentStorefrontCartValidation(
    result: StorefrontCartValidationResult,
    decimalPlaces: number,
) {
    const { subtotalMinor, items, ...rest } = result;
    return {
        ...rest,
        items: items.map(({ unitPriceMinor, ...item }) => ({
            ...item,
            unitPrice: fromMinor(unitPriceMinor, decimalPlaces),
        })),
        subtotal: fromMinor(subtotalMinor, decimalPlaces),
    };
}
