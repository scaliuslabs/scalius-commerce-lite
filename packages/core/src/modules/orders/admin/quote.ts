// Manual order quotes: SKU resolution, inventory facts and money for staff-created orders.
import type { AppProviders } from "../../../integrations/provider-port";
import type { Database } from "@scalius/database/client";
import { products, productVariants, shippingMethods } from "@scalius/database/schema";
import { orderPricePolicy, storeCurrencyCodeSql, toStoreMinor } from "../../settings";
import { readStoreCurrency, storeCurrencyFromSql, storePriceIncrementSql } from "../../markets";
import { and, sql, eq, inArray, isNull } from "drizzle-orm";
import {
    isAutoFulfillmentType,
    isFulfillmentKind,
    resolveCheckoutFulfilment,
    type DeliveryMethodKind,
    type FulfillmentKind,
    type FulfillmentType,
} from "@scalius/shared/fulfilment";
import {
    parseStoredCustomizationSchema,
    resolveLineProperties,
    serializeOrderLineProperties,
} from "@scalius/shared/line-properties";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import { isLineAmountInRange } from "@scalius/shared/order-limits";
import type { QuoteManualOrderInput } from "../validation";
import {
    checkoutListPricesSql,
    marketPricingMatrixSql,
    parseMarketListPrices,
    resolveCheckoutPriceScope,
    resolveCheckoutSkuPrice,
    type CheckoutMarketSignals,
} from "../../price-lists";
import { ValidationError } from "@scalius/core/errors";
import { usesDeliveryHierarchy } from "@scalius/shared/address";
import { addressRulesFor } from "@scalius/shared/address-metadata";
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "@scalius/shared/markets";
import {
    BUILT_IN_PAYMENT_PROVIDERS,
    CASH_ON_DELIVERY_AMOUNT_REASON,
    COD_PAYMENT_METHOD,
    createOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "../../payments";
import { buildStorefrontTaxAllocationLineId, calculateStorefrontTaxQuote, taxAddressSource } from "../../tax";
import { billingTaxLocation } from "../billing-address";
import { type TaxQuote } from "../../tax/browser";
import {
  loadProductMediaProjections,
  resolveSkuImageRepresentation,
  variantOptionLabelSql,
} from "../../products";
import { resolveActiveDeliveryLocationNames } from "../../delivery";
import type { FunctionCart } from "@scalius/shared/plugins";
import type {
    AppliedAppDiscount,
    ManualOrderAppFunctions,
    ManualOrderAppInput,
    ManualOrderAppOutcome,
} from "@scalius/shared/checkout-app-facts";
import { manualOrderAppLines } from "./app-lines";

type AdminOrderSkuItem = { productId: string; variantId: string | null; quantity?: number };
type AdminOrderItemWithInventory<T extends AdminOrderSkuItem> = T & {
    variantId: string;
    inventoryTracked: boolean;
    productName: string;
    variantLabel: string | null;
    productImageMediaId: string | null;
    taxClassId: string | null;
    catalogUnitPriceMinor: number;
    fulfillmentKind: FulfillmentKind;
    isGiftCard: boolean;
    /** Raw `products.customization_schema`, resolved per line by the quote. */
    customizationSchema: string | null;
};
type AdminOrderSkuIssueCode =
    | "SKU_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "PRODUCT_UNAVAILABLE"
    | "PROPERTIES_REQUIRED"
    | "PROPERTIES_INVALID"
    | "FULFILMENT_UNAVAILABLE";

/** The delivery method a manual order uses, as snapshotted on the order. */
export interface ManualOrderDeliveryMethod {
    id: string;
    name: string;
    description: string | null;
    feeMinor: number;
    kind: DeliveryMethodKind;
    pickupAddress: string | null;
    pickupHours: string | null;
}

/** A line the amendment keeps: its agreed price and frozen buyer inputs. */
export interface RetainedManualOrderLine {
    variantId: string | null;
    unitPriceMinor: number;
    fulfillmentType?: string | null;
    properties?: string | null;
    propertiesPriceMinor?: number | null;
    baseUnitPriceMinor?: number | null;
}

interface ManualOrderMoneyItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPriceMinor: number;
    /** Gift-card lines take no share of the order discount (Wave B §4.2). */
    isGiftCard?: boolean;
}

/**
 * The tax-quote lines of a manual order. Gift-card lines agree with
 * storefront checkout: tax-exempt at sale and outside the order discount.
 */
export function manualOrderTaxLines(
    items: ReadonlyArray<ManualOrderMoneyItem & { variantId: string; taxClassId: string | null }>,
    allocationLineIds: readonly string[],
) {
    return items.map((item, index) => ({
        lineId: allocationLineIds[index]!,
        productId: item.productId,
        variantId: item.variantId,
        unitPriceMinor: item.unitPriceMinor,
        quantity: item.quantity,
        taxClassId: item.taxClassId,
        ...(item.isGiftCard ? { taxExempt: true, discountExempt: true } : {}),
    }));
}

/** Order totals in integer minor units: total = subtotal + shipping − discount. */
export function calculateManualOrderMoney(
    items: ManualOrderMoneyItem[],
    shippingMinor: number,
    discountMinor: number,
    currency: OrderCurrencySnapshot,
) {
    const subtotalAmountMinor = items.reduce(
        (sum, item) => sum + item.unitPriceMinor * item.quantity,
        0,
    );
    // A discount never reduces what gift cards cost (they are money, not merchandise).
    const discountableMinor = items.reduce(
        (sum, item) => sum + (item.isGiftCard ? 0 : item.unitPriceMinor * item.quantity),
        0,
    );
    if (discountMinor > discountableMinor) {
        throw new ValidationError(
            "Discount amount cannot exceed the manual order subtotal.",
            {
                reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
                maximumDiscountAmountMinor: discountableMinor,
                currencyCode: currency.code,
                decimalPlaces: currency.decimalPlaces,
            },
        );
    }
    return {
        subtotalAmountMinor,
        shippingAmountMinor: shippingMinor,
        discountAmountMinor: discountMinor,
        totalAmountMinor: subtotalAmountMinor + shippingMinor - discountMinor,
    };
}

export interface ManualOrderQuote {
    currencyCode: string;
    decimalPlaces: number;
    subtotalAmount: number;
    shippingAmount: number;
    discountAmount: number;
    taxAmount: number;
    totalAmount: number;
    taxLabel: string;
    pricesIncludeTax: boolean;
    taxEnabled: boolean;
    settingsVersion: number;
    lines: Array<{
        index: number;
        productId: string;
        variantId: string;
        quantity: number;
        unitPrice: number;
        lineSubtotal: number;
    }>;
    /**
     * Installed apps' discounts (checkout functions), after the staff
     * discount; `discountAmount` includes them. `amount` is off the items,
     * `shippingAmount` off delivery.
     */
    appDiscounts: Array<{
        appId: string;
        appName: string;
        title: string;
        amount: number;
        shippingAmount: number;
    }>;
}

interface PreparedManualOrderLine extends AdminOrderItemWithInventory<ManualOrderMoneyItem> {
    fulfillmentType: FulfillmentType;
    /** Serialized snapshot for `order_items.properties`; null without inputs. */
    properties: string | null;
    propertiesPriceMinor: number;
    baseUnitPriceMinor: number;
}

export interface PreparedManualOrderQuote {
    /** The order's currency at the price increment staff amounts are entered in. */
    currency: OrderCurrencySnapshot & { priceIncrementMinor: number };
    locationNames: {
        cityName: string | null;
        zoneName: string | null;
        areaName: string | null;
    };
    /** The shipping country; null when nothing ships. */
    shippingCountryCode: string | null;
    /** Bangladesh's City/Thana/Area destination, stored and taxed; null when nothing ships or outside Bangladesh. */
    address: { city: string; zone: string; area: string | null } | null;
    trackedItems: PreparedManualOrderLine[];
    allocationLineIds: string[];
    taxQuote: TaxQuote;
    quote: ManualOrderQuote;
    requiresShipping: boolean;
    deliveryMethodKind: DeliveryMethodKind | null;
    /** The chosen method as the order keeps it (an app may have renamed or priced it). */
    deliveryMethod: ManualOrderDeliveryMethod | null;
    /** The staff discount in minor units (before the apps'). */
    manualDiscountMinor: number;
    /** App discounts the order carries (after the staff discount). */
    appDiscounts: AppliedAppDiscount[];
    /** The cart apps saw; null when no app implements a cart point. */
    appCart: FunctionCart | null;
}

export interface ManualOrderQuoteOptions {
    /**
     * An amendment keeps the order's delivery method: its kind decides the
     * type of new physical lines. `undefined` means "use shippingMethodId".
     */
    fixedDeliveryMethodKind?: DeliveryMethodKind | null;
    /**
     * The apps' checkout functions, channel "admin", injected by the API
     * (checkout's `createManualOrderAppFunctions`). Amendments pass none: an
     * order an app discounted is not amendable.
     */
    apps?: ManualOrderAppFunctions;
    /** The request's app providers: an app tax provider is asked through them (none: it fails closed). */
    appProviders?: AppProviders;
}

/** No app work: the staff discount and charge stand as entered. */
function withoutApps(input: ManualOrderAppInput): ManualOrderAppOutcome {
    return {
        shippingMinor: input.shippingMinor,
        deliveryMethod: input.deliveryMethod,
        appDiscounts: [],
        discountAllocation: undefined,
        appCart: null,
    };
}

async function loadManualOrderDeliveryMethod(
    db: Database,
    shippingMethodId: string | null | undefined,
): Promise<ManualOrderDeliveryMethod | null> {
    if (!shippingMethodId) return null;
    const row = await db.select({
        id: shippingMethods.id,
        name: shippingMethods.name,
        description: shippingMethods.description,
        feeMinor: shippingMethods.feeMinor,
        kind: shippingMethods.kind,
        pickupAddress: shippingMethods.pickupAddress,
        pickupHours: shippingMethods.pickupHours,
    }).from(shippingMethods).where(and(
        eq(shippingMethods.id, shippingMethodId),
        isNull(shippingMethods.deletedAt),
    )).get();
    if (!row) throw new ValidationError("That delivery method no longer exists. Choose another.");
    return {
        ...row,
        kind: row.kind === "pickup" ? "pickup" : "delivery",
        pickupAddress: row.pickupAddress?.trim() || null,
        pickupHours: row.pickupHours?.trim() || null,
    };
}

function resolveManualOrderLineProperties(
    items: ReadonlyArray<AdminOrderItemWithInventory<ManualOrderMoneyItem & { properties?: unknown; orderItemId?: string | null }>>,
    retainedLines: ReadonlyMap<string, RetainedManualOrderLine> | undefined,
    /** An order in a market's own currency (MARKETS-DESIGN step 6): only its own lines, at their prices. */
    foreignCurrency: string | null = null,
) {
    const issues: AdminOrderSkuIssue[] = [];
    const lines = items.map((item, index) => {
        const retained = item.orderItemId ? retainedLines?.get(item.orderItemId) : undefined;
        if (foreignCurrency && !(retained && retained.variantId === item.variantId)) {
            // Catalogue prices are the shop currency's; the order's locked rate
            // prices only what the buyer agreed to.
            addAdminOrderSkuIssue(issues, item, index, "PRODUCT_UNAVAILABLE",
                `This order is in ${foreignCurrency}. Its items keep their prices; add other items in a new order.`);
            return null;
        }
        if (retained && retained.variantId === item.variantId) {
            // A kept line keeps the price and buyer inputs the customer agreed to.
            const propertiesPriceMinor = retained.propertiesPriceMinor ?? 0;
            return {
                unitPriceMinor: retained.unitPriceMinor,
                baseUnitPriceMinor: retained.baseUnitPriceMinor ?? retained.unitPriceMinor - propertiesPriceMinor,
                propertiesPriceMinor,
                properties: retained.properties ?? null,
            };
        }
        const schema = parseStoredCustomizationSchema(item.customizationSchema);
        if (!schema.ok) {
            addAdminOrderSkuIssue(issues, item, index, "PRODUCT_UNAVAILABLE",
                "This product's buyer inputs are misconfigured. Fix them on the product first.");
            return null;
        }
        const resolved = resolveLineProperties(schema.schema, item.properties);
        if (!resolved.ok) {
            addAdminOrderSkuIssue(issues, item, index, resolved.code, resolved.code === "PROPERTIES_REQUIRED"
                ? "Fill in the buyer inputs this product requires."
                : "Check the buyer inputs for this item.");
            return null;
        }
        return {
            unitPriceMinor: item.catalogUnitPriceMinor + resolved.propertiesPriceMinor,
            baseUnitPriceMinor: item.catalogUnitPriceMinor,
            propertiesPriceMinor: resolved.propertiesPriceMinor,
            properties: serializeOrderLineProperties(resolved.properties),
        };
    });
    if (issues.length > 0) throwAdminOrderSkuIssues(issues);
    return lines.map((line) => line!);
}

function projectManualOrderQuote(
    taxQuote: TaxQuote,
    trackedItems: PreparedManualOrderQuote["trackedItems"],
    appDiscounts: readonly AppliedAppDiscount[] = [],
): ManualOrderQuote {
    const amount = (value: number) => fromMinor(value, taxQuote.decimalPlaces);
    return {
        currencyCode: taxQuote.currencyCode,
        decimalPlaces: taxQuote.decimalPlaces,
        subtotalAmount: amount(taxQuote.subtotalMinor),
        shippingAmount: amount(taxQuote.shippingMinor),
        discountAmount: amount(taxQuote.discountMinor),
        taxAmount: amount(taxQuote.taxMinor),
        totalAmount: amount(taxQuote.totalMinor),
        taxLabel: taxQuote.displayLabel,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        taxEnabled: taxQuote.enabled,
        settingsVersion: taxQuote.settingsVersion,
        lines: trackedItems.map((item, index) => ({
            index,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: amount(item.unitPriceMinor),
            lineSubtotal: amount(taxQuote.lines[index]?.grossAmountMinor ?? 0),
        })),
        appDiscounts: appDiscounts.map((discount) => ({
            appId: discount.pluginId,
            appName: discount.appName,
            title: discount.title,
            amount: amount(discount.amountMinor),
            shippingAmount: amount(discount.shippingAmountMinor),
        })),
    };
}

export async function prepareManualOrderQuote(
    db: Database,
    data: QuoteManualOrderInput,
    currencyOverride?: OrderCurrencySnapshot,
    retainedLines?: ReadonlyMap<string, RetainedManualOrderLine>,
    options: ManualOrderQuoteOptions = {},
): Promise<PreparedManualOrderQuote> {
    // Amounts staff enter are on the store's price increment (a BDT store's
    // default: whole taka); an amended order keeps its own currency.
    const store = await readStoreCurrency(db);
    const currency = orderPricePolicy(currencyOverride ?? createOrderCurrencySnapshot(store.code), store);
    // Keep location validation first so a stale/cross-parent destination fails
    // before catalog or tax reads do unnecessary work. A pickup or
    // service-only order sends no address and skips it.
    // Outside Bangladesh there are no City/Thana ids: only store-wide tax
    // applies and the staff-entered charge is the delivery fee.
    const submittedCountry = data.shippingCountryCode?.trim()
        ? normalizeMarketCountry(data.shippingCountryCode)
        : DELIVERY_HIERARCHY_COUNTRY;
    if (!submittedCountry || !addressRulesFor(submittedCountry)) {
        throw new ValidationError("We can't take addresses in that country.", { reason: "address_invalid", issues: [{ field: "countryCode", code: "unknown_country" }] });
    }
    const inDeliveryHierarchy = usesDeliveryHierarchy(submittedCountry);
    const submittedCity = inDeliveryHierarchy ? data.city?.trim() : undefined;
    const submittedZone = inDeliveryHierarchy ? data.zone?.trim() : undefined;
    const submittedAddress = submittedCity && submittedZone
        ? { city: submittedCity, zone: submittedZone, area: data.area?.trim() || null }
        : null;
    const submittedLocationNames = submittedAddress
        ? await resolveActiveDeliveryLocationNames(db, submittedAddress)
        : null;
    const deliveryMethod = options.fixedDeliveryMethodKind === undefined
        ? await loadManualOrderDeliveryMethod(db, data.shippingMethodId)
        : null;

    // One delivery method per order (Wave A §2.7). A staff order with a
    // physical line and no method picked ships to the address, as before.
    const chosenKind: DeliveryMethodKind | null = options.fixedDeliveryMethodKind !== undefined
        ? options.fixedDeliveryMethodKind
        : deliveryMethod?.kind ?? "delivery";
    // The order's market prices its lines (MARKETS-DESIGN D5), as the order
    // records it: the shipping country when a physical line ships (a pickup
    // ships nothing), else the billed country. Segment lists need the buyer,
    // whom a staff quote does not know yet: left for later.
    const resolvedItems = await resolveAdminOrderItemInventory(db, data.items, {
        shippingCountryCode: chosenKind === "pickup" ? null : submittedCountry,
        billingCountryCode: data.billingCountryCode ?? null,
    });
    const plan = resolveCheckoutFulfilment(resolvedItems.map((item) => ({
        fulfillmentKind: item.fulfillmentKind,
        isGiftCard: item.isGiftCard,
    })), chosenKind);
    if (!plan.ok) {
        throw new ValidationError(plan.issue === "DELIVERY_METHOD_REQUIRED"
            ? "This order has no delivery method, so it can't take items that ship. Create a new order for them."
            : "Add at least one sellable item.");
    }
    // Staff orders are cash on delivery; digital and gift-card lines fulfil
    // automatically and have no fulfiller until Wave B, so they fail closed.
    const unavailable: AdminOrderSkuIssue[] = [];
    plan.lineTypes.forEach((type, index) => {
        if (isAutoFulfillmentType(type)) {
            addAdminOrderSkuIssue(unavailable, resolvedItems[index]!, index, "FULFILMENT_UNAVAILABLE",
                "Digital items and gift cards can't be added to an order yet.");
        }
    });
    if (unavailable.length > 0) throwAdminOrderSkuIssues(unavailable);

    let address: PreparedManualOrderQuote["address"] = null;
    let locationNames: PreparedManualOrderQuote["locationNames"] = { cityName: null, zoneName: null, areaName: null };
    if (plan.requiresShipping && inDeliveryHierarchy) {
        if (!submittedAddress || !submittedLocationNames) {
            throw new ValidationError("Choose the delivery city and thana, or a pickup method.");
        }
        address = submittedAddress;
        locationNames = submittedLocationNames;
    }
    const shippingCountryCode = plan.requiresShipping ? submittedCountry : null;

    const lineProperties = resolveManualOrderLineProperties(
        resolvedItems.map((item, index) => ({
            ...item,
            orderItemId: (data.items[index] as { orderItemId?: string | null } | undefined)?.orderItemId ?? null,
            unitPriceMinor: item.catalogUnitPriceMinor,
        })),
        retainedLines,
        currency.code !== store.code ? currency.code : null,
    );
    const trackedItems: PreparedManualOrderLine[] = resolvedItems.map((item, index) => ({
        ...item,
        ...lineProperties[index]!,
        fulfillmentType: plan.lineTypes[index]!,
    }));
    const outOfRange = trackedItems.findIndex((item) => !isLineAmountInRange(item.unitPriceMinor, item.quantity));
    if (outOfRange >= 0) {
        throw new ValidationError("That line comes to more than one order can hold. Lower its quantity.", {
            issues: [{ index: outOfRange, code: "QUANTITY_UNAVAILABLE" }],
        });
    }
    const money = calculateManualOrderMoney(
        trackedItems,
        toStoreMinor(data.shippingCharge, currency),
        toStoreMinor(data.discountAmount ?? 0, currency),
        currency,
    );
    const allocationLineIds = trackedItems.map((item, index) =>
        buildStorefrontTaxAllocationLineId(index, item.variantId),
    );
    // The staff discount, then the apps (injected `apps`), then tax. No app: no read, no call.
    const appInput: ManualOrderAppInput = {
        currency: { code: currency.code, decimalPlaces: currency.decimalPlaces, priceIncrementMinor: currency.priceIncrementMinor },
        lines: manualOrderAppLines(trackedItems, allocationLineIds),
        manualDiscountMinor: money.discountAmountMinor,
        shippingMinor: money.shippingAmountMinor,
        // A method picked for an order with nothing physical is not used.
        deliveryMethod: deliveryMethod && plan.deliveryMethodKind ? deliveryMethod : null,
        requiresShipping: plan.requiresShipping,
        shippingCountryCode,
        address,
        shippingAdminArea: data.shippingAdminArea ?? null,
        shippingPostalCode: data.shippingPostalCode ?? null,
        locationNames,
    };
    const appPricing = options.apps ? await options.apps.price(appInput) : withoutApps(appInput);
    // The taxed address: the shipping address; for an order that ships
    // nothing, its billing address when staff gave one; else (pickup, or no
    // billing address) where the store ships from.
    const billingLocation = taxAddressSource({
        deliveryKind: plan.requiresShipping ? "delivery" : plan.deliveryMethodKind === "pickup" ? "pickup" : null,
        hasBillingAddress: Boolean(data.billingCountryCode?.trim()),
    }) === "billing" ? billingTaxLocation(data) : null;
    const taxQuote = await calculateStorefrontTaxQuote(db, {
        destination: {
            city: address?.city ?? null,
            zone: address?.zone ?? null,
            area: address?.area ?? null,
            ...locationNames,
            ...(shippingCountryCode ? {
                countryCode: shippingCountryCode,
                adminArea: data.shippingAdminArea ?? null,
                postalCode: data.shippingPostalCode ?? null,
            } : {}),
            ...(billingLocation ? {
                countryCode: billingLocation.countryCode,
                adminArea: billingLocation.adminArea,
                postalCode: billingLocation.postalCode,
            } : {}),
        },
        ...(billingLocation ? { addressSource: "billing" as const } : {}),
        lines: manualOrderTaxLines(trackedItems, allocationLineIds),
        shippingMinor: appPricing.shippingMinor,
        // Tax follows every discount: the staff discount and the apps'.
        ...(appPricing.discountAllocation
            ? { promotionDiscountAllocation: appPricing.discountAllocation }
            : { discountMinor: money.discountAmountMinor }),
        currency: {
            code: currency.code,
            decimalPlaces: currency.decimalPlaces,
            priceIncrementMinor: currency.priceIncrementMinor,
        },
    }, undefined, { apps: options.appProviders });
    // A staff order is cash on delivery, which collects cash amounts (whole
    // taka in BDT): a total it cannot collect exactly is refused here, so the
    // quote, the create and the amendment all say so before anything commits.
    const cashIssue = BUILT_IN_PAYMENT_PROVIDERS.amountIssue(COD_PAYMENT_METHOD, taxQuote.totalMinor, currency.code);
    if (cashIssue) throw new ValidationError(cashIssue, { reason: CASH_ON_DELIVERY_AMOUNT_REASON });

    return {
        currency,
        locationNames,
        shippingCountryCode,
        address,
        trackedItems,
        allocationLineIds,
        taxQuote,
        quote: projectManualOrderQuote(taxQuote, trackedItems, appPricing.appDiscounts),
        requiresShipping: plan.requiresShipping,
        deliveryMethodKind: plan.deliveryMethodKind,
        deliveryMethod: deliveryMethod && appPricing.deliveryMethod?.id === deliveryMethod.id
            ? { ...deliveryMethod, name: appPricing.deliveryMethod.name, feeMinor: appPricing.deliveryMethod.feeMinor }
            : deliveryMethod,
        manualDiscountMinor: money.discountAmountMinor,
        appDiscounts: appPricing.appDiscounts,
        appCart: appPricing.appCart,
    };
}

export async function quoteManualOrder(
    db: Database,
    data: QuoteManualOrderInput,
    options: Pick<ManualOrderQuoteOptions, "apps" | "appProviders"> = {},
): Promise<ManualOrderQuote> {
    return (await prepareManualOrderQuote(db, data, undefined, undefined, { apps: options.apps, appProviders: options.appProviders })).quote;
}

interface AdminOrderSkuIssue {
    index: number;
    productId: string;
    variantId: string | null;
    code: AdminOrderSkuIssueCode;
    message: string;
}

function throwAdminOrderSkuIssues(issues: AdminOrderSkuIssue[]): never {
    throw new ValidationError("Some manual order items need attention.", { itemIssues: issues });
}

function addAdminOrderSkuIssue(
    issues: AdminOrderSkuIssue[],
    item: AdminOrderSkuItem,
    index: number,
    code: AdminOrderSkuIssueCode,
    message: string,
) {
    issues.push({
        index,
        productId: item.productId,
        variantId: item.variantId ?? null,
        code,
        message,
    });
}

function assertAdminOrderItemsUseSkus(items: AdminOrderSkuItem[]) {
    const issues: AdminOrderSkuIssue[] = [];
    items.forEach((item, index) => {
        if (!item.variantId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "SKU_REQUIRED",
                "Select a product SKU before saving the order.",
            );
        }
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }
}

export async function resolveAdminOrderItemInventory<T extends AdminOrderSkuItem>(
    db: Database,
    items: T[],
    /** The order's market prices the lines (MARKETS-DESIGN D5); absent: base prices. */
    market?: CheckoutMarketSignals,
): Promise<Array<AdminOrderItemWithInventory<T>>> {
    assertAdminOrderItemsUseSkus(items);

    const variantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id)))];
    if (variantIds.length === 0) return [];

    const rows = await db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            trackInventory: productVariants.trackInventory,
            imageId: productVariants.imageId,
            productName: products.name,
            productDiscountType: products.discountType,
            productDiscountBps: products.discountBps,
            productDiscountAmountMinor: products.discountAmountMinor,
            storeCurrencyCode: storeCurrencyCodeSql(),
            storePriceIncrementMinor: storePriceIncrementSql(),
            variantPriceMinor: productVariants.priceMinor,
            variantDiscountType: productVariants.discountType,
            variantDiscountBps: productVariants.discountBps,
            variantDiscountAmountMinor: productVariants.discountAmountMinor,
            taxClassId: sql<string | null>`coalesce(${productVariants.taxClassId}, ${products.taxClassId})`,
            variantLabel: variantOptionLabelSql(productVariants.id),
            variantDeletedAt: productVariants.deletedAt,
            productActive: products.isActive,
            productDeletedAt: products.deletedAt,
            fulfillmentKind: productVariants.fulfillmentKind,
            isGiftCard: products.isGiftCard,
            customizationSchema: products.customizationSchema,
            // The markets' pricing and the SKU's list prices, in the read it already makes.
            pricingMatrix: marketPricingMatrixSql(),
            listPrices: checkoutListPricesSql(),
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, variantIds));

    const skuByVariantId = new Map(rows.map((row) => [row.id, row]));
    const storeCurrency = storeCurrencyFromSql(rows[0]?.storeCurrencyCode, rows[0]?.storePriceIncrementMinor);
    const [mediaByProduct, marketScope] = await Promise.all([
        loadProductMediaProjections(db, [...new Set(rows.map((row) => row.productId))]),
        market
            ? resolveCheckoutPriceScope(db, {
                items: items.flatMap((item) => item.variantId ? [{ productId: item.productId, variantId: item.variantId }] : []),
                productRows: rows.map((row) => ({ id: row.productId, isGiftCard: row.isGiftCard === true, pricingMatrix: row.pricingMatrix })),
                variantRows: rows.map((row) => ({ id: row.id, fulfillmentKind: row.fulfillmentKind, listPrices: row.listPrices })),
                currency: { code: storeCurrency.code, incrementMinor: storeCurrency.priceIncrementMinor },
                signals: { ...market, placing: true },
            })
            : Promise.resolve(null),
    ]);
    // A staff order is in the shop currency (Shopify's draft-order default): a
    // market that sells in its own currency prices only buyer checkouts, so
    // its lines take base prices here (MARKETS-DESIGN step 6).
    const priceScope = marketScope && marketScope.money.currencyCode !== storeCurrency.code ? null : marketScope;
    const quantityByVariant = new Map<string, number>();
    for (const item of items) {
        if (item.variantId) quantityByVariant.set(item.variantId, (quantityByVariant.get(item.variantId) ?? 0) + (item.quantity ?? 1));
    }
    const issues: AdminOrderSkuIssue[] = [];
    const resolvedItems: Array<AdminOrderItemWithInventory<T>> = [];

    items.forEach((item, index) => {
        const variantId = item.variantId!;
        const sku = skuByVariantId.get(variantId);
        if (!sku) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU is no longer available.",
            );
            return;
        }
        if (sku.productId !== item.productId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_MISMATCH",
                "Selected SKU does not belong to this product.",
            );
            return;
        }
        if (sku.variantDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU has been deleted.",
            );
            return;
        }
        if (!sku.productActive || sku.productDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "PRODUCT_UNAVAILABLE",
                "Selected product is not active.",
            );
            return;
        }

        const variantHasDiscount =
            (sku.variantDiscountType === "percentage" && sku.variantDiscountBps > 0)
            || (sku.variantDiscountType === "flat" && sku.variantDiscountAmountMinor > 0);
        const { priceIncrementMinor } = storeCurrencyFromSql(sku.storeCurrencyCode, sku.storePriceIncrementMinor);
        const baseUnitPriceMinor = variantHasDiscount
            ? discountedPriceMinor(
                sku.variantPriceMinor,
                sku.variantDiscountType,
                sku.variantDiscountBps,
                sku.variantDiscountAmountMinor,
                priceIncrementMinor,
            )
            : discountedPriceMinor(
                sku.variantPriceMinor,
                sku.productDiscountType,
                sku.productDiscountBps,
                sku.productDiscountAmountMinor,
                priceIncrementMinor,
            );
        // The order's market: its lists and FX (`resolvePrice`), else this base price.
        const catalogUnitPriceMinor = priceScope?.market
            ? resolveCheckoutSkuPrice(
                priceScope,
                { priceMinor: sku.variantPriceMinor, effectiveMinor: baseUnitPriceMinor },
                parseMarketListPrices(sku.listPrices),
                quantityByVariant.get(variantId) ?? 1,
            ).amountMinor
            : baseUnitPriceMinor;

        resolvedItems.push({
            ...item,
            variantId,
            inventoryTracked: sku.trackInventory,
            productName: sku.productName,
            variantLabel: sku.variantLabel,
            productImageMediaId: resolveSkuImageRepresentation(
                mediaByProduct.get(sku.productId) ?? [],
                sku.imageId,
            )?.mediaId ?? null,
            taxClassId: sku.taxClassId,
            catalogUnitPriceMinor,
            fulfillmentKind: isFulfillmentKind(sku.fulfillmentKind) ? sku.fulfillmentKind : "physical",
            isGiftCard: sku.isGiftCard === true,
            customizationSchema: sku.customizationSchema,
        });
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }

    return resolvedItems;
}
