// src/modules/orders/orders.storefront.ts
// Storefront order creation — validates and prepares orders for queue dispatch.

import type { Database } from "@scalius/database/client";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import {
    buildStorefrontTaxAllocationLineId,
    calculateStorefrontTaxQuote,
    type StorefrontTaxAuthoritySnapshot,
} from "../tax";
import { quoteStorefrontDiscount } from "../promotions";
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
    StorefrontOrderShippingMethodSnapshot,
} from "./orders.types";
import {
    isTrustedStorefrontCartValidationResult,
    validateStorefrontCartItems,
    type StorefrontCartValidationResult,
} from "./cart-validation";
import {
    resolveActiveDeliveryLocationNamesFromRows,
    selectActiveDeliveryLocationRows,
    type ActiveDeliveryLocationRow,
} from "./delivery-location-validation";
import { MAX_ORDER_LINE_ITEMS } from "./orders.validation";
import {
    resolveAddressZoneId,
    resolveDeliveryRate,
    selectDeliveryRateRowsByIds,
    type DeliveryRateKind,
    type DeliveryRateRow,
} from "../delivery/zones";

export interface StorefrontDeliveryPreflightInput {
    city: string;
    zone: string;
    area?: string | null;
    shippingMethodId?: string | null;
}

export interface StorefrontDeliveryPreflightResult {
    /** "pickup": the buyer collects the order, so no delivery address is needed. */
    kind: DeliveryRateKind;
    shippingMinor: number;
    shippingMethod: StorefrontOrderShippingMethodSnapshot;
    cityName: string;
    zoneName: string;
    areaName: string | null;
}

export interface StorefrontCheckoutPolicySnapshot {
    partialPaymentEnabled: boolean;
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

export function resolveStorefrontDeliveryPreflightFromRows(
    data: StorefrontDeliveryPreflightInput,
    cartValidation: Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct" | "subtotalMinor">,
    locationRows: readonly ActiveDeliveryLocationRow[],
    shippingMethodRows: readonly DeliveryRateRow[],
): StorefrontDeliveryPreflightResult {
    const locationNames = resolveActiveDeliveryLocationNamesFromRows(data, [...locationRows]);
    const rate = resolveDeliveryRate({
        rate: shippingMethodRows.find((row) => row.id === data.shippingMethodId),
        addressZoneId: resolveAddressZoneId(data, locationRows),
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
    });
}

export async function validateStorefrontDeliveryPreflight(
    storefrontDb: Database,
    data: StorefrontDeliveryPreflightInput,
    cartValidation: Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct" | "subtotalMinor">,
): Promise<StorefrontDeliveryPreflightResult> {
    const readBatch = [
        selectActiveDeliveryLocationRows(storefrontDb, data),
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
): Promise<CreateStorefrontOrderResult> {
    if (data.items.length > MAX_ORDER_LINE_ITEMS) {
        throw new ValidationError(
            `Checkout supports at most ${MAX_ORDER_LINE_ITEMS} line items.`,
        );
    }

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
            productName: validatedItem.productName,
            variantLabel: validatedItem.variantLabel,
            inventoryTracked: validatedItem.inventoryTracked,
            taxClassId: validatedItem.taxClassId,
            productImageMediaId: validatedItem.productImageMediaId,
        };
    });

    // ------------------------------------------------------------------
    // DISCOUNT: the typed code (fails closed) against active automatic ones
    // ------------------------------------------------------------------
    const discount = await quoteStorefrontDiscount(storefrontDb, {
        code: data.discountCode,
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
            })),
            shippingAmountMinor: verifiedShippingMinor,
        },
    });
    const taxQuoteInput = {
        destination: {
            city: data.city,
            zone: data.zone,
            area: data.area,
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
        })),
        shippingMinor: verifiedShippingMinor,
        promotionDiscountAllocation: discount.taxAllocation,
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
    if (isPartialEnabled && data.paymentMethod === PaymentMethod.COD) {
        throw new ValidationError("Advance deposit is required. COD cannot be selected for the full amount directly.");
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
            customerEmail: data.customerEmail,
            shippingAddress: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName: deliveryPreflight.cityName,
            zoneName: deliveryPreflight.zoneName,
            areaName: deliveryPreflight.areaName,
            notes: data.notes,
            shippingMethodId: deliveryPreflight.shippingMethod.id,
            shippingMethodName: deliveryPreflight.shippingMethod.name,
            shippingMethodDescription: deliveryPreflight.shippingMethod.description,
            shippingMethodBaseAmountMinor: deliveryPreflight.shippingMethod.baseAmountMinor,
            shippingFeeWaived: deliveryPreflight.shippingMethod.feeWaived,
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            status: data.paymentMethod === PaymentMethod.COD ? OrderStatus.PENDING : OrderStatus.INCOMPLETE,
            paymentMethod: data.paymentMethod,
            paymentStatus: PaymentStatus.UNPAID,
            paidAmountMinor: 0,
            balanceDueMinor: taxQuote.totalMinor,
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
                unitPriceMinor: lineTax.unitPriceMinor,
                lineSubtotalMinor: lineTax.grossAmountMinor,
                discountAmountMinor: lineTax.discountMinor,
                taxableAmountMinor: lineTax.taxableAmountMinor,
                taxAmountMinor: lineTax.taxMinor,
            };
        }),
        promotion: discount.snapshot,
        requestUrl,
        taxQuote,
    };

    return {
        checkoutToken,
        orderId,
        paymentMethod: data.paymentMethod,
        taxQuote,
        commitPayload,
    };
}

/** Delivery preflight in the decimal HTTP contract. */
export function presentStorefrontDeliveryPreflight(
    delivery: StorefrontDeliveryPreflightResult,
    decimalPlaces: number,
) {
    const { shippingMinor, ...rest } = delivery;
    return { ...rest, shippingCharge: fromMinor(shippingMinor, decimalPlaces) };
}
