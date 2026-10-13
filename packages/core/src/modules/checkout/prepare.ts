// src/modules/checkout/prepare.ts
// Storefront order creation — validates and prepares orders for the commit.

import { defaultOrderSalesChannelId } from "@scalius/shared/sales-channels";
import type { Database } from "@scalius/database/client";
import { assertOrderContact, resolveCheckoutContact, type CheckoutContactFieldSettings } from "./contact-fields";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { defaultPriceIncrementMinor, type PricingCurrency } from "@scalius/shared/currency-policy";
import { fromMinor } from "@scalius/shared/money";
import {
    convertStoreCurrencyMinor,
    isForeignPresentment,
    presentmentFx,
    type PresentmentMoney,
    type StoreCurrencyRate,
} from "@scalius/shared/presentment";
import {
  buildStorefrontTaxAllocationLineId,
  type StorefrontTaxAuthoritySnapshot,
  type TaxQuote,
} from "../tax";
import {
    GIFT_CARD_PAYMENT_METHOD,
    GIFT_CARD_UNUSABLE_CODE,
    GIFT_CARD_UNUSABLE_MESSAGE,
    GiftCardChangedError,
    quoteGiftCardTender,
} from "../gift-cards";
import { isGiftCardTenderBlocked } from "@scalius/shared/gift-card-tender";
import { BUILT_IN_PAYMENT_PROVIDERS, CASH_ON_DELIVERY_AMOUNT_REASON, type PaymentProviders } from "../payments";
import { assertDiscountCodesApplied } from "../promotions";
import { PAYMENT_METHOD_UNAVAILABLE_REASON, type CheckoutAppFunctions } from "./app-functions";
import { createAppLinePricer } from "./app-line-prices";
import { bundleLineProperties, createCartTransformer, presentTransformedCart, ruleErrorsOnBuyerLines } from "./cart-transform";
import { assertNoCheckoutRuleErrors, priceStorefrontCheckout } from "./pricing";
import type { AppProviders } from "../../integrations/provider-port";
import {
    PaymentMethod,
    PaymentStatus,
    OrderStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { nanoid } from "nanoid";

import { generateOrderId } from "@scalius/shared/order-utils";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { resolveAddressWithLocation, type ResolvedAddress } from "../customers";
import { checkoutDocument } from "../settings";
import { ValidationError } from "@scalius/core/errors";
import {
  orderBillingAddressColumns,
  orderShippingAddressColumns,
  resolveCheckoutBillingAddress,
  type CreateStorefrontOrderCustomerIdentity,
  type CreateStorefrontOrderIdentity,
  type CreateStorefrontOrderInput,
  type CreateStorefrontOrderResult,
  MAX_ORDER_LINE_ITEMS,
  type StorefrontGiftCardIssue,
  type StorefrontGiftCardTenderSummary,
  type StorefrontOrderShippingMethodSnapshot,
} from "../orders";
import {
    isTrustedStorefrontCartValidationResult,
    summarizeStorefrontCartFulfilment,
    validateStorefrontCartItems,
    type StorefrontCartFulfilmentLine,
    type StorefrontCartFulfilmentSummary,
    type StorefrontCartItemIssue,
    type StorefrontCartValidationResult,
} from "./cart-validation";
import { linePropertiesHash, serializeOrderLineProperties } from "@scalius/shared/line-properties";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import { hasFulfiller } from "../fulfilment";
import {
  type ActiveDeliveryLocationRow,
  type DeliveryRateKind,
  type DeliveryRateRow,
  DELIVERY_RATE_UNAVAILABLE_REASON,
  deliveryRateInCurrency,
  normalizeDeliveryDestination,
  normalizePostalPrefix,
  parseDeliveryRegionRows,
  resolveActiveDeliveryLocationNamesFromRows,
  resolveDeliveryRate,
  resolveDestinationZoneId,
  selectActiveDeliveryLocationRowsByIds,
  selectDeliveryRateRowsByIds,
} from "../delivery";

export interface StorefrontDeliveryPreflightInput {
    /** The address's country (absent: Bangladesh); a `delivery` rate must be one of its zone's. */
    shippingCountryCode?: string | null;
    /** Bangladesh's City/Thana/Area, needed only for a `delivery` rate there; pickup and no-method carts omit them. */
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    /** Another country's admin area and postal code: shipping zones match on them. */
    shippingAdminArea?: string | null;
    shippingPostalCode?: string | null;
    shippingMethodId?: string | null;
}

/** `details.reason` when a delivery rate is chosen but the address is missing. */
export const DELIVERY_ADDRESS_REQUIRED_REASON = "delivery_address_required";

export interface StorefrontDeliveryPreflightResult {
    /**
     * "delivery" ships to the address; "pickup" is collected at the store (no
     * address); null when the cart has nothing physical (no method, no fee).
     */
    kind: DeliveryRateKind | null;
    shippingMinor: number;
    shippingMethod: StorefrontOrderShippingMethodSnapshot | null;
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
    /**
     * The destination the rate was priced for; set only for a `delivery`
     * rate. Bangladesh has its City/Thana/Area ids; another country its
     * admin area code and postal code (letters and digits) when given.
     */
    address: StorefrontDeliveryDestination | null;
    /** Where and when to collect; set only for a `pickup` rate. */
    pickup: { address: string | null; hours: string | null } | null;
    /** Every line's fulfilment type and the order-level consequences. */
    fulfilment: StorefrontCartFulfilmentSummary;
}

export interface StorefrontDeliveryDestination {
    countryCode: string;
    city: string | null;
    zone: string | null;
    area: string | null;
    adminArea: string | null;
    postalCode: string | null;
}

export interface StorefrontCheckoutPolicySnapshot {
    partialPaymentEnabled: boolean;
    /**
     * The countries the active markets sell to (the authority read); a shipped
     * order must go to one, and an order with nothing to ship is placed in one.
     */
    shippingCountries?: readonly string[];
    /** Customer accounts contact fields from the checkout authority read. */
    contactFields?: CheckoutContactFieldSettings;
    /** Settings → Checkout: every order asks for a full billing address (off: Shopify's default). */
    requireFullBillingAddress?: boolean;
    authorityRevision?: number;
    orderCreatedNotificationEnabled?: boolean;
    metaPurchaseEnabled?: boolean;
}

const STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF = Symbol("scalius.storefrontDeliveryPreflightResult");
const STOREFRONT_CHECKOUT_POLICY_SNAPSHOT_PROOF = Symbol("scalius.storefrontCheckoutPolicySnapshot");

function markTrustedStorefrontDeliveryPreflightResult(
    result: StorefrontDeliveryPreflightResult,
): StorefrontDeliveryPreflightResult {
    Object.defineProperty(result, STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF, {
        value: true,
        enumerable: false,
    });
    return result;
}

export function isTrustedStorefrontDeliveryPreflightResult(
    result: StorefrontDeliveryPreflightResult | undefined,
): result is StorefrontDeliveryPreflightResult {
    return Boolean(result && Reflect.get(result, STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF) === true);
}

export function createTrustedStorefrontCheckoutPolicySnapshot(
    snapshot: StorefrontCheckoutPolicySnapshot,
): StorefrontCheckoutPolicySnapshot {
    const trustedSnapshot = { ...snapshot };
    Object.defineProperty(trustedSnapshot, STOREFRONT_CHECKOUT_POLICY_SNAPSHOT_PROOF, {
        value: true,
        enumerable: false,
    });
    return trustedSnapshot;
}

export function isTrustedStorefrontCheckoutPolicySnapshot(
    snapshot: StorefrontCheckoutPolicySnapshot | undefined,
): snapshot is StorefrontCheckoutPolicySnapshot {
    return Boolean(snapshot && Reflect.get(snapshot, STOREFRONT_CHECKOUT_POLICY_SNAPSHOT_PROOF) === true);
}

type DeliveryPreflightCart = Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct" | "subtotalMinor"> & {
    items: readonly StorefrontCartFulfilmentLine[];
    /** The cart's currency: a rate's fee and free-over amount convert into it (MARKETS-DESIGN step 6). */
    money?: PresentmentMoney;
};


/**
 * The delivery facts of a cart (Wave A §2.7). A cart with a physical line
 * needs exactly one method: a `delivery` rate needs the address, a `pickup`
 * rate needs none. A cart with nothing physical has no method, no fee and no
 * address, whatever the buyer sent.
 */
export function resolveStorefrontDeliveryPreflightFromRows(
    data: StorefrontDeliveryPreflightInput,
    cartValidation: DeliveryPreflightCart,
    locationRows: readonly ActiveDeliveryLocationRow[],
    shippingMethodRows: readonly DeliveryRateRow[],
): StorefrontDeliveryPreflightResult {
    if (!summarizeStorefrontCartFulfilment(cartValidation, null).requiresDeliveryMethod) {
        return markTrustedStorefrontDeliveryPreflightResult({
            kind: null,
            shippingMinor: 0,
            shippingMethod: null,
            cityName: null,
            zoneName: null,
            areaName: null,
            address: null,
            pickup: null,
            fulfilment: summarizeStorefrontCartFulfilment(cartValidation, null),
        });
    }

    const storedRateRow = data.shippingMethodId
        ? shippingMethodRows.find((row) => row.id === data.shippingMethodId)
        : undefined;
    const rateRow = storedRateRow ? deliveryRateInCurrency(storedRateRow, cartValidation.money) : undefined;
    if ((rateRow?.kind ?? "delivery") === "pickup") {
        const rate = resolveDeliveryRate({
            rate: rateRow,
            addressZoneId: null,
            subtotalMinor: cartValidation.subtotalMinor,
        });
        const shippingFeeWaived = cartValidation.hasFreeDeliveryProduct || rate.freeOverApplied;
        return markTrustedStorefrontDeliveryPreflightResult({
            kind: "pickup",
            shippingMinor: shippingFeeWaived ? 0 : rate.baseFeeMinor,
            shippingMethod: {
                id: rate.id,
                name: rate.name,
                description: rate.description,
                baseAmountMinor: rate.baseFeeMinor,
                feeWaived: shippingFeeWaived,
            },
            cityName: null,
            zoneName: null,
            areaName: null,
            address: null,
            pickup: {
                address: rateRow?.pickupAddress?.trim() || null,
                hours: rateRow?.pickupHours?.trim() || null,
            },
            fulfilment: summarizeStorefrontCartFulfilment(cartValidation, "pickup"),
        });
    }

    // A delivery rate must be a rate of the destination's zone: the most
    // specific match of its Bangladesh location, postal code, admin area and
    // country (MARKETS-DESIGN step 3b). No zone: no delivery rate.
    const destination = normalizeDeliveryDestination({
        countryCode: data.shippingCountryCode,
        city: data.city,
        zone: data.zone,
        area: data.area,
        adminArea: data.shippingAdminArea,
        postalCode: data.shippingPostalCode,
    });
    let locationNames: { cityName: string | null; zoneName: string | null; areaName: string | null } = {
        cityName: null,
        zoneName: null,
        areaName: null,
    };
    if (destination.countryCode === DELIVERY_HIERARCHY_COUNTRY) {
        if (!destination.city || !destination.zone) {
            throw new ValidationError(
                "Enter the delivery address, city and thana, or choose pickup.",
                { reason: DELIVERY_ADDRESS_REQUIRED_REASON },
            );
        }
        locationNames = resolveActiveDeliveryLocationNamesFromRows(
            { city: destination.city, zone: destination.zone, area: destination.area },
            [...locationRows],
        );
    }
    const address: StorefrontDeliveryDestination = {
        countryCode: destination.countryCode,
        city: destination.city ?? null,
        zone: destination.zone ?? null,
        area: destination.area ?? null,
        adminArea: destination.adminArea ?? null,
        postalCode: destination.postalCode ?? null,
    };
    const rate = resolveDeliveryRate({
        rate: rateRow,
        addressZoneId: resolveDestinationZoneId(destination, {
            locations: locationRows,
            regions: parseDeliveryRegionRows(rateRow?.destinationRegions),
        }),
        subtotalMinor: cartValidation.subtotalMinor,
    });
    const shippingFeeWaived = cartValidation.hasFreeDeliveryProduct || rate.freeOverApplied;

    return markTrustedStorefrontDeliveryPreflightResult({
        kind: rate.kind,
        shippingMinor: shippingFeeWaived ? 0 : rate.baseFeeMinor,
        shippingMethod: {
            id: rate.id,
            name: rate.name,
            description: rate.description,
            baseAmountMinor: rate.baseFeeMinor,
            feeWaived: shippingFeeWaived,
        },
        cityName: locationNames.cityName,
        zoneName: locationNames.zoneName,
        areaName: locationNames.areaName,
        address,
        pickup: null,
        fulfilment: summarizeStorefrontCartFulfilment(cartValidation, "delivery"),
    });
}

export async function validateStorefrontDeliveryPreflight(
    storefrontDb: Database,
    data: StorefrontDeliveryPreflightInput,
    cartValidation: DeliveryPreflightCart,
): Promise<StorefrontDeliveryPreflightResult> {
    if (!summarizeStorefrontCartFulfilment(cartValidation, null).requiresDeliveryMethod) {
        return resolveStorefrontDeliveryPreflightFromRows(data, cartValidation, [], []);
    }
    const destination = normalizeDeliveryDestination({
        countryCode: data.shippingCountryCode,
        city: data.city,
        zone: data.zone,
        area: data.area,
    });
    const readBatch = [
        selectActiveDeliveryLocationRowsByIds(storefrontDb, [destination.city, destination.zone, destination.area]
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)),
        // The rate row carries its destination country's zone regions (same statement).
        selectDeliveryRateRowsByIds(
            storefrontDb,
            data.shippingMethodId ? [data.shippingMethodId] : [],
            [destination.countryCode],
        ),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const [locationRows, shippingMethodRows] = await storefrontDb.batch(readBatch as any);

    return resolveStorefrontDeliveryPreflightFromRows(
        data,
        cartValidation,
        Array.isArray(locationRows) ? locationRows as ActiveDeliveryLocationRow[] : [],
        Array.isArray(shippingMethodRows) ? shippingMethodRows as DeliveryRateRow[] : [],
    );
}

/**
 * Every line of a prepared order has a type with a registered fulfiller
 * (F13). Types come from the delivery preflight, so physical lines are
 * already `ship` or `pickup` here.
 */
export function assertStorefrontLineFulfilment(
    cartValidation: Pick<StorefrontCartValidationResult, "items">,
    delivery: Pick<StorefrontDeliveryPreflightResult, "fulfilment">,
): FulfillmentType[] {
    const issues: StorefrontCartItemIssue[] = [];
    const types = cartValidation.items.map((item, position): FulfillmentType => {
        const type = delivery.fulfilment.lineTypes[position] ?? null;
        if (type === null || !hasFulfiller(type)) {
            issues.push({
                index: item.index,
                cartKey: item.cartKey ?? null,
                productId: item.productId,
                variantId: item.variantId,
                code: "FULFILMENT_UNAVAILABLE",
                action: "remove",
                message: `${item.productName}${item.variantLabel ? ` (${item.variantLabel})` : ""} can't be ordered online right now.`,
                productName: item.productName,
                variantLabel: item.variantLabel,
                requestedQuantity: item.quantity,
            });
            return "ship";
        }
        return type;
    });
    if (issues.length > 0) {
        throw new ValidationError("Some items in your cart need attention.", { itemIssues: issues });
    }
    return types;
}

/** `details.reason` when no active market sells to the shipping country. */
export const SHIPPING_COUNTRY_UNAVAILABLE_REASON = "shipping_country_unavailable";

/**
 * The shipped order's address snapshot (MARKETS-DESIGN D7): Bangladesh's
 * City/Thana/Area from the delivery preflight (which read and checked the
 * locations) fills the locality and thana, and the country's rules check the
 * rest. A buyer can never skip validation. `shippingCountries` (the authority
 * read) are the countries the active markets sell to; another is refused.
 */
export function resolveStorefrontShippingAddress(
    data: Pick<CreateStorefrontOrderInput,
        "shippingCountryCode" | "shippingAddress" | "shippingAddressLine2" | "shippingDependentLocality"
        | "shippingLocality" | "shippingAdminArea" | "shippingPostalCode">,
    delivery: Pick<StorefrontDeliveryPreflightResult, "address" | "cityName" | "zoneName" | "areaName">,
    shippingCountries?: readonly string[],
): ResolvedAddress {
    const destination = delivery.address;
    if (!destination) {
        throw new ValidationError(
            "Enter the delivery address, city and thana, or choose pickup.",
            { reason: DELIVERY_ADDRESS_REQUIRED_REASON },
        );
    }
    if (shippingCountries && !shippingCountries.includes(destination.countryCode)) {
        throw new ValidationError("We don't ship to this country.", {
            reason: SHIPPING_COUNTRY_UNAVAILABLE_REASON,
            countryCode: destination.countryCode,
        });
    }
    // The admin area and postal code are the ones the rate was priced for.
    if (
        destination.countryCode !== DELIVERY_HIERARCHY_COUNTRY
        && (normalizePostalPrefix(data.shippingPostalCode) || null) !== destination.postalCode
    ) {
        throw new ValidationError("The postal code changed since delivery was priced. Review the delivery options.", {
            reason: DELIVERY_RATE_UNAVAILABLE_REASON,
        });
    }
    return resolveAddressWithLocation(
        {
            countryCode: destination.countryCode,
            line1: data.shippingAddress,
            line2: data.shippingAddressLine2,
            dependentLocality: data.shippingDependentLocality,
            locality: data.shippingLocality,
            adminArea: destination.countryCode === DELIVERY_HIERARCHY_COUNTRY ? data.shippingAdminArea : destination.adminArea,
            postalCode: data.shippingPostalCode,
        },
        {
            location: destination.city && destination.zone
                ? {
                    city: destination.city,
                    zone: destination.zone,
                    area: destination.area,
                    cityName: delivery.cityName,
                    zoneName: delivery.zoneName,
                    areaName: delivery.areaName,
                }
                : null,
            problems: [],
        },
    );
}

/** Refusal when a gift card leaves less than the gateway's minimum charge (§4.3). */
export const GIFT_CARD_REMAINDER_TOO_SMALL_MESSAGE =
    "The amount left is too small to pay by card; pay it cash on delivery or use less gift card balance.";

const GIFT_CARD_DUPLICATE_MESSAGE = "This gift card is already applied.";
const GIFT_CARD_NOT_NEEDED_MESSAGE = "Your order is already covered, so this gift card wasn't used.";
const GIFT_CARD_NOT_ELIGIBLE_MESSAGE = "Gift cards can't pay for gift cards, so this one wasn't used.";

/**
 * Gift cards as a tender on a priced order (Wave B §4.3), shared by the tax
 * quote and checkout so the amount a buyer reviews is the amount the order
 * debits. A gift card never pays for gift-card lines; tender never changes
 * taxes or discounts. No handles: no read, amount due = total.
 */
export async function quoteStorefrontGiftCardTender(
    db: Database,
    input: {
        handles: readonly string[];
        masterSecret: string | null;
        taxQuote: Pick<TaxQuote, "currencyCode" | "totalMinor" | "lines">;
        /** Tax allocation line ids of the gift-card lines. */
        giftCardLineIds: ReadonlySet<string>;
        /**
         * The order's currency and rate (MARKETS-DESIGN step 6): a card in the
         * shop currency or the order's pays at the locked rate (Shopify's rule).
         * Absent: only cards in the order's currency pay.
         */
        money?: PresentmentMoney;
    },
): Promise<StorefrontGiftCardTenderSummary> {
    const giftCardLineTotalMinor = input.taxQuote.lines
        .filter((line) => input.giftCardLineIds.has(line.lineId))
        .reduce((total, line) => total + line.totalMinor, 0);
    const handles = [...input.handles];
    const none: StorefrontGiftCardTenderSummary = {
        handles,
        giftCardLineTotalMinor,
        applied: [],
        appliedTotalMinor: 0,
        amountDueMinor: input.taxQuote.totalMinor,
        unusableHandles: [],
        issues: [],
    };
    if (handles.length === 0) return none;

    const rates = giftCardTenderRates(input.money);
    const quote = await quoteGiftCardTender(db, {
        handles,
        masterSecret: input.masterSecret,
        currencyCode: input.taxQuote.currencyCode,
        ...(rates ? { rates } : {}),
        totalMinor: input.taxQuote.totalMinor,
        giftCardLineTotalMinor,
        // A deposit plan is never made for an order with gift cards: the
        // remainder is charged in full (plan-less balance) or collected as cash.
        depositPlan: false,
    });
    const unusable = new Set(quote.unusableHandles);
    const issues: StorefrontGiftCardIssue[] = quote.unusableHandles.map((handle) => ({
        handle,
        code: GIFT_CARD_UNUSABLE_CODE,
        message: GIFT_CARD_UNUSABLE_MESSAGE,
    }));
    const resolvedHandles = new Set(quote.cards.map((card) => card.handle));
    for (const handle of handles) {
        // Another handle already named the same card (the resolver kept the first).
        if (!unusable.has(handle) && !resolvedHandles.has(handle)) {
            issues.push({ handle, code: "GIFT_CARD_DUPLICATE", message: GIFT_CARD_DUPLICATE_MESSAGE });
        }
    }
    if (isGiftCardTenderBlocked(quote.tender)) {
        return { ...none, unusableHandles: quote.unusableHandles, issues };
    }
    const cardById = new Map(quote.cards.map((card) => [card.giftCardId, card]));
    for (const issue of quote.tender.issues) {
        if (issue.code === "card_not_applied") {
            // What is left is gift-card lines (anti-laundering), or nothing at all.
            const giftCardLinesLeft = giftCardLineTotalMinor > 0;
            issues.push({
                handle: cardById.get(issue.id)?.handle ?? null,
                code: giftCardLinesLeft ? "GIFT_CARD_NOT_ELIGIBLE" : "GIFT_CARD_NOT_NEEDED",
                message: giftCardLinesLeft ? GIFT_CARD_NOT_ELIGIBLE_MESSAGE : GIFT_CARD_NOT_NEEDED_MESSAGE,
            });
        }
    }
    return {
        handles,
        giftCardLineTotalMinor,
        applied: quote.tender.applied.map((application) => {
            const card = cardById.get(application.id)!;
            // A card in another currency is debited the application converted
            // up at the locked rate, never above its balance (recorded as the
            // tender's settlement).
            const cardRate = card.cardCurrencyCode !== input.taxQuote.currencyCode
                ? rates?.find((rate) => rate.code === card.cardCurrencyCode)
                : undefined;
            const orderRate = rates?.find((rate) => rate.code === input.taxQuote.currencyCode);
            return {
                giftCardId: application.id,
                handle: card.handle,
                last4: card.last4,
                appliedMinor: application.appliedMinor,
                balanceMinor: card.balanceMinor,
                ...(cardRate && orderRate ? {
                    card: {
                        currencyCode: card.cardCurrencyCode,
                        debitMinor: Math.min(
                            card.cardBalanceMinor,
                            convertStoreCurrencyMinor(application.appliedMinor, orderRate, cardRate, "up"),
                        ),
                    },
                } : {}),
            };
        }),
        appliedTotalMinor: quote.tender.appliedTotalMinor,
        amountDueMinor: quote.tender.amountDueMinor,
        unusableHandles: quote.unusableHandles,
        issues,
    };
}

/**
 * The store currencies a gift card may be in for an order in `money`'s
 * currency: the order's own and the shop currency, with their rates (units
 * per shop unit). Null for a shop-currency order (only its own currency).
 */
export function giftCardTenderRates(money: PresentmentMoney | undefined): StoreCurrencyRate[] | null {
    if (!money || !isForeignPresentment(money)) return null;
    return [
        { code: money.currencyCode, decimalPlaces: money.decimalPlaces, rate: money.rate },
        { code: money.shopCurrencyCode, decimalPlaces: money.shopDecimalPlaces, rate: "1" },
    ];
}

/**
 * The order the buyer reviewed is the order placed (checked after the quote
 * fingerprint): every card still usable and the amount due unchanged, or
 * `GiftCardChangedError` (409 `GIFT_CARD_CHANGED`) before anything is
 * written. Requests without gift cards pass untouched.
 */
export function assertStorefrontGiftCardTenderReviewed(
    tender: Pick<StorefrontGiftCardTenderSummary, "handles" | "unusableHandles" | "amountDueMinor">,
    expectedAmountDueMinor: number | null | undefined,
): void {
    const expected = expectedAmountDueMinor ?? undefined;
    if (tender.handles.length === 0 && expected === undefined) return;
    if (tender.unusableHandles.length > 0 || expected !== tender.amountDueMinor) {
        throw new GiftCardChangedError();
    }
}

/**
 * Validates and prepares a storefront order for synchronous checkout commit.
 * Performs server-side price verification, discount validation, shipping verification,
 * and partial payment checks. Returns the committed order identity plus the prepared commit payload.
 *
 * @param storefrontDb - The D1 database instance (from c.get("db"))
 * @param data - Parsed and validated order input
 * @param requestUrl - The original request URL
 */
export async function createStorefrontOrder(
    storefrontDb: Database,
    data: CreateStorefrontOrderInput,
    requestUrl: string,
    identity?: CreateStorefrontOrderIdentity,
    prevalidatedCart?: StorefrontCartValidationResult,
    prevalidatedDelivery?: StorefrontDeliveryPreflightResult,
    customerIdentity?: CreateStorefrontOrderCustomerIdentity,
    /** The store currency at its price increment (direct callers: the default store's). */
    requestCurrency: PricingCurrency = {
        code: DEFAULT_CURRENCY.code,
        decimalPlaces: DEFAULT_CURRENCY.decimalPlaces,
        priceIncrementMinor: defaultPriceIncrementMinor(DEFAULT_CURRENCY.code),
    },
    checkoutPolicySnapshot?: StorefrontCheckoutPolicySnapshot,
    taxAuthoritySnapshot?: StorefrontTaxAuthoritySnapshot,
    /** SCALIUS_SECRET, which opens gift-card apply handles (null: every handle is unusable). */
    giftCardAuthority: { masterSecret?: string | null } = {},
    /**
     * The apps' checkout functions (none: platform pricing only), the order
     * channel they see, and the request's payment gateways (built-in only
     * when absent).
     */
    appOptions: {
        apps?: CheckoutAppFunctions;
        channel?: "online_store" | "agent";
        paymentProviders?: PaymentProviders;
        /** The request's app providers (an app tax provider). */
        appProviders?: AppProviders;
    } = {},
): Promise<CreateStorefrontOrderResult> {
    if (data.items.length > MAX_ORDER_LINE_ITEMS) {
        throw new ValidationError(
            `Checkout supports at most ${MAX_ORDER_LINE_ITEMS} line items.`,
        );
    }

    // Customer accounts decides which contacts checkout keeps; whether this
    // order needs a phone is decided once its lines and payment are known.
    const contact = resolveCheckoutContact(checkoutPolicySnapshot?.contactFields, data);

    if (prevalidatedCart && !isTrustedStorefrontCartValidationResult(prevalidatedCart)) {
        throw new ValidationError("Checkout cart validation could not be trusted. Please retry checkout.");
    }

    const appContext = {
        channel: appOptions.channel ?? "online_store",
        customerId: customerIdentity?.customerId ?? null,
        destination: data.shippingCountryCode ? { country: data.shippingCountryCode, city: null, zone: null } : null,
        discountCodes: data.discountCodes,
    } as const;
    const validated = prevalidatedCart ?? await validateStorefrontCartItems(
        storefrontDb,
        data.items.map((item) => ({
            cartKey: item.cartKey,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            productName: item.productName,
            variantLabel: item.variantLabel,
            properties: item.properties,
        })),
        {
            inventoryPool: data.inventoryPool,
            currencyCode: requestCurrency.code,
            priceIncrementMinor: requestCurrency.priceIncrementMinor,
            // The order's sales channel: its publications and its locations' units.
            salesChannelId: defaultOrderSalesChannelId(appOptions.channel ?? "online_store"),
            // The apps' lines and line prices, as the quote saw them.
            linePricer: createAppLinePricer(storefrontDb, appOptions.apps, appContext),
            transformer: createCartTransformer(storefrontDb, appOptions.apps, appContext),
        },
    );

    // Apps that rewrote the lines (`cart.transform`): the buyer sees their own
    // lines, the order holds the rewritten ones.
    const transform = validated.transform;
    if (!validated.valid || (transform && !presentTransformedCart(validated, transform, data.items).valid)) {
        throw new ValidationError("Some items in your cart need attention.", {
            itemIssues: transform ? presentTransformedCart(validated, transform, data.items).issues : validated.issues,
        });
    }
    const cartValidation = validated;
    const orderLines: ReadonlyArray<{ cartKey?: string | null }> = transform ? transform.items : data.items;
    if (
        cartValidation.items.length !== orderLines.length ||
        orderLines.some((_, index) => !cartValidation.items.some((item) => item.index === index))
    ) {
        throw new ValidationError("Checkout cart validation returned an incomplete item set. Please retry checkout.");
    }

    // ------------------------------------------------------------------
    // 1. Batched Reads
    // ------------------------------------------------------------------
    if (prevalidatedDelivery && !isTrustedStorefrontDeliveryPreflightResult(prevalidatedDelivery)) {
        throw new ValidationError("Checkout delivery validation could not be trusted. Please retry checkout.");
    }

    const deliveryPreflight = prevalidatedDelivery ?? await validateStorefrontDeliveryPreflight(
        storefrontDb,
        {
            shippingCountryCode: data.shippingCountryCode,
            city: data.city,
            zone: data.zone,
            area: data.area,
            shippingAdminArea: data.shippingAdminArea,
            shippingPostalCode: data.shippingPostalCode,
            shippingMethodId: data.shippingMethodId,
        },
        cartValidation,
    );

    const lineTypes = assertStorefrontLineFulfilment(cartValidation, deliveryPreflight);
    const { requiresShipping, allowsCashOnDelivery } = deliveryPreflight.fulfilment;
    const giftCardHandles = (data.giftCards ?? []).map((card) => card.handle);
    const assertCashOnDeliveryFits = (paymentMethod: string) => {
        if (paymentMethod === PaymentMethod.COD && !allowsCashOnDelivery) {
            throw new ValidationError("Cash on delivery isn't available for this order. Choose an online payment method.");
        }
        // A method that doesn't serve the delivery country (cash on delivery: Bangladesh).
        const countryIssue = (appOptions.paymentProviders ?? BUILT_IN_PAYMENT_PROVIDERS)
            .countryIssue(paymentMethod, deliveryPreflight.address?.countryCode ?? null);
        if (countryIssue) throw new ValidationError(countryIssue, { reason: PAYMENT_METHOD_UNAVAILABLE_REASON });
    };
    // With gift cards the method is settled once the amount due is known.
    if (giftCardHandles.length === 0) assertCashOnDeliveryFits(data.paymentMethod);
    if (requiresShipping && !data.shippingAddress?.trim()) {
        throw new ValidationError(
            "Enter the delivery address, city and thana, or choose pickup.",
            { reason: DELIVERY_ADDRESS_REQUIRED_REASON },
        );
    }
    // The shipping-address snapshot, validated by its country's rules; the
    // country must be one an active market sells to (MARKETS-DESIGN step 3a).
    const shippingAddress = requiresShipping
        ? resolveStorefrontShippingAddress(data, deliveryPreflight, checkoutPolicySnapshot?.shippingCountries)
        : null;

    if (
        checkoutPolicySnapshot
        && !isTrustedStorefrontCheckoutPolicySnapshot(checkoutPolicySnapshot)
    ) {
        throw new ValidationError("Checkout policy validation could not be trusted. Please retry checkout.");
    }

    // Compatibility for direct Core callers. The API route supplies its
    // already-fresh policy snapshot and skips this extra database roundtrip.
    const fallbackSettings = checkoutPolicySnapshot
        ? null
        : await checkoutDocument.read(storefrontDb);

    // The billing address (Shopify's rule): the shipping address bills an
    // order that ships unless the buyer sent another; an order that ships
    // nothing needs one (minimal unless the merchant requires a full one); a
    // pickup order needs one only when the merchant requires it. Its country
    // must be one an active market sells to.
    const billing = resolveCheckoutBillingAddress(data, {
        path: requiresShipping ? "delivery" : deliveryPreflight.kind === "pickup" ? "pickup" : "none",
        requireFullBillingAddress: checkoutPolicySnapshot?.requireFullBillingAddress
            ?? fallbackSettings?.requireFullBillingAddress
            ?? false,
        sellingCountries: checkoutPolicySnapshot?.shippingCountries,
    });

    const accountOwnerCustomer = customerIdentity ? { id: customerIdentity.customerId } : null;

    const validatedItemByIndex = new Map(cartValidation.items.map((item) => [item.index, item]));

    // Stable allocation identities are established before either promotion or
    // tax evaluation. Commit-time re-evaluation uses these same ids.
    const lineTypeByIndex = new Map(cartValidation.items.map((item, position) => [item.index, lineTypes[position]!]));
    const preparedItems = orderLines.map((item, idx) => {
        const validatedItem = validatedItemByIndex.get(idx)!;
        return {
            id: `item_${nanoid()}`,
            taxAllocationLineId: buildStorefrontTaxAllocationLineId(idx, validatedItem.variantId),
            cartKey: validatedItem.cartKey ?? item.cartKey ?? null,
            productId: validatedItem.productId,
            variantId: validatedItem.variantId,
            quantity: validatedItem.quantity,
            unitPriceMinor: validatedItem.unitPriceMinor,
            baseUnitPriceMinor: validatedItem.baseUnitPriceMinor,
            isGiftCard: validatedItem.isGiftCard === true,
            propertiesPriceMinor: validatedItem.propertiesPriceMinor,
            properties: serializeOrderLineProperties([...validatedItem.properties, ...bundleLineProperties(validatedItem.bundle)]),
            fulfillmentType: lineTypeByIndex.get(idx)!,
            productName: validatedItem.productName,
            variantLabel: validatedItem.variantLabel,
            inventoryTracked: validatedItem.inventoryTracked,
            taxClassId: validatedItem.taxClassId,
            productImageMediaId: validatedItem.productImageMediaId,
        };
    });

    // ------------------------------------------------------------------
    // PRICE: promotions or bundles, then the apps' functions, then tax
    // (pricing.ts: the same rule as the tax quote the buyer reviewed).
    // Typed codes fail closed; an app rule the cart breaks blocks the order.
    // ------------------------------------------------------------------
    const pricing = await priceStorefrontCheckout(storefrontDb, {
        cartValidation,
        delivery: deliveryPreflight,
        discountCodes: data.discountCodes,
        customerId: accountOwnerCustomer?.id,
        customerPhone: data.customerPhone,
        // Segment-limited promotions: the signed-in account only, as the commit re-check sees it.
        segmentCustomerId: accountOwnerCustomer?.id ?? null,
        currency: requestCurrency,
        taxAuthority: taxAuthoritySnapshot,
        apps: appOptions.apps,
        appProviders: appOptions.appProviders,
        channel: appOptions.channel ?? "online_store",
        // An order that ships nothing is taxed at its billing address.
        billing: billing.address
            ? { countryCode: billing.address.countryCode, adminArea: billing.address.adminArea, postalCode: billing.address.postalCode }
            : null,
        location: {
            countryCode: deliveryPreflight.address?.countryCode ?? data.shippingCountryCode ?? null,
            city: data.city,
            zone: data.zone,
            area: data.area,
            adminArea: data.shippingAdminArea,
            postalCode: data.shippingPostalCode,
        },
    });
    assertNoCheckoutRuleErrors(ruleErrorsOnBuyerLines(pricing.ruleErrors, cartValidation));
    assertDiscountCodesApplied(pricing.typedCodes);
    const bundleDiscountByLine = new Map(pricing.bundleLines.map((line) => [line.lineId, line.amountMinor]));
    const taxQuote = pricing.taxQuote;
    const shippingMethod = pricing.shippingMethod;

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    // The advance (deposit) is an amount of the shop currency: an order in a
    // market's own currency is paid in full (MARKETS-DESIGN step 6).
    const isPartialEnabled = (checkoutPolicySnapshot?.partialPaymentEnabled
        ?? fallbackSettings?.partialPaymentEnabled
        ?? false) && !(cartValidation.money && isForeignPresentment(cartValidation.money));

    // ------------------------------------------------------------------
    // GIFT CARDS AS A TENDER (§4.3): the debit at commit is the hold.
    // ------------------------------------------------------------------
    const giftCardTender = await quoteStorefrontGiftCardTender(storefrontDb, {
        handles: giftCardHandles,
        masterSecret: giftCardAuthority.masterSecret ?? null,
        taxQuote,
        money: cartValidation.money,
        giftCardLineIds: new Set(preparedItems
            .filter((item) => item.isGiftCard)
            .map((item) => item.taxAllocationLineId)),
    });
    const giftCardsApplied = giftCardTender.appliedTotalMinor > 0;
    const coveredByGiftCards = giftCardsApplied && giftCardTender.amountDueMinor === 0;
    // Fully covered: the order is paid by gift card whatever method was sent.
    const paymentMethod = coveredByGiftCards ? GIFT_CARD_PAYMENT_METHOD : data.paymentMethod;
    if (paymentMethod === GIFT_CARD_PAYMENT_METHOD && !coveredByGiftCards) {
        // The buyer saw the cards cover the order; they no longer do.
        if (giftCardHandles.length > 0) throw new GiftCardChangedError();
        throw new ValidationError("Choose how to pay for this order.");
    }
    if (giftCardHandles.length > 0) assertCashOnDeliveryFits(paymentMethod);
    if (paymentMethod === PaymentMethod.COD) {
        // Cash on delivery collects cash amounts (whole taka in BDT): an
        // amount due it cannot collect exactly is refused before the commit.
        const cashIssue = (appOptions.paymentProviders ?? BUILT_IN_PAYMENT_PROVIDERS)
            .amountIssue(paymentMethod, giftCardTender.amountDueMinor, taxQuote.currencyCode);
        if (cashIssue) throw new ValidationError(cashIssue, { reason: CASH_ON_DELIVERY_AMOUNT_REASON });
    }

    if (isPartialEnabled && paymentMethod === PaymentMethod.COD) {
        throw new ValidationError(giftCardsApplied
            ? "This store takes an advance payment online. Pay the rest online, or cover the whole order with gift cards."
            : "Advance deposit is required. COD cannot be selected for the full amount directly.");
    }
    // The one contact rule (orderContactNeeds): a phone unless the merchant
    // opted in and the order is only digital or service lines, paid in full
    // online, outside Bangladesh; then email is required.
    assertOrderContact(checkoutPolicySnapshot?.contactFields, {
        customerPhone: data.customerPhone,
        customerEmail: contact.customerEmail,
        lines: cartValidation.items,
        paymentMethod,
        depositPlan: isPartialEnabled && !giftCardsApplied,
        // Where the order is placed: its shipping country, else its billing country.
        countryCode: deliveryPreflight.address?.countryCode ?? billing.address?.countryCode ?? null,
    });
    if (giftCardsApplied) {
        // A gateway charges the remainder: below its minimum it cannot.
        const limits = (appOptions.paymentProviders ?? BUILT_IN_PAYMENT_PROVIDERS).get(paymentMethod)?.amountLimits;
        if (
            limits
            && limits.currency === taxQuote.currencyCode.toUpperCase()
            && giftCardTender.amountDueMinor < limits.minMinor
        ) {
            throw new ValidationError(GIFT_CARD_REMAINDER_TOO_SMALL_MESSAGE, { reason: "gift_card_remainder_too_small" });
        }
    }

    // ------------------------------------------------------------------
    // Build Commit Payload
    // ------------------------------------------------------------------
    const orderId = identity?.orderId ?? generateOrderId();
    // The rate this order keeps: its market's, locked for the market's minutes
    // from now; the quote and the order price at the same rate (the authority
    // fence refuses a commit after the rate changed).
    const orderFx = cartValidation.money && isForeignPresentment(cartValidation.money)
        ? (() => {
            const fx = presentmentFx(cartValidation.money);
            return {
                shopCurrency: fx.shopCurrency,
                fxRate: fx.fxRate,
                fxSource: fx.fxSource,
                fxAsOf: fx.fxAsOf === null ? null : Math.floor(fx.fxAsOf.getTime() / 1_000),
                fxLockedUntil: fx.fxLockedUntil === null ? null : Math.floor(fx.fxLockedUntil.getTime() / 1_000),
            };
        })()
        : null;
    const checkoutToken = identity?.checkoutToken ?? `chk_${nanoid()}`;

    const commitPayload = {
        checkoutToken,
        checkoutAuthorityRevision: checkoutPolicySnapshot?.authorityRevision ?? null,
        checkoutSideEffects: {
            orderCreatedNotification:
                checkoutPolicySnapshot?.orderCreatedNotificationEnabled ?? true,
            metaPurchase: checkoutPolicySnapshot?.metaPurchaseEnabled ?? true,
        },
        existingCustomer: accountOwnerCustomer,
        orderData: {
            id: orderId,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            ...contact,
            ...orderShippingAddressColumns(shippingAddress, { name: data.customerName, phone: data.customerPhone }),
            ...orderBillingAddressColumns(billing, { name: data.customerName, phone: data.customerPhone }),
            notes: data.notes,
            shippingMethodId: shippingMethod?.id ?? null,
            shippingMethodName: shippingMethod?.name ?? null,
            shippingMethodDescription: shippingMethod?.description ?? null,
            shippingMethodBaseAmountMinor: shippingMethod?.baseAmountMinor ?? null,
            shippingFeeWaived: shippingMethod?.feeWaived ?? null,
            requiresShipping,
            shippingMethodKind: deliveryPreflight.kind,
            pickupAddress: deliveryPreflight.pickup?.address ?? null,
            pickupHours: deliveryPreflight.pickup?.hours ?? null,
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            // An order in a market's own currency keeps its locked rate (MARKETS-DESIGN D3).
            ...(orderFx ? { fx: orderFx } : {}),
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            // Cash and fully-covered orders are placed; a gateway order waits for its payment.
            status: paymentMethod === PaymentMethod.COD || paymentMethod === GIFT_CARD_PAYMENT_METHOD
                ? OrderStatus.PENDING
                : OrderStatus.INCOMPLETE,
            paymentMethod,
            paymentStatus: !giftCardsApplied
                ? PaymentStatus.UNPAID
                : coveredByGiftCards ? PaymentStatus.PAID : PaymentStatus.PARTIAL,
            paidAmountMinor: giftCardTender.appliedTotalMinor,
            balanceDueMinor: giftCardTender.amountDueMinor,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            inventoryPool: data.inventoryPool,
            inventoryAction: cartValidation.items.some(item => item.inventoryTracked) ? "reserved" : "none",
        },
        items: preparedItems.map((item) => {
            const lineTax = taxQuote.lines.find(
                (line) => line.lineId === item.taxAllocationLineId,
            );
            if (!lineTax) {
                throw new ValidationError("Authoritative tax quote is missing a checkout line. Please retry checkout.");
            }
            return {
                id: item.id,
                taxAllocationLineId: item.taxAllocationLineId,
                cartKey: item.cartKey,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                productName: item.productName,
                variantLabel: item.variantLabel,
                inventoryTracked: item.inventoryTracked,
                productImageMediaId: item.productImageMediaId,
                fulfillmentType: item.fulfillmentType,
                properties: item.properties,
                propertiesPriceMinor: item.propertiesPriceMinor,
                baseUnitPriceMinor: item.baseUnitPriceMinor,
                unitPriceMinor: lineTax.unitPriceMinor,
                lineSubtotalMinor: lineTax.grossAmountMinor,
                discountAmountMinor: lineTax.discountMinor,
                /** The bundle saving in `discountAmountMinor`; 0 when promotions priced the order. */
                bundleDiscountMinor: bundleDiscountByLine.get(item.taxAllocationLineId) ?? 0,
                taxableAmountMinor: lineTax.taxableAmountMinor,
                taxAmountMinor: lineTax.taxMinor,
            };
        }),
        promotion: pricing.discount.snapshot,
        ...(pricing.appDiscounts.length > 0 ? { appDiscounts: pricing.appDiscounts } : {}),
        ...(pricing.appStorageCommits.length > 0 ? { appStorageCommits: pricing.appStorageCommits } : {}),
        ...(giftCardsApplied
            ? {
                giftCardRedemptions: giftCardTender.applied.map(({ giftCardId, appliedMinor, card }) => ({
                    giftCardId,
                    appliedMinor,
                    ...(card ? { card } : {}),
                })),
            }
            : {}),
        requestUrl,
        taxQuote,
    };

    return {
        checkoutToken,
        orderId,
        paymentMethod,
        taxQuote,
        commitPayload,
        requiresShipping,
        linePropertiesHashes: await storefrontLinePropertiesHashes(cartValidation),
        giftCardTender,
        shippingMethod,
        appDiscounts: pricing.appDiscounts,
        shippingRates: pricing.shippingRates,
        appCart: pricing.appCart,
    };
}

/** `propertiesHash` per validated line, in cart order (for the quote fingerprint). */
export async function storefrontLinePropertiesHashes(
    cartValidation: Pick<StorefrontCartValidationResult, "items">,
): Promise<string[]> {
    return Promise.all(cartValidation.items.map((item) => linePropertiesHash(item.canonicalProperties)));
}

/** Delivery preflight in the decimal HTTP contract. */
export function presentStorefrontDeliveryPreflight(
    delivery: StorefrontDeliveryPreflightResult,
    decimalPlaces: number,
) {
    const { shippingMinor, address: _address, fulfilment: _fulfilment, ...rest } = delivery;
    return { ...rest, shippingCharge: fromMinor(shippingMinor, decimalPlaces) };
}
