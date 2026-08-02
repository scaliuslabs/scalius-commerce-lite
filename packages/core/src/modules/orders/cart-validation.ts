import type { Database } from "@scalius/database/client";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
import { products, productVariants } from "@scalius/database/schema";
import { DEFAULT_CURRENCY, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
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
    unitPrice: number;
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
    subtotal: number;
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
    price: number;
    discountPercentage: number | null;
    discountType: string | null;
    discountAmount: number | null;
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
    price: number;
    discountPercentage: number | null;
    discountType: string | null;
    discountAmount: number | null;
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

function calculateUnitPrice(
    product: StorefrontCartProductRow,
    variant: StorefrontCartVariantRow | null,
    currencyCode: string,
): number {
    let unitPrice = variant?.price ?? product.price;
    const variantHasDiscount =
        variant &&
        (
            (variant.discountType === "percentage" && (variant.discountPercentage ?? 0) > 0) ||
            (variant.discountType === "flat" && (variant.discountAmount ?? 0) > 0)
        );

    if (variant && variantHasDiscount) {
        if (variant.discountType === "percentage") {
            unitPrice = unitPrice * (1 - (variant.discountPercentage ?? 0) / 100);
        } else if (variant.discountType === "flat") {
            unitPrice = Math.max(0, unitPrice - (variant.discountAmount ?? 0));
        }
    } else if (product.discountType === "percentage" && (product.discountPercentage ?? 0) > 0) {
        unitPrice = unitPrice * (1 - (product.discountPercentage ?? 0) / 100);
    } else if (product.discountType === "flat" && (product.discountAmount ?? 0) > 0) {
        unitPrice = Math.max(0, unitPrice - (product.discountAmount ?? 0));
    }

    return roundPrice(unitPrice, currencyCode);
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
            price: products.price,
            discountPercentage: products.discountPercentage,
            discountType: products.discountType,
            discountAmount: products.discountAmount,
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
            reservedStock: effectiveRegularReservedStockSql(),
            preorderStock: productVariants.preorderStock,
            isDefault: productVariants.isDefault,
            trackInventory: productVariants.trackInventory,
            allowPreorder: productVariants.allowPreorder,
            allowBackorder: productVariants.allowBackorder,
            backorderLimit: productVariants.backorderLimit,
            price: productVariants.price,
            discountPercentage: productVariants.discountPercentage,
            discountType: productVariants.discountType,
            discountAmount: productVariants.discountAmount,
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
        /**
         * The checkout coordinator performs the exact regular-stock guard in
         * its commit transaction. Its catalog snapshot therefore validates
         * identity and price without duplicating a stale availability check.
         */
        deferRegularInventoryAuthority?: boolean;
    },
    productRows: readonly StorefrontCartProductRow[],
    variantRows: readonly StorefrontCartVariantRow[],
    mediaByProduct: ReadonlyMap<string, ProductMediaProjection[]>,
): StorefrontCartValidationResult {
    // API callers pass the normalized merchant setting. Direct Core callers
    // intentionally retain the historical BDT checkout authority fallback.
    const currencyCode = normalizeSupportedCurrencyCode(options.currencyCode) ?? DEFAULT_CURRENCY.code;

    if (items.length === 0) {
        return markTrustedStorefrontCartValidationResult({
            valid: true,
            issues: [],
            items: [],
            subtotal: 0,
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
            subtotal: 0,
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
    let subtotal = 0;
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
        const availableQuantity = options.deferRegularInventoryAuthority && pool === "regular"
            ? Number.POSITIVE_INFINITY
            : availableForVariant(variant, pool);
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

        const unitPrice = calculateUnitPrice(product, variant, currencyCode);
        const submittedPrice = typeof item.price === "number"
            ? roundPrice(item.price, currencyCode)
            : undefined;
        if (submittedPrice !== undefined && submittedPrice !== unitPrice) {
            addIssue(issues, item, index, {
                code: "PRICE_CHANGED",
                action: "refresh_item",
                message: `The price for ${product.name}${requestedVariantLabel ? ` (${requestedVariantLabel})` : ""} changed. Please review the updated cart total.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
                submittedPrice,
                currentPrice: unitPrice,
            });
            return;
        }

        const lineTotal = roundPrice(unitPrice * item.quantity, currencyCode);
        const image = resolveSkuImageRepresentation(
            mediaByProduct.get(product.id) ?? [],
            variant.imageId,
        );
        subtotal = roundPrice(subtotal + lineTotal, currencyCode);
        hasFreeDeliveryProduct ||= product.freeDelivery === true;
        validatedItems.push({
            index,
            cartKey: item.cartKey ?? null,
            productId: product.id,
            variantId: variant.id,
            quantity: item.quantity,
            unitPrice,
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
        subtotal: roundPrice(subtotal, currencyCode),
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
