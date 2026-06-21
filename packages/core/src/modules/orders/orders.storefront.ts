// src/modules/orders/orders.storefront.ts
// Storefront order creation — validates and prepares orders for queue dispatch.

import type { Database } from "@scalius/database/client";
import { subtractPrice, addPrices, roundPrice } from "@scalius/shared/price-utils";
import {
    customers,
    deliveryLocations,
    discounts,
    siteSettings,
    shippingMethods,
    PaymentMethod,
    PaymentStatus,
    OrderStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { nanoid } from "nanoid";

import { eq, and, isNull, inArray } from "drizzle-orm";
import { generateOrderId } from "@scalius/shared/order-utils";
import { ValidationError } from "@scalius/core/errors";
import type { CreateStorefrontOrderIdentity, CreateStorefrontOrderInput, CreateStorefrontOrderResult } from "./orders.types";
import { validateStorefrontCartItems, type StorefrontCartValidationResult } from "./cart-validation";

interface LocationRow {
    id: string;
    name: string;
    type: "city" | "zone" | "area";
    parentId: string | null;
    isActive: boolean;
    deletedAt: Date | number | null;
}

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
}

export interface StorefrontDeliveryPreflightResult {
    shippingCharge: number;
    cityName: string;
    zoneName: string;
    areaName: string | null;
}

export async function validateStorefrontDeliveryPreflight(
    storefrontDb: Database,
    data: StorefrontDeliveryPreflightInput,
    cartValidation: Pick<StorefrontCartValidationResult, "hasFreeDeliveryProduct">,
): Promise<StorefrontDeliveryPreflightResult> {
    const locationIds = [data.city, data.zone, data.area].filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
    );

    const readBatch: unknown[] = [];
    if (locationIds.length > 0) {
        readBatch.push(
            storefrontDb
                .select({
                    id: deliveryLocations.id,
                    name: deliveryLocations.name,
                    type: deliveryLocations.type,
                    parentId: deliveryLocations.parentId,
                    isActive: deliveryLocations.isActive,
                    deletedAt: deliveryLocations.deletedAt,
                })
                .from(deliveryLocations)
                .where(
                    and(
                        inArray(deliveryLocations.id, locationIds),
                        eq(deliveryLocations.isActive, true),
                        isNull(deliveryLocations.deletedAt),
                    ),
                ),
        );
    } else {
        readBatch.push(storefrontDb.select().from(deliveryLocations).limit(0));
    }

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

    const locationResults = Array.isArray(locationRows) ? locationRows as LocationRow[] : [];
    const locationMap = new Map(locationResults.map((location) => [location.id, location]));
    const city = locationMap.get(data.city);
    if (!city || city.type !== "city" || city.parentId !== null || city.isActive !== true || city.deletedAt != null) {
        throw new ValidationError("Selected city is no longer available for checkout.");
    }

    const zone = locationMap.get(data.zone);
    if (!zone || zone.type !== "zone" || zone.parentId !== city.id || zone.isActive !== true || zone.deletedAt != null) {
        throw new ValidationError("Selected zone is no longer available for the chosen city.");
    }

    const area = data.area ? locationMap.get(data.area) : null;
    if (data.area && (!area || area.type !== "area" || area.parentId !== zone.id || area.isActive !== true || area.deletedAt != null)) {
        throw new ValidationError("Selected area is no longer available for the chosen zone.");
    }

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

        shippingCharge = roundPrice(methodFee);
    }

    return {
        shippingCharge,
        cityName: city.name,
        zoneName: zone.name,
        areaName: area?.name ?? null,
    };
}

/**
 * Validates and prepares a storefront order for queue dispatch.
 * Performs server-side price verification, discount validation, shipping verification,
 * and partial payment checks. Returns a queue payload ready for ORDER_INGEST_QUEUE.
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
    calculateDiscountAmount: (db: Database, discount: unknown, total: number, items: unknown[], shippingCost: number) => number | Promise<number>,
    identity?: CreateStorefrontOrderIdentity,
    prevalidatedCart?: StorefrontCartValidationResult,
    prevalidatedDelivery?: StorefrontDeliveryPreflightResult,
): Promise<CreateStorefrontOrderResult> {
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

    // ------------------------------------------------------------------
    // 1. Batched Reads
    // ------------------------------------------------------------------
    const normalizedDiscountCode = data.discountCode?.trim().toUpperCase();
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

    readBatch.push(
        storefrontDb
            .select({
                id: customers.id,
                totalOrders: customers.totalOrders,
                totalSpent: customers.totalSpent,
            })
            .from(customers)
            .where(eq(customers.phone, data.customerPhone)),
    );

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

    const customerList = readResults[0] as { id: string; totalOrders: number; totalSpent: number }[];
    const existingCustomer = customerList.length > 0 ? customerList[0] : undefined;

    const discountList = data.discountCode ? (readResults[1] as { id: string }[]) : [];
    const appliedDiscount = discountList.length > 0 ? discountList[0] : null;

    const settingsList = readResults[2] as Record<string, unknown>[];
    const settings = settingsList.length > 0 ? settingsList[0] as Record<string, unknown> : null;

    const serverItemTotal = cartValidation.subtotal;
    const validatedItemByIndex = new Map(cartValidation.items.map((item) => [item.index, item]));
    const inventoryTrackedByIndex = new Map(cartValidation.items.map((item) => [item.index, item.inventoryTracked]));
    const verifiedShippingCharge = deliveryPreflight.shippingCharge;

    // ------------------------------------------------------------------
    // DISCOUNTS VERIFICATION
    // ------------------------------------------------------------------
    let verifiedDiscountAmount = 0;
    let appliedDiscountId = appliedDiscount?.id ?? null;
    if (normalizedDiscountCode) {
        const validationResponse = await isDiscountValid(
            storefrontDb,
            normalizedDiscountCode,
            serverItemTotal + verifiedShippingCharge,
            data.items,
            data.customerPhone,
        );

        const validResult = validationResponse as Record<string, unknown> | null;
        if (validResult && validResult.valid && validResult.discount) {
            const validatedDiscount = validResult.discount as { id?: string };
            appliedDiscountId = validatedDiscount.id ?? appliedDiscountId;
            verifiedDiscountAmount = await calculateDiscountAmount(
                storefrontDb,
                validResult.discount,
                serverItemTotal + verifiedShippingCharge,
                data.items,
                verifiedShippingCharge,
            );
        } else {
            throw new ValidationError(`Discount code ${normalizedDiscountCode} is invalid or expired.`);
        }
    }

    const totalAmount = subtractPrice(addPrices(serverItemTotal, verifiedShippingCharge), verifiedDiscountAmount);

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    const isPartialEnabled = (settings?.partialPaymentEnabled as boolean) ?? false;
    if (isPartialEnabled && data.paymentMethod === PaymentMethod.COD) {
        throw new ValidationError("Advance deposit is required. COD cannot be selected for the full amount directly.");
    }

    // ------------------------------------------------------------------
    // Build Queue Payload
    // ------------------------------------------------------------------
    const orderId = identity?.orderId ?? generateOrderId();
    const checkoutToken = identity?.checkoutToken ?? `chk_${nanoid()}`;

    const queuePayload = {
        type: "order.ingest" as const,
        checkoutToken,
        existingCustomer: existingCustomer ? { id: existingCustomer.id } : null,
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
            discountAmount: verifiedDiscountAmount,
            status: data.paymentMethod === PaymentMethod.COD ? OrderStatus.PENDING : OrderStatus.INCOMPLETE,
            paymentMethod: data.paymentMethod,
            paymentStatus: PaymentStatus.UNPAID,
            paidAmount: 0,
            balanceDue: totalAmount,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            inventoryPool: data.inventoryPool,
            inventoryAction: cartValidation.items.some(item => item.variantId !== null && item.inventoryTracked) ? "reserved" : "none",
        },
        items: data.items.map((item, idx) => ({
            productId: item.productId,
            variantId: validatedItemByIndex.get(idx)?.variantId ?? item.variantId,
            quantity: item.quantity,
            price: validatedItemByIndex.get(idx)?.unitPrice ?? item.price,
            productName: validatedItemByIndex.get(idx)?.productName ?? item.productName ?? null,
            variantLabel: validatedItemByIndex.get(idx)?.variantLabel ?? item.variantLabel ?? null,
            inventoryTracked: inventoryTrackedByIndex.get(idx) ?? false,
        })),
        discountUsage: appliedDiscountId && verifiedDiscountAmount > 0 ? {
            discountId: appliedDiscountId,
            amountDiscounted: verifiedDiscountAmount,
        } : null,
        requestUrl,
    };

    return {
        checkoutToken,
        orderId,
        paymentMethod: data.paymentMethod,
        totalAmount,
        queuePayload,
    };
}
