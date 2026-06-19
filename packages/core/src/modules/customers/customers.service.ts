// src/modules/customers/customers.service.ts
// All DB queries and business logic for the customers domain.

import {
    codTracking,
    customers,
    customerHistory,
    deliveryLocations,
    deliveryProviders,
    deliveryShipments,
    orderItems,
    orderNotificationDeliveryReceipts,
    orderPayments,
    orders,
    paymentPlans,
    productImages,
    products,
    productVariants,
} from "@scalius/database/schema";
import { sql, isNull, inArray, asc, desc, eq, and, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ftsMatch } from "../../search/fts5";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

// Re-export schemas from the canonical validation module
export {
    createCustomerSchema,
    updateCustomerSchema,
    type CreateCustomerInput,
    type UpdateCustomerInput,
} from "./customers.validation";
import type { CreateCustomerInput, UpdateCustomerInput } from "./customers.validation";

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

const timestampToIso = (timestamp: number | null): string | null => {
    if (!timestamp) return null;
    return new Date(timestamp * 1000).toISOString();
};

interface CustomerOrderShipmentSummary {
    id: string;
    providerType: string;
    providerName: string | null;
    status: string;
    rawStatus: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
    courierName: string | null;
    lastChecked: string | null;
    updatedAt: string | null;
    createdAt: string | null;
}

export interface CustomerOrderDetailTimelineEvent {
    id: string;
    type: "order" | "payment" | "shipment" | "notification";
    status: string;
    label: string;
    happenedAt: string | null;
    details?: string | null;
}

const normalizeStatusLabel = (status: string): string =>
    status
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");

export async function listCustomers(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: "name" | "totalOrders" | "totalSpent" | "lastOrderAt" | "createdAt" | "updatedAt";
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page = 1,
        limit: rawLimit = 10,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const whereConditions: (SQL | undefined)[] = [];
    if (showTrashed) {
        whereConditions.push(sql`${customers.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${customers.deletedAt} IS NULL`);
    }
    if (search) {
        const digitsOnly = search.replace(/[^0-9]/g, "");
        const looksLikePhone = digitsOnly.length >= 4 && digitsOnly.length / search.replace(/\s/g, "").length > 0.5;
        const ftsCondition = ftsMatch("customers_fts", "customers", search);

        if (looksLikePhone && ftsCondition) {
            whereConditions.push(sql`(${ftsCondition} OR ${customers.phone} LIKE ${"%" + digitsOnly + "%"})`);
        } else if (looksLikePhone) {
            whereConditions.push(sql`${customers.phone} LIKE ${"%" + digitsOnly + "%"}`);
        } else if (ftsCondition) {
            whereConditions.push(ftsCondition);
        }
    }

    const whereClause =
        whereConditions.length > 0
            ? sql`${sql.join(whereConditions, sql` AND `)}`
            : undefined;

    const offset = (page - 1) * limit;

    const sortField = (() => {
        switch (sort) {
            case "name": return customers.name;
            case "totalOrders": return customers.totalOrders;
            case "totalSpent": return customers.totalSpent;
            case "lastOrderAt": return customers.lastOrderAt;
            case "createdAt": return customers.createdAt;
            default: return customers.updatedAt;
        }
    })();

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(customers)
        .where(whereClause);

    const resultsQuery = db
        .select({
            id: customers.id,
            name: customers.name,
            email: customers.email,
            phone: customers.phone,
            address: customers.address,
            city: customers.city,
            zone: customers.zone,
            area: customers.area,
            totalOrders: customers.totalOrders,
            totalSpent: customers.totalSpent,
            lastOrderAt: sql<number>`CAST(${customers.lastOrderAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
        })
        .from(customers)
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(order === "asc" ? asc(sortField) : desc(sortField));

    // Batch customer count, results, and all location names in a single D1 round-trip
    const locationQuery = db
        .select({ id: deliveryLocations.id, name: deliveryLocations.name })
        .from(deliveryLocations)
        .where(isNull(deliveryLocations.deletedAt));

    const [countArr, results, locationResults] = await db.batch([
        countQuery,
        resultsQuery,
        locationQuery,
    ] as Parameters<Database["batch"]>[0]) as [
        { count: number }[],
        { id: string; name: string; email: string | null; phone: string; address: string | null; city: string | null; zone: string | null; area: string | null; totalOrders: number; totalSpent: number; lastOrderAt: number; createdAt: number; updatedAt: number }[],
        { id: string; name: string }[],
    ];
    const count = countArr[0]?.count ?? 0;

    const locationMap = new Map<string, string>();
    locationResults.forEach((loc) => locationMap.set(loc.id, loc.name));

    const formattedCustomers = results.map((c) => ({
        ...c,
        lastOrderAt: c.lastOrderAt ? new Date(c.lastOrderAt * 1000).toISOString() : null,
        createdAt: new Date(c.createdAt * 1000).toISOString(),
        updatedAt: new Date(c.updatedAt * 1000).toISOString(),
    }));

    const enhanced = formattedCustomers.map((c) => ({
        ...c,
        cityName: c.city ? locationMap.get(c.city) ?? c.city : null,
        zoneName: c.zone ? locationMap.get(c.zone) ?? c.zone : null,
        areaName: c.area ? locationMap.get(c.area) ?? c.area : null,
    }));

    return {
        customers: enhanced,
        pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
    };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createCustomer(
    db: Database,
    data: CreateCustomerInput,
): Promise<{ id: string }> {
    const existing = await db
        .select({ id: customers.id })
        .from(customers)
        .where(sql`${customers.phone} = ${data.phone}`)
        .get();

    if (existing) throw new ValidationError("Customer with this phone number already exists");

    const locationIds = [data.city, data.zone, data.area].filter(Boolean) as string[];
    let cityName = null, zoneName = null, areaName = null;

    if (locationIds.length > 0) {
        const locs = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(sql`${deliveryLocations.id} IN ${locationIds}`);
        const locMap = new Map(locs.map((l) => [l.id, l.name]));
        if (data.city) cityName = locMap.get(data.city) ?? null;
        if (data.zone) zoneName = locMap.get(data.zone) ?? null;
        if (data.area) areaName = locMap.get(data.area) ?? null;
    }

    const customerId = "cust_" + nanoid();
    await db.batch([
        db.insert(customers).values({
            id: customerId,
            name: data.name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName,
            zoneName,
            areaName,
            totalOrders: 0,
            totalSpent: 0,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId,
            name: data.name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName,
            zoneName,
            areaName,
            changeType: "created",
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

    return { id: customerId };
}

export async function getCustomerById(db: Database, id: string) {
    return db.select().from(customers).where(eq(customers.id, id)).get() ?? null;
}

export async function updateCustomer(
    db: Database,
    id: string,
    data: UpdateCustomerInput,
) {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    if (data.phone && data.phone !== existing.phone) {
        const phoneConflict = await db
            .select({ id: customers.id })
            .from(customers)
            .where(sql`${customers.phone} = ${data.phone} AND ${customers.id} != ${id}`)
            .get();
        if (phoneConflict) throw new ValidationError("Another customer with this phone number already exists");
    }

    let cityName = existing.cityName, zoneName = existing.zoneName, areaName = existing.areaName;
    const locationIds = [data.city ?? existing.city, data.zone ?? existing.zone, data.area ?? existing.area].filter(Boolean) as string[];

    if ((data.city !== undefined || data.zone !== undefined || data.area !== undefined) && locationIds.length > 0) {
        const locs = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(inArray(deliveryLocations.id, locationIds));
        const locMap = new Map(locs.map((l) => [l.id, l.name]));
        if (data.city !== undefined) cityName = data.city ? locMap.get(data.city) ?? null : null;
        if (data.zone !== undefined) zoneName = data.zone ? locMap.get(data.zone) ?? null : null;
        if (data.area !== undefined) areaName = data.area ? locMap.get(data.area) ?? null : null;
    }

    const updateData = {
        ...data,
        cityName,
        zoneName,
        areaName,
        updatedAt: sql`unixepoch()`,
    };

    await db.batch([
        db.update(customers).set(updateData).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            name: data.name ?? existing.name,
            email: data.email !== undefined ? data.email : existing.email,
            phone: data.phone ?? existing.phone,
            address: data.address !== undefined ? data.address : existing.address,
            city: data.city !== undefined ? data.city : existing.city,
            zone: data.zone !== undefined ? data.zone : existing.zone,
            area: data.area !== undefined ? data.area : existing.area,
            cityName,
            zoneName,
            areaName,
            changeType: "updated",
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

}


export async function deleteCustomer(db: Database, id: string): Promise<void> {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    await db.batch([
        db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            name: existing.name,
            email: existing.email,
            phone: existing.phone,
            address: existing.address,
            city: existing.city,
            zone: existing.zone,
            area: existing.area,
            cityName: existing.cityName,
            zoneName: existing.zoneName,
            areaName: existing.areaName,
            changeType: "deleted",
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);
}

export async function permanentlyDeleteCustomer(db: Database, id: string): Promise<void> {
    await db.batch([
        db.delete(customerHistory).where(eq(customerHistory.customerId, id)),
        db.delete(customers).where(eq(customers.id, id)),
    ] as Parameters<Database["batch"]>[0]);
}

export async function restoreCustomer(db: Database, id: string): Promise<void> {
    await db.update(customers).set({ deletedAt: null }).where(eq(customers.id, id));
}

export async function bulkDeleteCustomers(db: Database, ids: string[], permanent = false): Promise<void> {
    if (permanent) {
        await db.delete(customerHistory).where(inArray(customerHistory.customerId, ids));
        await db.delete(customers).where(inArray(customers.id, ids));
    } else {
        await db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(inArray(customers.id, ids));
    }
}

// ─────────────────────────────────────────
// Customer Orders (storefront)
// ─────────────────────────────────────────

export async function getCustomerOrders(
    db: Database,
    customerId: string,
) {
    // Fetch full customer profile from DB
    const dbCustomer = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customerId))
        .get();

    const customerProfile = dbCustomer
        ? {
            id: dbCustomer.id,
            name: dbCustomer.name || "Customer",
            email: dbCustomer.email || "",
            phone: dbCustomer.phone || "",
            address: dbCustomer.address,
            cityName: dbCustomer.cityName,
            zoneName: dbCustomer.zoneName,
            city: dbCustomer.city,
            zone: dbCustomer.zone,
        }
        : null;

    const customerOrders = await db
        .select({
            id: orders.id,
            invoiceNumber: orders.invoiceNumber,
            status: orders.status,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            expectedDelivery: orders.expectedDelivery,
            shippingAddress: orders.shippingAddress,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            notes: orders.notes,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`
        })
        .from(orders)
        .where(and(
            eq(orders.customerId, customerId),
            isNull(orders.deletedAt),
        ))
        .orderBy(desc(orders.createdAt))
        .limit(50);

    // Fetch items for all orders in one batch
    const orderIds = customerOrders.map((o) => o.id);
    const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();
    const latestShipmentByOrder = new Map<string, CustomerOrderShipmentSummary>();

    if (orderIds.length > 0) {
        const [allItems, allShipments] = await db.batch([
            db
                .select({
                    orderId: orderItems.orderId,
                    productId: orderItems.productId,
                    variantId: orderItems.variantId,
                    quantity: orderItems.quantity,
                    price: orderItems.price,
                    productName: products.name,
                    productSlug: products.slug,
                    productImage: sql<string>`(
                        SELECT ${productImages.url}
                        FROM ${productImages}
                        WHERE ${productImages.productId} = ${products.id}
                        AND ${productImages.isPrimary} = 1
                        LIMIT 1
                    )`.as("productImage"),
                    variantSize: productVariants.size,
                    variantColor: productVariants.color
                })
                .from(orderItems)
                .leftJoin(products, eq(products.id, orderItems.productId))
                .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
                .where(sql`${orderItems.orderId} IN ${orderIds}`),
            db
                .select({
                    id: deliveryShipments.id,
                    orderId: deliveryShipments.orderId,
                    providerType: deliveryShipments.providerType,
                    providerName: deliveryProviders.name,
                    status: deliveryShipments.status,
                    rawStatus: deliveryShipments.rawStatus,
                    trackingId: deliveryShipments.trackingId,
                    trackingUrl: deliveryShipments.trackingUrl,
                    courierName: deliveryShipments.courierName,
                    lastChecked: sql<number>`CAST(${deliveryShipments.lastChecked} AS INTEGER)`,
                    updatedAt: sql<number>`CAST(${deliveryShipments.updatedAt} AS INTEGER)`,
                    createdAt: sql<number>`CAST(${deliveryShipments.createdAt} AS INTEGER)`,
                })
                .from(deliveryShipments)
                .leftJoin(deliveryProviders, eq(deliveryProviders.id, deliveryShipments.providerId))
                .where(sql`${deliveryShipments.orderId} IN ${orderIds}`)
                .orderBy(desc(deliveryShipments.createdAt)),
        ] as Parameters<Database["batch"]>[0]) as [
            Array<{
                orderId: string;
                productId: string;
                variantId: string | null;
                quantity: number;
                price: number;
                productName: string | null;
                productSlug: string | null;
                productImage: string | null;
                variantSize: string | null;
                variantColor: string | null;
            }>,
            Array<{
                id: string;
                orderId: string;
                providerType: string;
                providerName: string | null;
                status: string;
                rawStatus: string | null;
                trackingId: string | null;
                trackingUrl: string | null;
                courierName: string | null;
                lastChecked: number | null;
                updatedAt: number | null;
                createdAt: number | null;
            }>,
        ];

        for (const item of allItems) {
            const list = itemsByOrder.get(item.orderId) || [];
            list.push(item);
            itemsByOrder.set(item.orderId, list);
        }

        for (const shipment of allShipments) {
            if (latestShipmentByOrder.has(shipment.orderId)) continue;
            latestShipmentByOrder.set(shipment.orderId, {
                id: shipment.id,
                providerType: shipment.providerType,
                providerName: shipment.providerName,
                status: shipment.status,
                rawStatus: shipment.rawStatus,
                trackingId: shipment.trackingId,
                trackingUrl: shipment.trackingUrl,
                courierName: shipment.courierName,
                lastChecked: timestampToIso(shipment.lastChecked),
                updatedAt: timestampToIso(shipment.updatedAt),
                createdAt: timestampToIso(shipment.createdAt),
            });
        }
    }

    // Format response
    const formattedOrders = customerOrders.map((order) => ({
        ...order,
        createdAt: order.createdAt
            ? new Date(order.createdAt * 1000).toISOString()
            : null,
        latestShipment: latestShipmentByOrder.get(order.id) ?? null,
        items: itemsByOrder.get(order.id) || []
    }));

    return { orders: formattedOrders, customerProfile };
}

export async function getCustomerOrderDetail(
    db: Database,
    customerId: string,
    orderId: string,
) {
    const order = await db
        .select({
            id: orders.id,
            invoiceNumber: orders.invoiceNumber,
            status: orders.status,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            expectedDelivery: orders.expectedDelivery,
            shippingAddress: orders.shippingAddress,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            notes: orders.notes,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
        })
        .from(orders)
        .where(and(
            eq(orders.id, orderId),
            eq(orders.customerId, customerId),
            isNull(orders.deletedAt),
        ))
        .get();

    if (!order) {
        throw new NotFoundError("Order not found");
    }

    const [items, shipments, payments, plans, codRows, notificationReceipts] = await db.batch([
        db
            .select({
                id: orderItems.id,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                price: orderItems.price,
                productName: products.name,
                productSlug: products.slug,
                productImage: sql<string>`(
                    SELECT ${productImages.url}
                    FROM ${productImages}
                    WHERE ${productImages.productId} = ${products.id}
                    AND ${productImages.isPrimary} = 1
                    LIMIT 1
                )`.as("productImage"),
                variantSize: productVariants.size,
                variantColor: productVariants.color,
                unitPrice: orderItems.price,
                lineTotal: sql<number>`${orderItems.quantity} * ${orderItems.price}`.as("lineTotal"),
                fulfillmentStatus: orderItems.fulfillmentStatus,
                createdAt: sql<number>`CAST(${orderItems.createdAt} AS INTEGER)`,
            })
            .from(orderItems)
            .leftJoin(products, eq(products.id, orderItems.productId))
            .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
            .where(eq(orderItems.orderId, orderId)),
        db
            .select({
                id: deliveryShipments.id,
                providerType: deliveryShipments.providerType,
                providerName: deliveryProviders.name,
                status: deliveryShipments.status,
                rawStatus: deliveryShipments.rawStatus,
                trackingId: deliveryShipments.trackingId,
                trackingUrl: deliveryShipments.trackingUrl,
                courierName: deliveryShipments.courierName,
                note: deliveryShipments.note,
                shipmentAmount: deliveryShipments.shipmentAmount,
                isFinalShipment: deliveryShipments.isFinalShipment,
                lastChecked: sql<number>`CAST(${deliveryShipments.lastChecked} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${deliveryShipments.updatedAt} AS INTEGER)`,
                createdAt: sql<number>`CAST(${deliveryShipments.createdAt} AS INTEGER)`,
            })
            .from(deliveryShipments)
            .leftJoin(deliveryProviders, eq(deliveryProviders.id, deliveryShipments.providerId))
            .where(eq(deliveryShipments.orderId, orderId))
            .orderBy(desc(deliveryShipments.createdAt)),
        db
            .select({
                id: orderPayments.id,
                amount: orderPayments.amount,
                currency: orderPayments.currency,
                paymentMethod: orderPayments.paymentMethod,
                paymentType: orderPayments.paymentType,
                status: orderPayments.status,
                codReceiptUrl: orderPayments.codReceiptUrl,
                createdAt: sql<number>`CAST(${orderPayments.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${orderPayments.updatedAt} AS INTEGER)`,
            })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, orderId))
            .orderBy(desc(orderPayments.createdAt)),
        db
            .select({
                totalAmount: paymentPlans.totalAmount,
                depositAmount: paymentPlans.depositAmount,
                balanceDue: paymentPlans.balanceDue,
                balanceDueDate: paymentPlans.balanceDueDate,
                status: paymentPlans.status,
                depositPaidAt: sql<number>`CAST(${paymentPlans.depositPaidAt} AS INTEGER)`,
                balancePaidAt: sql<number>`CAST(${paymentPlans.balancePaidAt} AS INTEGER)`,
                createdAt: sql<number>`CAST(${paymentPlans.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${paymentPlans.updatedAt} AS INTEGER)`,
            })
            .from(paymentPlans)
            .where(eq(paymentPlans.orderId, orderId))
            .limit(1),
        db
            .select({
                codStatus: codTracking.codStatus,
                deliveryAttempts: codTracking.deliveryAttempts,
                failureReason: codTracking.failureReason,
                collectedAmount: codTracking.collectedAmount,
                receiptUrl: codTracking.receiptUrl,
                lastAttemptAt: sql<number>`CAST(${codTracking.lastAttemptAt} AS INTEGER)`,
                collectedAt: sql<number>`CAST(${codTracking.collectedAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${codTracking.updatedAt} AS INTEGER)`,
            })
            .from(codTracking)
            .where(eq(codTracking.orderId, orderId))
            .limit(1),
        db
            .select({
                id: orderNotificationDeliveryReceipts.id,
                notificationType: orderNotificationDeliveryReceipts.notificationType,
                channel: orderNotificationDeliveryReceipts.channel,
                status: orderNotificationDeliveryReceipts.status,
                provider: orderNotificationDeliveryReceipts.provider,
                providerStatus: orderNotificationDeliveryReceipts.providerStatus,
                acceptedAt: sql<number>`CAST(${orderNotificationDeliveryReceipts.acceptedAt} AS INTEGER)`,
                deliveredAt: sql<number>`CAST(${orderNotificationDeliveryReceipts.deliveredAt} AS INTEGER)`,
                failedAt: sql<number>`CAST(${orderNotificationDeliveryReceipts.failedAt} AS INTEGER)`,
                skippedAt: sql<number>`CAST(${orderNotificationDeliveryReceipts.skippedAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${orderNotificationDeliveryReceipts.updatedAt} AS INTEGER)`,
                createdAt: sql<number>`CAST(${orderNotificationDeliveryReceipts.createdAt} AS INTEGER)`,
            })
            .from(orderNotificationDeliveryReceipts)
            .where(and(
                eq(orderNotificationDeliveryReceipts.orderId, orderId),
                inArray(orderNotificationDeliveryReceipts.channel, ["email", "sms", "whatsapp"]),
            ))
            .orderBy(desc(orderNotificationDeliveryReceipts.createdAt)),
    ] as Parameters<Database["batch"]>[0]) as [
        Array<{
            id: string;
            productId: string;
            variantId: string | null;
            quantity: number;
            price: number;
            productName: string | null;
            productSlug: string | null;
            productImage: string | null;
            variantSize: string | null;
            variantColor: string | null;
            unitPrice: number;
            lineTotal: number;
            fulfillmentStatus: string;
            createdAt: number | null;
        }>,
        Array<{
            id: string;
            providerType: string;
            providerName: string | null;
            status: string;
            rawStatus: string | null;
            trackingId: string | null;
            trackingUrl: string | null;
            courierName: string | null;
            note: string | null;
            shipmentAmount: number | null;
            isFinalShipment: boolean;
            lastChecked: number | null;
            updatedAt: number | null;
            createdAt: number | null;
        }>,
        Array<{
            id: string;
            amount: number;
            currency: string;
            paymentMethod: string;
            paymentType: string;
            status: string;
            codReceiptUrl: string | null;
            createdAt: number | null;
            updatedAt: number | null;
        }>,
        Array<{
            totalAmount: number;
            depositAmount: number;
            balanceDue: number;
            balanceDueDate: string | null;
            status: string;
            depositPaidAt: number | null;
            balancePaidAt: number | null;
            createdAt: number | null;
            updatedAt: number | null;
        }>,
        Array<{
            codStatus: string;
            deliveryAttempts: number;
            failureReason: string | null;
            collectedAmount: number | null;
            receiptUrl: string | null;
            lastAttemptAt: number | null;
            collectedAt: number | null;
            updatedAt: number | null;
        }>,
        Array<{
            id: string;
            notificationType: string;
            channel: string;
            status: string;
            provider: string;
            providerStatus: string | null;
            acceptedAt: number | null;
            deliveredAt: number | null;
            failedAt: number | null;
            skippedAt: number | null;
            updatedAt: number | null;
            createdAt: number | null;
        }>,
    ];

    const formattedItems = items.map((item) => ({
        ...item,
        createdAt: timestampToIso(item.createdAt),
    }));

    const formattedShipments = shipments.map((shipment) => ({
        ...shipment,
        lastChecked: timestampToIso(shipment.lastChecked),
        updatedAt: timestampToIso(shipment.updatedAt),
        createdAt: timestampToIso(shipment.createdAt),
    }));

    const formattedPayments = payments.map((payment) => ({
        ...payment,
        createdAt: timestampToIso(payment.createdAt),
        updatedAt: timestampToIso(payment.updatedAt),
    }));

    const paymentPlan = plans[0]
        ? {
            ...plans[0],
            depositPaidAt: timestampToIso(plans[0].depositPaidAt),
            balancePaidAt: timestampToIso(plans[0].balancePaidAt),
            createdAt: timestampToIso(plans[0].createdAt),
            updatedAt: timestampToIso(plans[0].updatedAt),
        }
        : null;

    const cod = codRows[0]
        ? {
            ...codRows[0],
            lastAttemptAt: timestampToIso(codRows[0].lastAttemptAt),
            collectedAt: timestampToIso(codRows[0].collectedAt),
            updatedAt: timestampToIso(codRows[0].updatedAt),
        }
        : null;

    const notifications = notificationReceipts.map((receipt) => ({
        ...receipt,
        acceptedAt: timestampToIso(receipt.acceptedAt),
        deliveredAt: timestampToIso(receipt.deliveredAt),
        failedAt: timestampToIso(receipt.failedAt),
        skippedAt: timestampToIso(receipt.skippedAt),
        updatedAt: timestampToIso(receipt.updatedAt),
        createdAt: timestampToIso(receipt.createdAt),
    }));

    const timeline: CustomerOrderDetailTimelineEvent[] = [
        {
            id: `order-created:${order.id}`,
            type: "order",
            status: order.status,
            label: "Order placed",
            happenedAt: timestampToIso(order.createdAt),
            details: `Status: ${normalizeStatusLabel(order.status)}`,
        },
    ];

    for (const payment of formattedPayments) {
        timeline.push({
            id: `payment:${payment.id}`,
            type: "payment",
            status: payment.status,
            label: `Payment ${normalizeStatusLabel(payment.status)}`,
            happenedAt: payment.updatedAt ?? payment.createdAt,
            details: `${normalizeStatusLabel(payment.paymentMethod)} ${normalizeStatusLabel(payment.paymentType)} payment`,
        });
    }

    for (const shipment of formattedShipments) {
        timeline.push({
            id: `shipment:${shipment.id}`,
            type: "shipment",
            status: shipment.status,
            label: `Shipment ${normalizeStatusLabel(shipment.status)}`,
            happenedAt: shipment.lastChecked ?? shipment.updatedAt ?? shipment.createdAt,
            details: shipment.trackingId ? `Tracking ID: ${shipment.trackingId}` : shipment.courierName,
        });
    }

    for (const notification of notifications) {
        timeline.push({
            id: `notification:${notification.id}`,
            type: "notification",
            status: notification.status,
            label: `${normalizeStatusLabel(notification.channel)} notification ${normalizeStatusLabel(notification.status)}`,
            happenedAt:
                notification.deliveredAt ??
                notification.acceptedAt ??
                notification.failedAt ??
                notification.skippedAt ??
                notification.updatedAt ??
                notification.createdAt,
            details: normalizeStatusLabel(notification.notificationType),
        });
    }

    timeline.sort((a, b) => {
        if (!a.happenedAt && !b.happenedAt) return 0;
        if (!a.happenedAt) return 1;
        if (!b.happenedAt) return -1;
        return new Date(a.happenedAt).getTime() - new Date(b.happenedAt).getTime();
    });

    return {
        order: {
            ...order,
            createdAt: timestampToIso(order.createdAt),
            updatedAt: timestampToIso(order.updatedAt),
        },
        items: formattedItems,
        shipments: formattedShipments,
        payments: formattedPayments,
        paymentPlan,
        cod,
        notifications,
        timeline,
    };
}
