import type { Database } from "@scalius/database/client";
import { products, productVariants } from "@scalius/database/schema";
import { DEFAULT_CURRENCY, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
import { classifyProductVariantOptionAxes } from "@scalius/shared/product-options";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

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

interface ProductRow {
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

interface VariantRow {
    id: string;
    productId: string;
    size: string | null;
    color: string | null;
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
}

function variantLabel(variant: Pick<VariantRow, "isDefault" | "size" | "color"> | undefined): string | null {
    if (!variant || variant.isDefault) return null;
    const parts = [variant.size, variant.color].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(" / ") : null;
}

function hasCustomerOption(variant: Pick<VariantRow, "size" | "color">): boolean {
    return Boolean(variant.size?.trim() || variant.color?.trim());
}

function isSimpleDefaultSku(variant: Pick<VariantRow, "isDefault">): boolean {
    return variant.isDefault === true;
}

function isPersistedVariantId(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "" && value.trim() !== "default";
}

function displayProductName(item: StorefrontCartValidationItem, product?: ProductRow): string | null {
    return product?.name ?? item.productName ?? null;
}

function displayVariantLabel(item: StorefrontCartValidationItem, variant?: VariantRow): string | null {
    if (variant?.isDefault) return null;
    return variantLabel(variant) ?? item.variantLabel ?? null;
}

function calculateUnitPrice(
    product: ProductRow,
    variant: VariantRow | null,
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

function availableForVariant(variant: VariantRow, pool: InventoryPool): number {
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

export async function validateStorefrontCartItems(
    db: Database,
    items: StorefrontCartValidationItem[],
    options: { inventoryPool?: string | null; currencyCode?: string | null } = {},
): Promise<StorefrontCartValidationResult> {
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

    const productIds = [...new Set(items.map((item) => item.productId))];
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const pool = options.inventoryPool === "preorder" || options.inventoryPool === "backorder"
        ? options.inventoryPool
        : "regular";

    const [productRows, variantRows] = await Promise.all([
        db
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
                    inArray(products.id, productIds),
                    eq(products.isActive, true),
                    isNull(products.deletedAt),
                ),
            ),
        db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                size: productVariants.size,
                color: productVariants.color,
                stock: productVariants.stock,
                reservedStock: productVariants.reservedStock,
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
            })
            .from(productVariants)
            .where(and(
                or(
                    inArray(productVariants.productId, productIds),
                    inArray(productVariants.id, variantIds),
                ),
                isNull(productVariants.deletedAt),
            )),
    ]);

    const productMap = new Map((productRows as ProductRow[]).map((product) => [product.id, product]));
    const variantsByProduct = new Map<string, VariantRow[]>();
    const variantMap = new Map<string, VariantRow>();
    const persistedVariantRows = (variantRows as VariantRow[])
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
        const optionTopology = classifyProductVariantOptionAxes(nonDefaultVariants);
        const hasCustomerOptions = optionTopology !== "none";
        const hasInvalidNoOptionSku = nonDefaultVariants.some(
            (variant) => !hasCustomerOption(variant)
        );
        const hasConsistentCustomerOptions = optionTopology !== "none" &&
            optionTopology !== "mixed" &&
            !hasInvalidNoOptionSku;
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
            const hasInvalidOptionTopology = optionTopology === "mixed" || hasInvalidNoOptionSku;
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
