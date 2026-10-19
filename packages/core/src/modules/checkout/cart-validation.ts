import type { Database } from "@scalius/database/client";
import { withGiftCardRecipientFields } from "@scalius/shared/gift-card-recipient";
import { products, productVariants } from "@scalius/database/schema";
import { DEFAULT_CURRENCY, getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { discountedPriceMinor, fromMinor, toMinor } from "@scalius/shared/money";
import { isLineAmountInRange } from "@scalius/shared/order-limits";
import { mapCustomizationPrices, NO_PROPERTIES_HASH } from "@scalius/shared/line-properties";
import { isForeignPresentment, presentShopMinor, shopPresentment, type PresentmentMoney } from "@scalius/shared/presentment";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { ONLINE_STORE_CHANNEL_ID } from "@scalius/shared/sales-channels";
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
import {
  channelOnHandSql,
  loadProductMediaProjections,
  productPublishedToChannelSql,
  type ProductBundleRow,
  productBundleTiersByProduct,
  type ProductMediaProjection,
  resolveSkuImageRepresentation,
  selectActiveProductBundleRows,
  variantOptionLabelSql,
} from "../products";
import { hasFulfiller } from "../fulfilment";
import { BUILT_IN_PAYMENT_PROVIDERS, type PaymentProviders } from "../payments";
import { giftCardLineRecipientIssue } from "../gift-cards";
import { digitalDeliverableSql, digitalUnusedKeysSql } from "../digital";
import { bundleGroupPricing } from "@scalius/shared/product-bundles";
import { resolvePrice, type AppLinePrice, type ResolvedPriceSource } from "@scalius/shared/market-pricing";
import { resolveCartWithAppLinePrices, type AppLinePricer } from "./app-line-prices";
import type { CartTransformer, TransformedCart } from "./cart-transform";
import {
    checkoutListPricesSql,
    marketPricingMatrixSql,
    parseMarketListPrices,
    resolveCheckoutPriceScope,
    resolveCheckoutSkuPrice,
    type CheckoutMarketSignals,
    type CheckoutPriceScope,
} from "../price-lists";
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
    /**
     * Set by `cart.transform` (cart-transform.ts): the bundle the line
     * belongs to (an expanded line's components, merged lines) and the
     * buyer's line it came from. Never taken from a request.
     */
    bundle?: CartLineBundle | null;
    sourceIndex?: number;
}

/** The bundle a line belongs to on the order (`cart.transform`). */
export interface CartLineBundle {
    /** Stable within the cart: the buyer line's tax allocation line id. */
    id: string;
    title: string;
    kind: "expand" | "merge";
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
    weightGrams?: number | null;
    index: number;
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    /** base + surcharges: what one unit costs. */
    unitPriceMinor: number;
    /** The product/variant price after its own sale; surcharges excluded. */
    baseUnitPriceMinor: number;
    /** What priced `baseUnitPriceMinor` (`resolvePrice()`; `app`: `cart.line_prices`). */
    priceSource: ResolvedPriceSource;
    /** `cart.transform`: the bundle this line belongs to; null for a plain line. */
    bundle: CartLineBundle | null;
    /** The buyer's line this came from (`index` unless the cart was transformed). */
    sourceIndex: number;
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
    /**
     * The currency every amount here is in (the market's, MARKETS-DESIGN step
     * 6) and how shop-currency amounts convert into it; checkout prices the
     * whole order with it.
     */
    money: PresentmentMoney;
    valid: boolean;
    issues: StorefrontCartItemIssue[];
    items: StorefrontCartValidatedItem[];
    /** At catalog prices: bundle savings and promotions are discounts on top. */
    subtotalMinor: number;
    hasFreeDeliveryProduct: boolean;
    /** Products whose quantity reached a bundle tier; absent means none. */
    bundles?: StorefrontCartBundleSaving[];
    /**
     * Set when `cart.transform` rewrote the buyer's lines: `items` and
     * `issues` are then the rewritten lines' (what checkout orders), and
     * `presentTransformedCart` gives the buyer's view.
     */
    transform?: TransformedCart;
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
    /** Every active market's pricing (`marketPricingMatrixSql`), the same on every row. */
    pricingMatrix?: string | null;
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
    weight?: number | null;
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
    /** A digital SKU with a ready licence-key pool: its unused keys (it sells no more); null otherwise. */
    digitalKeys?: number | null;
    /** Its active list prices in every market (`checkoutListPricesSql`); null without any. */
    listPrices?: string | null;
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

/**
 * A unit's catalogue price: the SKU's own discount wins, otherwise the
 * product discount applies to the SKU price; then, in a market that prices
 * its own way, `resolvePrice()` (MARKETS-DESIGN D5: sale, segment and market
 * lists, then FX) at the quantity of this SKU in the cart (quantity breaks).
 */
function calculateUnitPrice(
    product: StorefrontCartProductRow,
    variant: StorefrontCartVariantRow,
    priceIncrementMinor: number,
    priceScope: CheckoutPriceScope | null,
    quantity: number,
    app: AppLinePrice | null,
): { amountMinor: number; source: ResolvedPriceSource } {
    const variantHasDiscount =
        (variant.discountType === "percentage" && variant.discountBps > 0) ||
        (variant.discountType === "flat" && variant.discountAmountMinor > 0);
    const discount = variantHasDiscount ? variant : product;
    const effectiveMinor = discountedPriceMinor(
        variant.priceMinor,
        discount.discountType,
        discount.discountBps,
        discount.discountAmountMinor,
        priceIncrementMinor,
    );
    if (!priceScope?.market) {
        if (!app) return { amountMinor: effectiveMinor, source: "base" };
        const resolved = resolvePrice({
            base: { priceMinor: variant.priceMinor, effectiveMinor },
            prices: [],
            fx: null,
            incrementMinor: priceScope?.incrementMinor ?? priceIncrementMinor,
            app,
        });
        return { amountMinor: resolved.amountMinor, source: resolved.source };
    }
    const resolved = resolveCheckoutSkuPrice(
        priceScope,
        { priceMinor: variant.priceMinor, effectiveMinor },
        parseMarketListPrices(variant.listPrices),
        quantity,
        app,
    );
    return { amountMinor: resolved.amountMinor, source: resolved.source };
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

    // Licence keys are a key-delivered SKU's stock: never sell more than are left.
    const onHand = typeof variant.digitalKeys === "number" ? Math.min(variant.stock, variant.digitalKeys) : variant.stock;
    return Math.max(0, onHand - variant.reservedStock);
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

/**
 * The cart's products, only those published to the order's sales channel
 * (MARKETS-DESIGN D6): a product the channel does not sell is unavailable.
 */
export function selectStorefrontCartProductRows(
    db: Database,
    productIds: readonly string[],
    salesChannelId: string = ONLINE_STORE_CHANNEL_ID,
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
            // Every active market's pricing, in a statement checkout already runs.
            pricingMatrix: marketPricingMatrixSql(),
        })
        .from(products)
        .where(
            and(
                sql`${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                )`,
                // Filters, not indexes: the id set drives (no D1 statistics; an
                // is_active/deleted_at index walk reads every live product).
                sql`+${products.isActive} = 1`,
                sql`+${products.deletedAt} IS NULL`,
                productPublishedToChannelSql(sql`${products.id}`, salesChannelId),
            ),
        );
}

/** The cart's SKUs; `stock` is what the order's channel sells (its linked locations' on-hand). */
export function selectStorefrontCartVariantRows(
    db: Database,
    productIds: readonly string[],
    variantIds: readonly string[],
    salesChannelId: string = ONLINE_STORE_CHANNEL_ID,
) {
    const productIdSet = JSON.stringify([...new Set(productIds)]);
    const variantIdSet = JSON.stringify([...new Set(variantIds)]);
    return db
        .select({
            id: productVariants.id,
            weight: productVariants.weight,
            productId: productVariants.productId,
            optionCombinationKey: productVariants.optionCombinationKey,
            optionLabel: variantOptionLabelSql(productVariants.id),
            stock: channelOnHandSql({ id: sql`${productVariants.id}`, stock: sql`${productVariants.stock}` }, salesChannelId).mapWith(Number),
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
            // A key-delivered SKU sells at most its unused keys (null for every other SKU).
            digitalKeys: sql<number | null>`CASE WHEN ${productVariants.fulfillmentKind} = 'digital' THEN ${digitalUnusedKeysSql(productVariants.id)} ELSE NULL END`
                .mapWith((value) => (value === null || value === undefined ? null : Number(value))),
            // Its list prices in every market (null without any): no extra statement.
            listPrices: checkoutListPricesSql(),
        })
        .from(productVariants)
        // One id set (the cart's SKUs and its products' live SKUs), read by
        // primary key: an OR of two IN sets is an index union on SQLite but a
        // sequential scan of every SKU on PostgreSQL.
        .where(and(
            sql`${productVariants.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${variantIdSet})
                UNION ALL
                SELECT product_sku."id" FROM "product_variants" AS product_sku
                WHERE product_sku."product_id" IN (SELECT CAST(value AS TEXT) FROM json_each(${productIdSet}))
                  AND product_sku."deleted_at" IS NULL
            )`,
            isNull(productVariants.deletedAt),
        ));
}

export function resolveStorefrontCartValidationFromRows(
    items: StorefrontCartValidationItem[],
    options: {
        inventoryPool?: string | null;
        currencyCode?: string | null;
        /** The store's price increment (`PricingCurrency`); absent, the currency's default. */
        priceIncrementMinor?: number | null;
        /** The market that prices the cart (`resolveCheckoutPriceScope`); absent: base prices. */
        priceScope?: CheckoutPriceScope | null;
        /** `cart.line_prices` answers by line index (app-line-prices.ts). */
        appPrices?: ReadonlyMap<number, AppLinePrice>;
        /**
         * Skip the submitted-price check: the first pass of an app-priced
         * cart, whose final prices are not known yet (never a final answer).
         */
        deferSubmittedPriceCheck?: boolean;
    },
    productRows: readonly StorefrontCartProductRow[],
    variantRows: readonly StorefrontCartVariantRow[],
    mediaByProduct: ReadonlyMap<string, ProductMediaProjection[]>,
    /** The products' active bundle tiers (`selectActiveProductBundleRows`). */
    bundleRows: readonly ProductBundleRow[] = [],
): StorefrontCartValidationResult {
    // API callers pass the normalized merchant setting. Direct Core callers
    // intentionally retain the historical BDT checkout authority fallback.
    const shopCurrencyCode = normalizeSupportedCurrencyCode(options.currencyCode) ?? DEFAULT_CURRENCY.code;
    const shopIncrementMinor = resolvePriceIncrementMinor(shopCurrencyCode, options.priceIncrementMinor);
    // The cart's currency is its market's (MARKETS-DESIGN step 6): catalogue
    // prices, surcharges and bundle prices are in it.
    const money = options.priceScope?.money ?? shopPresentment({
        code: shopCurrencyCode,
        decimalPlaces: getDecimalPlaces(shopCurrencyCode),
        priceIncrementMinor: shopIncrementMinor,
    });
    const decimalPlaces = money.decimalPlaces;
    const priceIncrementMinor = money.incrementMinor;
    const presentShopAmount = (shopMinor: number) => presentShopMinor(money, shopMinor);

    if (items.length === 0) {
        return markTrustedStorefrontCartValidationResult({
            money,
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
            money,
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

        const storedSchemaRead = parseStoredCustomizationSchema(product.customizationSchema);
        // A gift card also takes the recipient inputs the product page shows.
        const schemaRead = storedSchemaRead.ok && isGiftCard
            ? { ok: true as const, schema: withGiftCardRecipientFields(storedSchemaRead.schema) }
            : storedSchemaRead;
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
        // Surcharges in the cart's currency, converted as the product page shows them.
        const resolvedProperties = resolveLineProperties(
            isForeignPresentment(money) ? mapCustomizationPrices(schemaRead.schema, presentShopAmount) : schemaRead.schema,
            item.properties,
        );
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

        // Gift cards are money: an app never prices one.
        const appPrice = isGiftCard ? null : options.appPrices?.get(index) ?? null;
        const { amountMinor: baseUnitPriceMinor, source: priceSource } = calculateUnitPrice(
            product,
            variant,
            shopIncrementMinor,
            options.priceScope ?? null,
            requestedForVariant,
            appPrice,
        );
        const propertiesPriceMinor = resolvedProperties.propertiesPriceMinor;
        const unitPriceMinor = baseUnitPriceMinor + propertiesPriceMinor;
        const submittedPriceMinor = typeof item.price === "number"
            ? Number.isFinite(item.price) && item.price >= 0 ? toMinor(item.price, decimalPlaces) : -1
            : undefined;
        if (!options.deferSubmittedPriceCheck && submittedPriceMinor !== undefined && submittedPriceMinor !== unitPriceMinor) {
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

        // A line's amount must stay exact money (a wholesale quantity of an expensive item).
        if (!isLineAmountInRange(unitPriceMinor, item.quantity)) {
            addIssue(issues, item, index, {
                code: "QUANTITY_UNAVAILABLE",
                action: "reduce_quantity",
                message: `That many of ${displayName} is more than one order can hold.`,
                productName: product.name,
                variantLabel: requestedVariantLabel,
            });
            return;
        }

        const image = resolveSkuImageRepresentation(
            mediaByProduct.get(product.id) ?? [],
            variant.imageId,
        );
        subtotalMinor += unitPriceMinor * item.quantity;
        // Only a line that ships can waive delivery: a digital or service
        // product marked "free delivery" must not make a mixed order's parcel free.
        hasFreeDeliveryProduct ||= product.freeDelivery === true && fulfillmentKind === "physical" && !isGiftCard;
        validatedItems.push({
            index,
            cartKey: item.cartKey ?? null,
            productId: product.id,
            variantId: variant.id,
            quantity: item.quantity,
            unitPriceMinor,
            baseUnitPriceMinor,
            priceSource,
            bundle: item.bundle ?? null,
            sourceIndex: item.sourceIndex ?? index,
            propertiesPriceMinor,
            properties: resolvedProperties.properties,
            canonicalProperties: resolvedProperties.canonical,
            fulfillmentKind,
            isGiftCard,
            productName: product.name,
            variantLabel: requestedVariantLabel,
            weightGrams: variant.weight ?? null,
            freeDelivery: product.freeDelivery,
            inventoryTracked: variant.trackInventory,
            availableQuantity: Number.isFinite(availableQuantity) ? availableQuantity : null,
            taxClassId: variant.taxClassId ?? product.taxClassId,
            productImageMediaId: image?.mediaId ?? null,
            productImage: image?.url ?? null,
        });
    });

    const bundles = resolveCartBundleSavings(validatedItems, presentBundleRows(bundleRows, money), priceIncrementMinor);

    return markTrustedStorefrontCartValidationResult({
        money,
        valid: issues.length === 0,
        issues,
        items: validatedItems,
        subtotalMinor,
        hasFreeDeliveryProduct,
        bundles,
    });
}

/**
 * Bundle tiers in the cart's currency: a fixed tier price (shop currency) is
 * converted at the market's rate and rounded to its increment, as the
 * product page shows it; percentage tiers need nothing.
 */
export function presentBundleRows<T extends ProductBundleRow>(rows: readonly T[], money: PresentmentMoney): T[] {
    if (!isForeignPresentment(money)) return [...rows];
    return rows.map((row) => row.discountType === "fixed_price" && Number.isSafeInteger(row.priceMinor) && Number(row.priceMinor) > 0
        ? { ...row, priceMinor: presentShopMinor(money, Number(row.priceMinor)) }
        : row);
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
    priceIncrementMinor: number,
): StorefrontCartBundleSaving[] {
    const { lineSavings, bundles } = bundleLineSavings(
        items.filter((item) => !item.isGiftCard),
        bundleRows,
        priceIncrementMinor,
    );
    for (const item of items) item.bundleDiscountMinor = lineSavings.get(item) ?? 0;
    return bundles;
}

/** A cart line as quantity bundles price it: catalog unit price before buyer-input surcharges. */
export interface BundlePricedLine {
    productId: string;
    baseUnitPriceMinor: number;
    quantity: number;
}

/**
 * The one bundle pricing rule (`bundleGroupPricing` over every line of a
 * product) for the order, the tax quote and the cart's discount preview.
 */
export function bundleLineSavings<TLine extends BundlePricedLine>(
    lines: readonly TLine[],
    bundleRows: readonly ProductBundleRow[],
    /** The store's price increment. */
    priceIncrementMinor: number,
): { lineSavings: Map<TLine, number>; bundles: StorefrontCartBundleSaving[] } {
    const lineSavings = new Map<TLine, number>();
    if (bundleRows.length === 0) return { lineSavings, bundles: [] };
    const tiersByProduct = productBundleTiersByProduct(bundleRows);
    const linesByProduct = new Map<string, TLine[]>();
    for (const item of lines) {
        if (!tiersByProduct.has(item.productId)) continue;
        const group = linesByProduct.get(item.productId) ?? [];
        group.push(item);
        linesByProduct.set(item.productId, group);
    }
    const savings: StorefrontCartBundleSaving[] = [];
    for (const [productId, group] of linesByProduct) {
        const pricing = bundleGroupPricing(
            group.map((line, position) => ({ key: String(position), unitPriceMinor: line.baseUnitPriceMinor, quantity: line.quantity })),
            tiersByProduct.get(productId)!,
            priceIncrementMinor,
        );
        if (!pricing.tier || pricing.savingMinor === 0) continue;
        pricing.lineSavings.forEach((saving, position) => {
            lineSavings.set(group[position]!, saving.savingMinor);
        });
        savings.push({
            productId,
            quantity: pricing.tier.quantity,
            discountType: pricing.tier.discountType,
            label: pricing.tier.label,
            savingMinor: pricing.savingMinor,
        });
    }
    return { lineSavings, bundles: savings };
}

/**
 * Bundle savings for the cart's discount preview (before delivery is known),
 * from the products' active tiers. Lines are priced as the buyer's cart sends
 * them; the authoritative tax quote re-prices from the catalog.
 */
export async function previewStorefrontBundleSavings<TLine extends BundlePricedLine>(
    db: Database,
    lines: readonly TLine[],
    /** The cart currency's price increment. */
    priceIncrementMinor: number,
    /** A cart in a market's own currency: fixed tier prices convert into it. */
    money?: PresentmentMoney | null,
): Promise<{ lineSavings: Map<TLine, number>; bundles: StorefrontCartBundleSaving[] }> {
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const bundleRows = productIds.length > 0 ? await selectActiveProductBundleRows(db, productIds) : [];
    const rows = (bundleRows ?? []) as ProductBundleRow[];
    return bundleLineSavings(lines, money ? presentBundleRows(rows, money) : rows, priceIncrementMinor);
}

export async function validateStorefrontCartItems(
    db: Database,
    items: StorefrontCartValidationItem[],
    options: {
        inventoryPool?: string | null;
        currencyCode?: string | null;
        priceIncrementMinor?: number | null;
        /** Which market prices the cart (MARKETS-DESIGN D5); absent: the backup market's prices. */
        market?: CheckoutMarketSignals;
        /** The sales channel the cart sells from (MARKETS-DESIGN D6); absent: the online store. */
        salesChannelId?: string;
        /** The apps' `cart.line_prices` (app-line-prices.ts); absent: catalogue prices only. */
        linePricer?: AppLinePricer;
        /** The apps' `cart.transform` (cart-transform.ts); absent: the buyer's lines as they are. */
        transformer?: CartTransformer;
    } = {},
): Promise<StorefrontCartValidationResult> {
    if (items.length === 0 || items.some((item) => !isPersistedVariantId(item.variantId))) {
        return resolveStorefrontCartValidationFromRows(items, options, [], [], new Map());
    }
    if (!options.transformer) return validateCartLines(db, items, options);
    // The apps see the cart priced once (before their own prices), then the
    // rewritten lines are read and validated like any cart.
    const preliminary = await validateCartLines(db, items, { ...options, linePricer: undefined, deferSubmittedPriceCheck: true });
    const transform = await options.transformer(items, preliminary);
    if (!transform) return validateCartLines(db, items, options);
    const result = await validateCartLines(db, transform.items, options);
    result.transform = transform;
    return result;
}

async function validateCartLines(
    db: Database,
    items: StorefrontCartValidationItem[],
    options: {
        inventoryPool?: string | null;
        currencyCode?: string | null;
        priceIncrementMinor?: number | null;
        market?: CheckoutMarketSignals;
        salesChannelId?: string;
        linePricer?: AppLinePricer;
        deferSubmittedPriceCheck?: boolean;
    },
): Promise<StorefrontCartValidationResult> {
    const productIds = [...new Set(items.map((item) => item.productId))];
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const [productRows, variantRows, bundleRows] = await Promise.all([
        selectStorefrontCartProductRows(db, productIds, options.salesChannelId),
        selectStorefrontCartVariantRows(db, productIds, variantIds, options.salesChannelId),
        selectActiveProductBundleRows(db, productIds),
    ]);
    // Media is presentation snapshot data, so keep it outside catalog authority
    // checks while still persisting the exact image asset chosen at checkout.
    // The market's prices (segment membership only when a segment list applies) ride beside it.
    const currencyCode = normalizeSupportedCurrencyCode(options.currencyCode) ?? DEFAULT_CURRENCY.code;
    const [mediaByProduct, priceScope] = await Promise.all([
        loadProductMediaProjections(db, productIds),
        resolveCheckoutPriceScope(db, {
            items,
            productRows: productRows as StorefrontCartProductRow[],
            variantRows: variantRows as StorefrontCartVariantRow[],
            currency: { code: currencyCode, incrementMinor: resolvePriceIncrementMinor(currencyCode, options.priceIncrementMinor) },
            signals: options.market ?? {},
        }),
    ]);

    return resolveCartWithAppLinePrices(options.linePricer, (pass) => resolveStorefrontCartValidationFromRows(
        items,
        { ...options, priceScope, ...pass, deferSubmittedPriceCheck: options.deferSubmittedPriceCheck || pass.deferSubmittedPriceCheck },
        productRows as StorefrontCartProductRow[],
        variantRows as StorefrontCartVariantRow[],
        mediaByProduct,
        (bundleRows ?? []) as ProductBundleRow[],
    ));
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
    const { subtotalMinor, items, bundles: _bundles, money, transform: _transform, ...rest } = result;
    // Amounts are in the cart's currency (its market's), with its places.
    decimalPlaces = money?.decimalPlaces ?? decimalPlaces;
    return {
        ...rest,
        currencyCode: money?.currencyCode,
        decimalPlaces,
        ...presentStorefrontCartFulfilmentSummary(fulfilment),
        items: items.map(({
            unitPriceMinor,
            baseUnitPriceMinor,
            canonicalProperties,
            isGiftCard: _isGiftCard,
            bundleDiscountMinor: _bundleDiscountMinor,
            priceSource: _priceSource,
            bundle: _bundle,
            sourceIndex: _sourceIndex,
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
 * cash on delivery when nothing is shipped, collected or performed, and
 * without a method that doesn't serve the delivery country (cash on
 * delivery serves Bangladesh; MARKETS-DESIGN step 3b). A pickup or an order
 * that ships nothing has no delivery country.
 */
export function resolveCartPaymentMethods(
    enabledMethods: readonly string[],
    summary: Pick<StorefrontCartFulfilmentSummary, "allowsCashOnDelivery">,
    deliveryCountryCode: string | null = null,
    providers: Pick<PaymentProviders, "countryIssue" | "currencyIssue"> = BUILT_IN_PAYMENT_PROVIDERS,
    /**
     * The order's currency (its market's, MARKETS-DESIGN step 6): a gateway
     * that cannot charge it is not offered (`chargeCurrencies`). Absent: no
     * currency filter (the shop currency, which settings already checked).
     */
    currencyCode: string | null = null,
): string[] {
    return enabledMethods.filter((method) =>
        (method !== "cod" || summary.allowsCashOnDelivery)
        && providers.countryIssue(method, deliveryCountryCode) === null
        && (currencyCode === null || providers.currencyIssue(method, currencyCode) === null));
}
