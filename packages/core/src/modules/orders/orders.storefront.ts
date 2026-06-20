// src/modules/orders/orders.storefront.ts
// Storefront order creation — validates and prepares orders for queue dispatch.

import type { Database } from "@scalius/database/client";
import { subtractPrice, addPrices, roundPrice } from "@scalius/shared/price-utils";
import {
    customers,
    products,
    productVariants,
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

import { sql, eq, and, isNull, inArray } from "drizzle-orm";
import { generateOrderId } from "@scalius/shared/order-utils";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import type { CreateStorefrontOrderIdentity, CreateStorefrontOrderInput, CreateStorefrontOrderResult } from "./orders.types";

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
): Promise<CreateStorefrontOrderResult> {
    // ------------------------------------------------------------------
    // 1. Batched Reads
    // ------------------------------------------------------------------
    const variantIds = data.items
        .map((item) => item.variantId)
        .filter((id): id is string => id !== null);

    const locationIds = [data.city, data.zone, data.area].filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
    const normalizedDiscountCode = data.discountCode?.trim().toUpperCase();

    // Drizzle D1 batch() requires specific tuple types
    const readBatch: unknown[] = [];

    // 1. Variants
    if (variantIds.length > 0) {
        readBatch.push(
            storefrontDb
                .select({
                    id: productVariants.id,
                    productId: productVariants.productId,
                    stock: productVariants.stock,
                    price: productVariants.price,
                    discountPercentage: productVariants.discountPercentage,
                    discountType: productVariants.discountType,
                    discountAmount: productVariants.discountAmount,
                })
                .from(productVariants)
                .where(
                    and(
                        sql`${productVariants.id} IN ${variantIds}`,
                        isNull(productVariants.deletedAt),
                    ),
                ),
        );
    } else {
        readBatch.push(storefrontDb.select().from(productVariants).limit(0));
    }

    // 2. Locations
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

    // 3. Customer
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

    // 4. Discount
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

    // 5. Products (for server-side price verification)
    const productIds = [...new Set(data.items.map((item) => item.productId))];
    if (productIds.length > 0) {
        readBatch.push(
            storefrontDb
                .select({
                    id: products.id,
                    price: products.price,
                    discountPercentage: products.discountPercentage,
                    discountType: products.discountType,
                    discountAmount: products.discountAmount,
                    freeDelivery: products.freeDelivery,
                })
                .from(products)
                .where(
                    and(
                        sql`${products.id} IN ${productIds}`,
                        isNull(products.deletedAt),
                    ),
                ),
        );
    } else {
        readBatch.push(storefrontDb.select().from(products).limit(0));
    }

    // 6. Settings (for partial payment checks)
    readBatch.push(storefrontDb.select().from(siteSettings).limit(1));

    // 7. Shipping Method
    if (data.shippingMethodId) {
        readBatch.push(
            storefrontDb
                .select()
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

    // Execute Read Batch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const readResults = await storefrontDb.batch(readBatch as any);

    // Unpack Results
    interface VariantRow { id: string; productId: string; stock: number; price: number; discountPercentage: number | null; discountType: string | null; discountAmount: number | null; }
    interface LocationRow {
        id: string;
        name: string;
        type: "city" | "zone" | "area";
        parentId: string | null;
        isActive: boolean;
        deletedAt: Date | number | null;
    }
    const variants = variantIds.length > 0 ? (readResults[0] as VariantRow[]) : [] as VariantRow[];
    const locationResults = locationIds.length > 0 ? (readResults[1] as LocationRow[]) : [] as LocationRow[];

    const customerList = readResults[2] as { id: string; totalOrders: number; totalSpent: number }[];
    const existingCustomer = customerList.length > 0 ? customerList[0] : undefined;

    const discountList = data.discountCode ? (readResults[3] as { id: string }[]) : [];
    const appliedDiscount = discountList.length > 0 ? discountList[0] : null;

    const productList = productIds.length > 0
        ? (readResults[4] as {
            id: string;
            price: number;
            discountPercentage: number | null;
            discountType: string | null;
            discountAmount: number | null;
            freeDelivery: boolean;
        }[])
        : [];
    const productMap = new Map(productList.map((p) => [p.id, p]));

    const settingsList = readResults[5] as Record<string, unknown>[];
    const settings = settingsList.length > 0 ? settingsList[0] as Record<string, unknown> : null;

    const shippingMethodList = readResults[6] as Record<string, unknown>[];
    const shippingMethod = shippingMethodList.length > 0 ? shippingMethodList[0] as Record<string, unknown> : null;

    // Validation (Pre-Check)
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const item of data.items) {
        if (item.variantId) {
            const variant = variantMap.get(item.variantId);
            if (!variant) {
                throw new NotFoundError(`Variant ${item.variantId} not found.`);
            }
        }
        const product = productMap.get(item.productId);
        if (!product) {
            throw new NotFoundError(`Product ${item.productId} not found or is inactive.`);
        }
    }

    // ------------------------------------------------------------------
    // SERVER-SIDE PRICE VERIFICATION
    // ------------------------------------------------------------------
    let serverItemTotal = 0;
    // Build server-verified unit prices per item index for use in queue payload
    const serverUnitPrices: number[] = [];
    for (const item of data.items) {
        let unitPrice: number;

        if (item.variantId) {
            const variant = variantMap.get(item.variantId)!;
            const product = productMap.get(item.productId)!;
            unitPrice = variant.price;

            // Variant discount overrides product discount; if variant has none, fall back to product discount
            const variantHasDiscount =
                (variant.discountType === "percentage" && (variant.discountPercentage ?? 0) > 0) ||
                (variant.discountType === "flat" && (variant.discountAmount ?? 0) > 0);

            if (variantHasDiscount) {
                if (variant.discountType === "percentage" && (variant.discountPercentage ?? 0) > 0) {
                    unitPrice = unitPrice * (1 - (variant.discountPercentage ?? 0) / 100);
                } else if (variant.discountType === "flat" && (variant.discountAmount ?? 0) > 0) {
                    unitPrice = Math.max(0, unitPrice - (variant.discountAmount ?? 0));
                }
            } else if (product.discountType === "percentage" && (product.discountPercentage ?? 0) > 0) {
                unitPrice = unitPrice * (1 - (product.discountPercentage ?? 0) / 100);
            } else if (product.discountType === "flat" && (product.discountAmount ?? 0) > 0) {
                unitPrice = Math.max(0, unitPrice - (product.discountAmount ?? 0));
            }
        } else {
            const product = productMap.get(item.productId)!;
            unitPrice = product.price;

            if (product.discountType === "percentage" && (product.discountPercentage ?? 0) > 0) {
                unitPrice = unitPrice * (1 - (product.discountPercentage ?? 0) / 100);
            } else if (product.discountType === "flat" && (product.discountAmount ?? 0) > 0) {
                unitPrice = Math.max(0, unitPrice - (product.discountAmount ?? 0));
            }
        }

        unitPrice = roundPrice(unitPrice);
        serverUnitPrices.push(unitPrice);
        serverItemTotal += unitPrice * item.quantity;
    }

    serverItemTotal = roundPrice(serverItemTotal);

    const hasFreeDeliveryProduct = data.items.some((item) => {
        const product = productMap.get(item.productId);
        return product?.freeDelivery === true;
    });

    // Existing storefront behavior: any free-delivery item waives shipping method and charge.
    let verifiedShippingCharge: number;
    if (hasFreeDeliveryProduct) {
        verifiedShippingCharge = 0;
    } else {
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

        verifiedShippingCharge = roundPrice(methodFee);
    }

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

    // Process Location Data
    const locationMap = new Map(locationResults.map((location: LocationRow) => [location.id, location]));
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

    const cityName = city.name;
    const zoneName = zone.name;
    const areaName = area?.name ?? null;

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
            cityName,
            zoneName,
            areaName,
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
            inventoryAction: data.items.some(item => item.variantId !== null) ? "reserved" : "none",
        },
        items: data.items.map((item, idx) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: serverUnitPrices[idx] ?? item.price,
            productName: item.productName ?? null,
            variantLabel: item.variantLabel ?? null,
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
