// src/modules/checkout/prepare.ts
// Storefront order creation — validates and prepares orders for queue dispatch.

import type { Database } from "@scalius/database/client";
import { resolveCheckoutContact, type CheckoutContactFieldSettings } from "./contact-fields";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import {
    buildStorefrontTaxAllocationLineId,
    calculateStorefrontTaxQuote,
    type StorefrontTaxAuthoritySnapshot,
} from "../tax";
import type { TaxQuote } from "../tax/types";
import {
    GIFT_CARD_PAYMENT_METHOD,
    GIFT_CARD_UNUSABLE_CODE,
    GIFT_CARD_UNUSABLE_MESSAGE,
    GiftCardChangedError,
    quoteGiftCardTender,
} from "../gift-cards";
import { isGiftCardTenderBlocked } from "@scalius/shared/gift-card-tender";
import { getPaymentGateway } from "../payments/gateways/registry";
import { assertDiscountCodesApplied, quoteStorefrontDiscount } from "../promotions";
import { resolveBundlePromotionInterplay } from "./bundle-discounts";
import {
    PaymentMethod,
    PaymentStatus,
    OrderStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { nanoid } from "nanoid";

import { generateOrderId } from "@scalius/shared/order-utils";
import { checkoutDocument } from "../settings/documents";
import { ValidationError } from "@scalius/core/errors";
import type {
    CreateStorefrontOrderCustomerIdentity,
    CreateStorefrontOrderIdentity,
    CreateStorefrontOrderInput,
    CreateStorefrontOrderResult,
    StorefrontGiftCardIssue,
    StorefrontGiftCardTenderSummary,
    StorefrontOrderShippingMethodSnapshot,
} from "../orders/types";
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
import { hasFulfiller } from "../fulfilment/registry";
import {
    resolveActiveDeliveryLocationNamesFromRows,
    selectActiveDeliveryLocationRowsByIds,
    type ActiveDeliveryLocationRow,
} from "../delivery/location-validation";
import { MAX_ORDER_LINE_ITEMS } from "../orders/validation";
import {
    resolveAddressZoneId,
    resolveDeliveryRate,
    selectDeliveryRateRowsByIds,
    type DeliveryRateKind,
    type DeliveryRateRow,
} from "../delivery/zones";

export interface StorefrontDeliveryPreflightInput {
    /** Needed only for a `delivery` rate; pickup and no-method carts omit it. */
    city?: string | null;
    zone?: string | null;
    area?: string | null;
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
    /** The address the order ships to; set only for a `delivery` rate. */
    address: { city: string; zone: string; area: string | null } | null;
    /** Where and when to collect; set only for a `pickup` rate. */
    pickup: { address: string | null; hours: string | null } | null;
    /** Every line's fulfilment type and the order-level consequences. */
    fulfilment: StorefrontCartFulfilmentSummary;
}

export interface StorefrontCheckoutPolicySnapshot {
    partialPaymentEnabled: boolean;
    /** Customer accounts contact fields from the checkout authority read. */
    contactFields?: CheckoutContactFieldSettings;
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

    const rateRow = data.shippingMethodId
        ? shippingMethodRows.find((row) => row.id === data.shippingMethodId)
        : undefined;
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

    const city = data.city?.trim();
    const zone = data.zone?.trim();
    if (!city || !zone) {
        throw new ValidationError(
            "Enter the delivery address, city and thana, or choose pickup.",
            { reason: DELIVERY_ADDRESS_REQUIRED_REASON },
        );
    }
    const address = { city, zone, area: data.area?.trim() || null };
    const locationNames = resolveActiveDeliveryLocationNamesFromRows(address, [...locationRows]);
    const rate = resolveDeliveryRate({
        rate: rateRow,
        addressZoneId: resolveAddressZoneId(address, locationRows),
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
    const readBatch = [
        selectActiveDeliveryLocationRowsByIds(storefrontDb, [data.city, data.zone, data.area]
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)),
        selectDeliveryRateRowsByIds(storefrontDb, data.shippingMethodId ? [data.shippingMethodId] : []),
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

    const quote = await quoteGiftCardTender(db, {
        handles,
        masterSecret: input.masterSecret,
        currencyCode: input.taxQuote.currencyCode,
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
            return {
                giftCardId: application.id,
                handle: card.handle,
                last4: card.last4,
                appliedMinor: application.appliedMinor,
                balanceMinor: card.balanceMinor,
            };
        }),
        appliedTotalMinor: quote.tender.appliedTotalMinor,
        amountDueMinor: quote.tender.amountDueMinor,
        unusableHandles: quote.unusableHandles,
        issues,
    };
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
    requestCurrency: { code: string; decimalPlaces: number } = {
        code: DEFAULT_CURRENCY.code,
        decimalPlaces: DEFAULT_CURRENCY.decimalPlaces,
    },
    checkoutPolicySnapshot?: StorefrontCheckoutPolicySnapshot,
    taxAuthoritySnapshot?: StorefrontTaxAuthoritySnapshot,
    /** SCALIUS_SECRET, which opens gift-card apply handles (null: every handle is unusable). */
    giftCardAuthority: { masterSecret?: string | null } = {},
): Promise<CreateStorefrontOrderResult> {
    if (data.items.length > MAX_ORDER_LINE_ITEMS) {
        throw new ValidationError(
            `Checkout supports at most ${MAX_ORDER_LINE_ITEMS} line items.`,
        );
    }

    // Customer accounts decides which contacts checkout keeps (phone always).
    const contact = resolveCheckoutContact(checkoutPolicySnapshot?.contactFields, data);

    if (prevalidatedCart && !isTrustedStorefrontCartValidationResult(prevalidatedCart)) {
        throw new ValidationError("Checkout cart validation could not be trusted. Please retry checkout.");
    }

    const cartValidation = prevalidatedCart ?? await validateStorefrontCartItems(
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
        { inventoryPool: data.inventoryPool },
    );

    if (!cartValidation.valid) {
        throw new ValidationError("Some items in your cart need attention.", {
            itemIssues: cartValidation.issues,
        });
    }
    if (
        cartValidation.items.length !== data.items.length ||
        data.items.some((_, index) => !cartValidation.items.some((item) => item.index === index))
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
            city: data.city,
            zone: data.zone,
            area: data.area,
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
    };
    // With gift cards the method is settled once the amount due is known.
    if (giftCardHandles.length === 0) assertCashOnDeliveryFits(data.paymentMethod);
    const shippingAddress = requiresShipping ? data.shippingAddress?.trim() ?? "" : null;
    if (requiresShipping && !shippingAddress) {
        throw new ValidationError(
            "Enter the delivery address, city and thana, or choose pickup.",
            { reason: DELIVERY_ADDRESS_REQUIRED_REASON },
        );
    }
    const shippingDestination = requiresShipping ? deliveryPreflight.address : null;

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

    const accountOwnerCustomer = customerIdentity ? { id: customerIdentity.customerId } : null;

    const validatedItemByIndex = new Map(cartValidation.items.map((item) => [item.index, item]));
    const verifiedShippingMinor = deliveryPreflight.shippingMinor;

    // Stable allocation identities are established before either promotion or
    // tax evaluation. Commit-time re-evaluation uses these same ids.
    const lineTypeByIndex = new Map(cartValidation.items.map((item, position) => [item.index, lineTypes[position]!]));
    const preparedItems = data.items.map((item, idx) => {
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
            properties: serializeOrderLineProperties(validatedItem.properties),
            fulfillmentType: lineTypeByIndex.get(idx)!,
            productName: validatedItem.productName,
            variantLabel: validatedItem.variantLabel,
            inventoryTracked: validatedItem.inventoryTracked,
            taxClassId: validatedItem.taxClassId,
            productImageMediaId: validatedItem.productImageMediaId,
            bundleDiscountMinor: validatedItem.bundleDiscountMinor ?? 0,
        };
    });

    // ------------------------------------------------------------------
    // DISCOUNT: the typed codes (each fails closed) against active automatic ones
    // ------------------------------------------------------------------
    const discount = await quoteStorefrontDiscount(storefrontDb, {
        codes: data.discountCodes,
        customerId: accountOwnerCustomer?.id,
        customerPhone: data.customerPhone,
        cart: {
            currencyCode: requestCurrency.code,
            lines: preparedItems.map((item) => ({
                id: item.taxAllocationLineId,
                productId: item.productId,
                variantId: item.variantId,
                unitPriceMinor: item.unitPriceMinor,
                quantity: item.quantity,
                // Gift-card lines are outside every promotion (§4.2).
                ...(item.isGiftCard ? { giftCard: true } : {}),
            })),
            shippingAmountMinor: verifiedShippingMinor,
        },
    });
    assertDiscountCodesApplied(discount);
    // Promotions or quantity bundles price the order, never both (bundle-discounts.ts).
    const bundleDiscount = resolveBundlePromotionInterplay(
        preparedItems.map((item) => ({
            lineId: item.taxAllocationLineId,
            unitPriceMinor: item.unitPriceMinor,
            quantity: item.quantity,
            bundleDiscountMinor: item.bundleDiscountMinor,
        })),
        discount,
    );
    const bundleDiscountByLine = new Map(bundleDiscount.bundleLines.map((line) => [line.lineId, line.amountMinor]));
    const taxQuoteInput = {
        // No address (pickup, service, digital): only store-wide rates apply.
        destination: {
            city: shippingDestination?.city ?? null,
            zone: shippingDestination?.zone ?? null,
            area: shippingDestination?.area ?? null,
            cityName: deliveryPreflight.cityName,
            zoneName: deliveryPreflight.zoneName,
            areaName: deliveryPreflight.areaName,
        },
        lines: preparedItems.map((item) => ({
            lineId: item.taxAllocationLineId,
            productId: item.productId,
            variantId: item.variantId,
            unitPriceMinor: item.unitPriceMinor,
            quantity: item.quantity,
            taxClassId: item.taxClassId,
            // A gift card is money, not a taxable sale (§4.2).
            ...(item.isGiftCard ? { taxExempt: true } : {}),
        })),
        shippingMinor: verifiedShippingMinor,
        promotionDiscountAllocation: bundleDiscount.allocation,
        currency: requestCurrency,
    };
    const taxQuote = taxAuthoritySnapshot
        ? await calculateStorefrontTaxQuote(storefrontDb, taxQuoteInput, taxAuthoritySnapshot)
        : await calculateStorefrontTaxQuote(storefrontDb, taxQuoteInput);

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    const isPartialEnabled = checkoutPolicySnapshot?.partialPaymentEnabled
        ?? fallbackSettings?.partialPaymentEnabled
        ?? false;

    // ------------------------------------------------------------------
    // GIFT CARDS AS A TENDER (§4.3): the debit at commit is the hold.
    // ------------------------------------------------------------------
    const giftCardTender = await quoteStorefrontGiftCardTender(storefrontDb, {
        handles: giftCardHandles,
        masterSecret: giftCardAuthority.masterSecret ?? null,
        taxQuote,
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

    if (isPartialEnabled && paymentMethod === PaymentMethod.COD) {
        throw new ValidationError(giftCardsApplied
            ? "This store takes an advance payment online. Pay the rest online, or cover the whole order with gift cards."
            : "Advance deposit is required. COD cannot be selected for the full amount directly.");
    }
    if (giftCardsApplied) {
        // A gateway charges the remainder: below its minimum it cannot.
        const limits = getPaymentGateway(paymentMethod)?.amountLimits;
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
            shippingAddress,
            city: shippingDestination?.city ?? null,
            zone: shippingDestination?.zone ?? null,
            area: shippingDestination?.area ?? null,
            cityName: deliveryPreflight.cityName,
            zoneName: deliveryPreflight.zoneName,
            areaName: deliveryPreflight.areaName,
            notes: data.notes,
            shippingMethodId: deliveryPreflight.shippingMethod?.id ?? null,
            shippingMethodName: deliveryPreflight.shippingMethod?.name ?? null,
            shippingMethodDescription: deliveryPreflight.shippingMethod?.description ?? null,
            shippingMethodBaseAmountMinor: deliveryPreflight.shippingMethod?.baseAmountMinor ?? null,
            shippingFeeWaived: deliveryPreflight.shippingMethod?.feeWaived ?? null,
            requiresShipping,
            shippingMethodKind: deliveryPreflight.kind,
            pickupAddress: deliveryPreflight.pickup?.address ?? null,
            pickupHours: deliveryPreflight.pickup?.hours ?? null,
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
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
        promotion: bundleDiscount.discount.snapshot,
        ...(giftCardsApplied
            ? {
                giftCardRedemptions: giftCardTender.applied.map(({ giftCardId, appliedMinor }) => ({
                    giftCardId,
                    appliedMinor,
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
