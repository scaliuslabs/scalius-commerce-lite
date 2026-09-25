import type { Database } from "@scalius/database/client";
import { products, productVariants } from "@scalius/database/schema";
import { DEFAULT_CURRENCY, getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { discountedPriceMinor, fromMinor, toMinor } from "@scalius/shared/money";
import { NO_PROPERTIES_HASH } from "@scalius/shared/line-properties";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
    isFulfillmentKind,
    resolveLineFulfillmentType,
    type FulfillmentKind,
    type FulfillmentType,
} from "@scalius/shared/fulfilment";
import {
    parseStoredCustomizationSchema,
    resolveLineProperties,
    type CanonicalLineProperty,
    type ResolvedLineProperty,
} from "@scalius/shared/line-properties";
import { variantOptionLabelSql } from "../products/option-model";
import { hasFulfiller } from "../fulfilment/registry";
import { giftCardLineRecipientIssue } from "../gift-cards";
import { digitalDeliverableSql } from "../digital/deliverable";
import {
    loadProductMediaProjections,
    type ProductMediaProjection,
    resolveSkuImageRepresentation,
} from "../products/media";
import {
    productBundleTiersByProduct,
    selectActiveProductBundleRows,
    type ProductBundleRow,
} from "../products/bundles";
import { bundleGroupPricing } from "@scalius/shared/product-bundles";
import {
    GIFT_CARD_MAX_QUANTITY_PER_LINE,
    GIFT_CARD_MAX_UNITS_PER_ORDER,
    isGiftCardLineQuantityAllowed,
    isGiftCardOrderUnitsAllowed,
} from "@scalius/shared/gift-card-tender";

export type StorefrontCartIssueCode =
    | "PRODUCT_UNAVAILABLE"
    | "VARIANT_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "QUANTITY_UNAVAILABLE"
    | "PRICE_CHANGED"
    /** A required buyer input (engraving, fit…) is missing. */
    | "PROPERTIES_REQUIRED"
    /** A buyer input is unknown, too long, or not one of the choices. */
    | "PROPERTIES_INVALID"
    /** The store cannot hand this kind of item over yet (e.g. digital before Wave B). */
    | "FULFILMENT_UNAVAILABLE";

export type StorefrontCartIssueAction =
    | "remove"
    | "select_variant"
    | "reduce_quantity"
    | "refresh_item"
    /** Open the product page to fill or fix its buyer inputs. */
    | "edit_properties";

export interface StorefrontCartValidationItem {
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    /** The unit price the buyer saw: base plus surcharges. */
    price?: number;
    productName?: string | null;
    variantLabel?: string | null;
    /** Buyer inputs `[{ key, value }]`; resolved against the product's schema. */
    properties?: unknown;
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
    /** The buyer input a PROPERTIES_* issue is about, when it is one field. */
    propertyKey?: string | null;
}

export interface StorefrontCartValidatedItem {
    index: number;
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    /** base + surcharges: what one unit costs. */
    unitPriceMinor: number;
    /** The product/variant price after its own sale; surcharges excluded. */
    baseUnitPriceMinor: number;
    propertiesPriceMinor: number;
    /** Labelled snapshot entries frozen on the order line. */
    properties: ResolvedLineProperty[];
    /** Identity form for the cart line key and the quote fingerprint. */
    canonicalProperties: CanonicalLineProperty[];
    fulfillmentKind: FulfillmentKind;
    isGiftCard: boolean;
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
    /**
     * This line's share of its product's quantity-bundle saving, from the
     * catalog prices (see `resolveCartBundleSavings`). Checkout applies it as
     * a line discount next to promotions, capped at what they leave. Absent
     * means no bundle applies.
     */
    bundleDiscountMinor?: number;
}

/** A product whose cart quantity reached one of its bundle tiers. */
export interface StorefrontCartBundleSaving {
    productId: string;
    /** The tier's quantity ("3 for ..."). */
    quantity: number;
    discountType: "percentage" | "fixed_price";
    label: string | null;
    savingMinor: number;
}

export interface StorefrontCartValidationResult {
    valid: boolean;
    issues: StorefrontCartItemIssue[];
    items: StorefrontCartValidatedItem[];
    /** At catalog prices: bundle savings and promotions are discounts on top. */
    subtotalMinor: number;
    hasFreeDeliveryProduct: boolean;
    /** Products whose quantity reached a bundle tier; absent means none. */
    bundles?: StorefrontCartBundleSaving[];
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
    isGiftCard: boolean;
    /** Raw `products.customization_schema`; parsed and validated per line. */
    customizationSchema: string | null;
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
    fulfillmentKind: string;
    /** A digital SKU has something to deliver (a ready file or available keys); false for other kinds. */
    digitalDeliverable: boolean;
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
    currencyCode: string,
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
        currencyCode,
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
            isGiftCard: products.isGiftCard,
            customizationSchema: products.customizationSchema,
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
            fulfillmentKind: productVariants.fulfillmentKind,
            // Digital readiness in the same read (no round trip); only digital SKUs pay for the check.
            digitalDeliverable: sql<boolean>`CASE WHEN ${productVariants.fulfillmentKind} = 'digital' THEN ${digitalDeliverableSql(productVariants.id)} ELSE 0 END`
                .mapWith((value) => Number(value) === 1),
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
    /** The products' active bundle tiers (`selectActiveProductBundleRows`). */
    bundleRows: readonly ProductBundleRow[] = [],
): StorefrontCartValidationResult {
    // API callers pass the normalized merchant setting. Direct Core callers
    // intentionally retain the historical BDT checkout authority fallback.
    const currencyCode = normalizeSupportedCurrencyCode(options.currencyCode) ?? DEFAULT_CURRENCY.code;
    const decimalPlaces = getDecimalPlaces(currencyCode);

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
    // Stock is per SKU, not per line: the same SKU with different buyer
    // inputs is several lines drawing on one availability (P5).
    const requestedByVariant = new Map<string, number>();
    for (const item of items) {
        requestedByVariant.set(item.variantId, (requestedByVariant.get(item.variantId) ?? 0) + item.quantity);
    }
    // Gift-card units requested by the lines before this one (the per-order cap).
    let giftCardUnitsBefore = 0;

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
        const fulfillmentKind: FulfillmentKind = isFulfillmentKind(variant.fulfillmentKind)
            ? variant.fulfillmentKind
            : "physical";
        const isGiftCard = product.isGiftCard === true;
        const knownType: FulfillmentType | null = resolveLineFulfillmentType(
            { fulfillmentKind, isGiftCard },
            null,
        );
        const displayName = `${product.name}${requestedVariantLabel ? ` (${requestedVariantLabel})` : ""}`;
        // A digital line also needs something to deliver; gift cards are generated at issue.
        const deliverable = knownType !== "digital" || variant.digitalDeliverable === true;
        if (knownType !== null && (!hasFulfiller(knownType) || !deliverable)) {
            addIssue(issues, item, index, {
                code: "FULFILMENT_UNAVAILABLE",
                action: "remove",
                message: `${displayName} can't be ordered online right now.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
            });
            return;
        }

        if (isGiftCard) {
            // One card per unit is issued in one batch: 20 a line, 50 an order (§11.3).
            const unitsBefore = giftCardUnitsBefore;
            giftCardUnitsBefore += item.quantity;
            const orderRoom = Math.max(0, GIFT_CARD_MAX_UNITS_PER_ORDER - unitsBefore);
            const lineAllowed = isGiftCardLineQuantityAllowed(item.quantity);
            if (!lineAllowed || !isGiftCardOrderUnitsAllowed(unitsBefore + item.quantity)) {
                const allowed = Math.min(GIFT_CARD_MAX_QUANTITY_PER_LINE, orderRoom);
                addIssue(issues, item, index, {
                    code: "QUANTITY_UNAVAILABLE",
                    action: allowed > 0 ? "reduce_quantity" : "remove",
                    message: lineAllowed
                        ? `One order can hold at most ${GIFT_CARD_MAX_UNITS_PER_ORDER} gift cards.`
                        : `You can buy at most ${GIFT_CARD_MAX_QUANTITY_PER_LINE} of ${displayName} at a time.`,
                    productName: product.name,
                    variantLabel: requestedVariantLabel,
                    availableQuantity: allowed,
                });
                return;
            }
        }

        const availableQuantity = availableForVariant(variant, pool);
        const requestedForVariant = requestedByVariant.get(variant.id) ?? item.quantity;
        if (availableQuantity < requestedForVariant) {
            const inSeveralLines = requestedForVariant > item.quantity;
            addIssue(issues, item, index, {
                code: "QUANTITY_UNAVAILABLE",
                action: availableQuantity > 0 ? "reduce_quantity" : "remove",
                message: availableQuantity > 0
                    ? `Only ${availableQuantity} left for ${displayName}${inSeveralLines ? " across your cart" : ""}.`
                    : `${displayName} is out of stock.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
                availableQuantity: Number.isFinite(availableQuantity) ? availableQuantity : undefined,
            });
            return;
        }

        const schemaRead = parseStoredCustomizationSchema(product.customizationSchema);
        if (!schemaRead.ok) {
            // A malformed stored schema is a product error, never "no inputs".
            addIssue(issues, item, index, {
                code: "PRODUCT_UNAVAILABLE",
                action: "remove",
                message: `${product.name} is not available for checkout right now.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
            });
            return;
        }
        const resolvedProperties = resolveLineProperties(schemaRead.schema, item.properties);
        if (!resolvedProperties.ok) {
            const field = schemaRead.schema?.fields.find((candidate) => candidate.key === resolvedProperties.key);
            addIssue(issues, item, index, {
                code: resolvedProperties.code,
                action: "edit_properties",
                message: resolvedProperties.code === "PROPERTIES_REQUIRED"
                    ? `${displayName} needs "${field?.label ?? "a required detail"}" before checkout.`
                    : `Check the details you entered for ${displayName}${field ? ` ("${field.label}")` : ""}.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
                propertyKey: resolvedProperties.key,
            });
            return;
        }

        if (isGiftCard) {
            // The recipient is where the card is sent: refuse a bad one now,
            // never drop it silently at issue.
            const recipientIssue = giftCardLineRecipientIssue(resolvedProperties.properties);
            if (recipientIssue) {
                addIssue(issues, item, index, {
                    code: "PROPERTIES_INVALID",
                    action: "edit_properties",
                    message: `${displayName}: ${recipientIssue.message}`,
                    productName: product.name,
                    variantLabel: requestedVariantLabel,
                    propertyKey: recipientIssue.propertyKey,
                });
                return;
            }
        }

        const baseUnitPriceMinor = calculateUnitPriceMinor(product, variant, currencyCode);
        const propertiesPriceMinor = resolvedProperties.propertiesPriceMinor;
        const unitPriceMinor = baseUnitPriceMinor + propertiesPriceMinor;
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
            baseUnitPriceMinor,
            propertiesPriceMinor,
            properties: resolvedProperties.properties,
            canonicalProperties: resolvedProperties.canonical,
            fulfillmentKind,
            isGiftCard,
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

    const bundles = resolveCartBundleSavings(validatedItems, bundleRows, currencyCode);

    return markTrustedStorefrontCartValidationResult({
        valid: issues.length === 0,
        issues,
        items: validatedItems,
        subtotalMinor,
        hasFreeDeliveryProduct,
        bundles,
    });
}

/**
 * Quantity bundles, priced from the lines' catalog unit prices (after catalog
 * discounts, before buyer-input surcharges) with `bundleGroupPricing`: every
 * line of a product counts toward its tiers, whatever its SKU or inputs. Sets
 * each line's `bundleDiscountMinor` and returns the products that reached a
 * tier. Gift cards are sold at their value and never bundle.
 */
function resolveCartBundleSavings(
    items: StorefrontCartValidatedItem[],
    bundleRows: readonly ProductBundleRow[],
    currencyCode: string,
): StorefrontCartBundleSaving[] {
    for (const item of items) item.bundleDiscountMinor = 0;
    if (bundleRows.length === 0) return [];
    const tiersByProduct = productBundleTiersByProduct(bundleRows);
    const linesByProduct = new Map<string, StorefrontCartValidatedItem[]>();
    for (const item of items) {
        if (item.isGiftCard || !tiersByProduct.has(item.productId)) continue;
        const lines = linesByProduct.get(item.productId) ?? [];
        lines.push(item);
        linesByProduct.set(item.productId, lines);
    }
    const savings: StorefrontCartBundleSaving[] = [];
    for (const [productId, lines] of linesByProduct) {
        const pricing = bundleGroupPricing(
            lines.map((line) => ({ key: String(line.index), unitPriceMinor: line.baseUnitPriceMinor, quantity: line.quantity })),
            tiersByProduct.get(productId)!,
            currencyCode,
        );
        if (!pricing.tier || pricing.savingMinor === 0) continue;
        pricing.lineSavings.forEach((saving, position) => {
            lines[position]!.bundleDiscountMinor = saving.savingMinor;
        });
        savings.push({
            productId,
            quantity: pricing.tier.quantity,
            discountType: pricing.tier.discountType,
            label: pricing.tier.label,
            savingMinor: pricing.savingMinor,
        });
    }
    return savings;
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
    const [productRows, variantRows, bundleRows] = await Promise.all([
        selectStorefrontCartProductRows(db, productIds),
        selectStorefrontCartVariantRows(db, productIds, variantIds),
        selectActiveProductBundleRows(db, productIds),
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
        (bundleRows ?? []) as ProductBundleRow[],
    );
}

/**
 * Cart validation in the decimal HTTP contract (prices in major units).
 * `propertiesHashes` (from `storefrontLinePropertiesHashes`, async WebCrypto)
 * are per validated item; lines without buyer inputs hash to "none".
 */
export function presentStorefrontCartValidation(
    result: StorefrontCartValidationResult,
    decimalPlaces: number,
    fulfilment: StorefrontCartFulfilmentSummary = summarizeStorefrontCartFulfilment(result, null),
    propertiesHashes: readonly string[] = [],
) {
    // Bundle savings are checkout discounts: the tax quote shows them.
    const { subtotalMinor, items, bundles: _bundles, ...rest } = result;
    return {
        ...rest,
        ...presentStorefrontCartFulfilmentSummary(fulfilment),
        items: items.map(({
            unitPriceMinor,
            baseUnitPriceMinor,
            canonicalProperties,
            isGiftCard: _isGiftCard,
            bundleDiscountMinor: _bundleDiscountMinor,
            ...item
        }, position) => ({
            ...item,
            unitPrice: fromMinor(unitPriceMinor, decimalPlaces),
            baseUnitPrice: fromMinor(baseUnitPriceMinor, decimalPlaces),
            propertiesPrice: fromMinor(item.propertiesPriceMinor, decimalPlaces),
            properties: item.properties.map((property) => ({
                ...property,
                price: fromMinor(property.priceMinor, decimalPlaces),
            })),
            propertiesHash: propertiesHashes[position]
                ?? (canonicalProperties.length === 0 ? NO_PROPERTIES_HASH : ""),
            fulfillmentType: fulfilment.lineTypes[position] ?? null,
        })),
        subtotal: fromMinor(subtotalMinor, decimalPlaces),
    };
}

/**
 * The order-level consequences of a cart's lines (Wave A §2.7), before or
 * after the buyer picks a delivery method: whether a method is needed,
 * whether the order ships to an address, and whether cash on delivery fits.
 */
export interface StorefrontCartFulfilmentSummary {
    /** One type per validated item (same order); null for physical lines until a method is chosen. */
    lineTypes: Array<FulfillmentType | null>;
    requiresDeliveryMethod: boolean;
    deliveryMethodKind: "delivery" | "pickup" | null;
    requiresShipping: boolean;
    allowsCashOnDelivery: boolean;
}

/** The line facts the order-level fulfilment rules read. */
export type StorefrontCartFulfilmentLine = Pick<StorefrontCartValidatedItem, "fulfillmentKind" | "isGiftCard">;

export function summarizeStorefrontCartFulfilment(
    result: { items: readonly StorefrontCartFulfilmentLine[] },
    chosenDeliveryMethodKind: "delivery" | "pickup" | null,
): StorefrontCartFulfilmentSummary {
    const requiresDeliveryMethod = result.items.some((item) =>
        !item.isGiftCard && item.fulfillmentKind === "physical");
    const deliveryMethodKind = requiresDeliveryMethod ? chosenDeliveryMethodKind : null;
    const lineTypes = result.items.map((item) => resolveLineFulfillmentType(item, deliveryMethodKind));
    return {
        lineTypes,
        requiresDeliveryMethod,
        deliveryMethodKind,
        requiresShipping: lineTypes.includes("ship"),
        // Physical and service lines are handed over in person: cash fits.
        allowsCashOnDelivery: result.items.some((item) =>
            !item.isGiftCard && item.fulfillmentKind !== "digital"),
    };
}

function presentStorefrontCartFulfilmentSummary(summary: StorefrontCartFulfilmentSummary) {
    return {
        requiresDeliveryMethod: summary.requiresDeliveryMethod,
        deliveryMethodKind: summary.deliveryMethodKind,
        requiresShipping: summary.requiresShipping,
    };
}

/**
 * The payment methods a cart may use: the store's enabled methods, without
 * cash on delivery when nothing is shipped, collected or performed.
 */
export function resolveCartPaymentMethods(
    enabledMethods: readonly string[],
    summary: Pick<StorefrontCartFulfilmentSummary, "allowsCashOnDelivery">,
): string[] {
    return enabledMethods.filter((method) => method !== "cod" || summary.allowsCashOnDelivery);
}
