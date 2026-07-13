// src/modules/orders/orders.storefront.ts
// Storefront order creation — validates and prepares orders for queue dispatch.

import type { Database } from "@scalius/database/client";
import { DEFAULT_CURRENCY, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
import {
    buildStorefrontTaxAllocationLineId,
    calculateStorefrontTaxQuote,
    fromMinorUnits,
    type StorefrontDiscountType,
} from "../tax";
import {
    discounts,
    siteSettings,
    shippingMethods,
    PaymentMethod,
    PaymentStatus,
    OrderStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { nanoid } from "nanoid";

import { eq, and, isNull } from "drizzle-orm";
import { generateOrderId } from "@scalius/shared/order-utils";
import { ValidationError } from "@scalius/core/errors";
import type {
    CreateStorefrontOrderCustomerIdentity,
    CreateStorefrontOrderIdentity,
    CreateStorefrontOrderInput,
    CreateStorefrontOrderResult,
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

interface ShippingMethodRow {
    fee: number;
    isActive: boolean;
    deletedAt: Date | number | null;
}

export interface StorefrontDeliveryPreflightInput {
    city: string;
    zone: string;
    area?: string | null;
    shippingMethodId?: string | null;
    currencyCode?: string | null;
}

export interface StorefrontDeliveryPreflightResult {
    shippingCharge: number;
    cityName: string;
    zoneName: string;
    areaName: string | null;
}

const STOREFRONT_DELIVERY_PREFLIGHT_RESULT_PROOF = Symbol("scalius.storefrontDeliveryPreflightResult");

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

export async function validateStorefrontDeliveryPreflight(
    storefrontDb: Database,
    data: StorefrontDeliveryPreflightInput,
    cartValidation: Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct">,
): Promise<StorefrontDeliveryPreflightResult> {
    // API callers pass the merchant currency. Direct Core callers retain an
    // explicit BDT fallback, matching direct cart-validation behavior.
    const currencyCode = normalizeSupportedCurrencyCode(data.currencyCode) ?? DEFAULT_CURRENCY.code;
    const readBatch: unknown[] = [];
    readBatch.push(selectActiveDeliveryLocationRows(storefrontDb, data));

    if (!cartValidation.hasFreeDeliveryProduct && data.shippingMethodId) {
        readBatch.push(
            storefrontDb
                .select({
                    fee: shippingMethods.fee,
                    isActive: shippingMethods.isActive,
                    deletedAt: shippingMethods.deletedAt,
                })
                .from(shippingMethods)
                .where(
                    and(
                        eq(shippingMethods.id, data.shippingMethodId),
                        eq(shippingMethods.isActive, true),
                        isNull(shippingMethods.deletedAt),
                    ),
                ),
        );
    } else {
        readBatch.push(storefrontDb.select().from(shippingMethods).limit(0));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const [locationRows, shippingMethodRows] = await storefrontDb.batch(readBatch as any);

    const locationResults = Array.isArray(locationRows) ? locationRows as ActiveDeliveryLocationRow[] : [];
    const locationNames = resolveActiveDeliveryLocationNamesFromRows(data, locationResults);

    let shippingCharge = 0;
    if (!cartValidation.hasFreeDeliveryProduct) {
        const shippingMethodList = Array.isArray(shippingMethodRows) ? shippingMethodRows as ShippingMethodRow[] : [];
        const shippingMethod = shippingMethodList[0] ?? null;
        const shippingMethodIsUsable =
            shippingMethod &&
            shippingMethod.isActive === true &&
            shippingMethod.deletedAt == null;

        if (!shippingMethodIsUsable) {
            throw new ValidationError("A valid active shipping method is required for this order.");
        }

        const methodFee = Number(shippingMethod.fee);
        if (!Number.isFinite(methodFee) || methodFee < 0) {
            throw new ValidationError("Selected shipping method is misconfigured.");
        }

        shippingCharge = roundPrice(methodFee, currencyCode);
    }

    return markTrustedStorefrontDeliveryPreflightResult({
        shippingCharge,
        cityName: locationNames.cityName,
        zoneName: locationNames.zoneName,
        areaName: locationNames.areaName,
    });
}

/**
 * Validates and prepares a storefront order for synchronous checkout commit.
 * Performs server-side price verification, discount validation, shipping verification,
 * and partial payment checks. Returns the committed order identity plus the prepared commit payload.
 *
 * @param storefrontDb - The D1 database instance (from c.get("db"))
 * @param data - Parsed and validated order input
 * @param requestUrl - The original request URL
 * @param isDiscountValid - Discount validation function (from discounts route)
 * @param calculateDiscountAmount - Discount calculation function (from discounts route)
 */
export async function createStorefrontOrder(
    storefrontDb: Database,
    data: CreateStorefrontOrderInput,
    requestUrl: string,
    isDiscountValid: (db: Database, code: string, total: number, items: unknown[], customerPhone: string) => Promise<unknown>,
    calculateDiscountAmount: (
        db: Database,
        discount: unknown,
        total: number,
        items: unknown[],
        shippingCost: number,
        applicableProductIds?: Set<string>,
    ) => number | Promise<number>,
    identity?: CreateStorefrontOrderIdentity,
    prevalidatedCart?: StorefrontCartValidationResult,
    prevalidatedDelivery?: StorefrontDeliveryPreflightResult,
    customerIdentity?: CreateStorefrontOrderCustomerIdentity,
    requestCurrency: { code: string; decimalPlaces: number } = {
        code: DEFAULT_CURRENCY.code,
        decimalPlaces: DEFAULT_CURRENCY.decimalPlaces,
    },
): Promise<CreateStorefrontOrderResult> {
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
    const normalizedDiscountCode = data.discountCode?.trim().toUpperCase();
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

    // Drizzle D1 batch() requires specific tuple types
    const readBatch: unknown[] = [];

    if (normalizedDiscountCode) {
        readBatch.push(
            storefrontDb
                .select({ id: discounts.id })
                .from(discounts)
                .where(eq(discounts.code, normalizedDiscountCode)),
        );
    } else {
        readBatch.push(storefrontDb.select().from(discounts).limit(0));
    }

    readBatch.push(storefrontDb.select().from(siteSettings).limit(1));

    // Execute Read Batch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const readResults = await storefrontDb.batch(readBatch as any);

    const accountOwnerCustomer = customerIdentity ? { id: customerIdentity.customerId } : null;

    const discountList = data.discountCode ? (readResults[0] as { id: string }[]) : [];
    const appliedDiscount = discountList.length > 0 ? discountList[0] : null;

    const settingsList = readResults[1] as Record<string, unknown>[];
    const settings = settingsList.length > 0 ? settingsList[0] as Record<string, unknown> : null;

    const serverItemTotal = cartValidation.subtotal;
    const validatedItemByIndex = new Map(cartValidation.items.map((item) => [item.index, item]));
    const verifiedShippingCharge = deliveryPreflight.shippingCharge;

    // ------------------------------------------------------------------
    // DISCOUNTS VERIFICATION
    // ------------------------------------------------------------------
    let verifiedDiscountAmount = 0;
    let appliedDiscountId = appliedDiscount?.id ?? null;
    let discountType: StorefrontDiscountType | null = null;
    let applicableProductIds: Set<string> | undefined;
    if (normalizedDiscountCode) {
        const discountItems = cartValidation.items.map((item) => ({
            id: item.productId,
            price: item.unitPrice,
            quantity: item.quantity,
            variantId: item.variantId,
        }));
        const validationResponse = await isDiscountValid(
            storefrontDb,
            normalizedDiscountCode,
            serverItemTotal + verifiedShippingCharge,
            discountItems,
            data.customerPhone,
        );

        const validResult = validationResponse as Record<string, unknown> | null;
        if (validResult && validResult.valid && validResult.discount) {
            const validatedDiscount = validResult.discount as {
                id?: string;
                type?: StorefrontDiscountType;
            };
            if (!validatedDiscount.type) {
                throw new ValidationError("The discount configuration is invalid.");
            }
            appliedDiscountId = validatedDiscount.id ?? appliedDiscountId;
            discountType = validatedDiscount.type;
            if (validatedDiscount.type === "amount_off_products") {
                if (!(validResult.applicableProductIds instanceof Set)) {
                    throw new ValidationError("The product discount scope could not be verified.");
                }
                applicableProductIds = validResult.applicableProductIds as Set<string>;
            }
            verifiedDiscountAmount = await calculateDiscountAmount(
                storefrontDb,
                validResult.discount,
                serverItemTotal + verifiedShippingCharge,
                discountItems,
                verifiedShippingCharge,
                applicableProductIds,
            );
        } else {
            throw new ValidationError(`Discount code ${normalizedDiscountCode} is invalid or expired.`);
        }
    }

    // IDs are generated before tax so line allocation and the committed snapshot
    // share one stable identity across retries.
    const preparedItems = data.items.map((item, idx) => {
        const validatedItem = validatedItemByIndex.get(idx)!;
        return {
            id: `item_${nanoid()}`,
            taxAllocationLineId: buildStorefrontTaxAllocationLineId(idx, validatedItem.variantId),
            cartKey: validatedItem.cartKey ?? item.cartKey ?? null,
            productId: validatedItem.productId,
            variantId: validatedItem.variantId,
            quantity: validatedItem.quantity,
            price: validatedItem.unitPrice,
            productName: validatedItem.productName,
            variantLabel: validatedItem.variantLabel,
            inventoryTracked: validatedItem.inventoryTracked,
            taxClassId: validatedItem.taxClassId,
            productImageMediaId: validatedItem.productImageMediaId,
        };
    });
    const taxQuote = await calculateStorefrontTaxQuote(storefrontDb, {
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
            unitPrice: item.price,
            quantity: item.quantity,
            taxClassId: item.taxClassId,
        })),
        shippingAmount: verifiedShippingCharge,
        discountAmount: verifiedDiscountAmount,
        discountType,
        applicableProductIds: applicableProductIds ? [...applicableProductIds] : undefined,
        currency: requestCurrency,
    });
    const normalizedDiscountAmount = fromMinorUnits(taxQuote.discountMinor, taxQuote.decimalPlaces);
    const totalAmount = fromMinorUnits(taxQuote.totalMinor, taxQuote.decimalPlaces);

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    const isPartialEnabled = (settings?.partialPaymentEnabled as boolean) ?? false;
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
            totalAmount,
            shippingCharge: verifiedShippingCharge,
            discountAmount: normalizedDiscountAmount,
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
            paidAmount: 0,
            balanceDue: totalAmount,
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
                price: item.price,
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
        discountUsage: appliedDiscountId && normalizedDiscountAmount > 0 ? {
            discountId: appliedDiscountId,
            amountDiscounted: normalizedDiscountAmount,
        } : null,
        requestUrl,
        taxQuote,
    };

    return {
        checkoutToken,
        orderId,
        paymentMethod: data.paymentMethod,
        totalAmount,
        taxQuote,
        commitPayload,
    };
}
