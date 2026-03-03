// src/modules/orders/orders.service.ts
// Admin order service: queries and CRUD mutations.

import { db } from "@/db";
import {
    orders,
    orderItems,
    customers,
    customerHistory,
    products,
    productVariants,
    deliveryShipments,
    deliveryProviders,
    deliveryLocations,
} from "@/db/schema";

import { sql, desc, eq, inArray, isNull, and } from "drizzle-orm";
import { ftsMatch, sanitizeFtsQuery } from "@/lib/search/fts5";
import { generateOrderId } from "@/shared/order-utils";
import { calculateCustomerStats } from "@/shared/customer-utils";
import { nanoid } from "nanoid";
import type { CreateOrderInput } from "./orders.validation";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface OrderShipmentSummary {
    id: string;
    providerId: string | null;
    providerType: string | null;
    providerName: string | null;
    status: string;
    rawStatus: string | null;
    externalId: string | null;
    trackingId: string | null;
    lastChecked: Date | null;
    updatedAt: Date;
    createdAt: Date;
}

export interface OrderListItem {
    id: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    customerId: string | null;
    totalAmount: number;
    shippingCharge: number;
    discountAmount: number | null;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    fulfillmentStatus: string;
    createdAt: Date;
    updatedAt: Date;
    itemCount: number;
    city: string;
    zone: string;
    area: string | null;
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
    latestShipment: OrderShipmentSummary | null;
}

export interface OrderDetails extends OrderListItem {
    notes: string | null;
    shippingAddress: string;
    customerId: string | null;
    deletedAt: Date | null;
    items: {
        id: string;
        productId: string;
        variantId: string | null;
        quantity: number;
        price: number;
        product: {
            name: string;
            variant?: {
                size: string | null;
                color: string | null;
                weight: number | null;
                sku: string;
            };
        };
    }[];
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function normalizeDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number") {
        return value > 1e12 ? new Date(value) : new Date(value * 1000);
    }
    const numericValue = Number(value);
    if (!Number.isNaN(numericValue) && numericValue !== 0) {
        return numericValue > 1e12
            ? new Date(numericValue)
            : new Date(numericValue * 1000);
    }
    try {
        return new Date(String(value));
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of orders for the admin dashboard.
 * Includes item counts and the latest shipment per order.
 */
export async function getOrders(options: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?: "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
    startDate?: Date;
    endDate?: Date;
}) {
    const {
        search,
        status,
        page = 1,
        limit = 10,
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const offset = (page - 1) * limit;

    const whereConditions = [];

    if (showTrashed) {
        whereConditions.push(sql`${orders.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${orders.deletedAt} IS NULL`);
    }

    let rankExpression = undefined;
    if (search) {
        const cond = ftsMatch("orders_fts", "orders", search);
        if (cond) {
            whereConditions.push(cond);
            const sanitized = sanitizeFtsQuery(search);
            rankExpression = sql`(SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}) ASC`;
        }
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (startDate) {
        const startTs = Math.floor(startDate.getTime() / 1000);
        whereConditions.push(sql`${orders.createdAt} >= ${startTs}`);
    }

    if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        const endTs = Math.floor(endOfDay.getTime() / 1000);
        whereConditions.push(sql`${orders.createdAt} <= ${endTs}`);
    }

    const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(
            whereConditions.length > 0
                ? sql`${sql.join(whereConditions, sql` AND `)}`
                : undefined,
        );

    const results = await db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            customerId: orders.customerId,
            totalAmount: orders.totalAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
        })
        .from(orders)
        .where(
            whereConditions.length > 0
                ? sql`${sql.join(whereConditions, sql` AND `)}`
                : undefined,
        )
        .limit(limit)
        .offset(offset)
        .orderBy(
            (() => {
                if (rankExpression) return rankExpression;

                const sortField = (() => {
                    switch (sort) {
                        case "customerName":
                            return orders.customerName;
                        case "totalAmount":
                            return orders.totalAmount;
                        case "status":
                            return orders.status;
                        case "createdAt":
                            return orders.createdAt;
                        case "updatedAt":
                        default:
                            return orders.updatedAt;
                    }
                })();

                return order === "asc" ? sql`${sortField} asc` : sql`${sortField} desc`;
            })(),
        );

    const orderIds = results.map((r) => r.id);

    const [itemCounts, shipments] = await db.batch([
        db
            .select({
                orderId: orderItems.orderId,
                count: sql<number>`COUNT(*)`,
                totalQuantity: sql<number>`SUM(${orderItems.quantity})`,
            })
            .from(orderItems)
            .where(sql`${orderItems.orderId} IN ${orderIds}`)
            .groupBy(orderItems.orderId),
        results.length > 0
            ? db
                .select({
                    orderId: deliveryShipments.orderId,
                    id: deliveryShipments.id,
                    providerId: deliveryShipments.providerId,
                    providerType: deliveryShipments.providerType,
                    status: deliveryShipments.status,
                    rawStatus: deliveryShipments.rawStatus,
                    externalId: deliveryShipments.externalId,
                    trackingId: deliveryShipments.trackingId,
                    lastChecked: deliveryShipments.lastChecked,
                    updatedAt: deliveryShipments.updatedAt,
                    createdAt: deliveryShipments.createdAt,
                    providerName: deliveryProviders.name,
                })
                .from(deliveryShipments)
                .leftJoin(
                    deliveryProviders,
                    eq(deliveryShipments.providerId, deliveryProviders.id),
                )
                .where(inArray(deliveryShipments.orderId, orderIds))
                .orderBy(desc(deliveryShipments.createdAt))
            : db.select({
                orderId: sql<string>`NULL`.as("orderId"),
                id: sql<string>`NULL`.as("id"),
                providerId: sql<string | null>`NULL`.as("providerId"),
                providerType: sql<string | null>`NULL`.as("providerType"),
                status: sql<string>`NULL`.as("status"),
                rawStatus: sql<string | null>`NULL`.as("rawStatus"),
                externalId: sql<string | null>`NULL`.as("externalId"),
                trackingId: sql<string | null>`NULL`.as("trackingId"),
                lastChecked: sql<Date | null>`NULL`.as("lastChecked"),
                updatedAt: sql<Date | null>`NULL`.as("updatedAt"),
                createdAt: sql<Date | null>`NULL`.as("createdAt"),
                providerName: sql<string | null>`NULL`.as("providerName"),
            }).from(deliveryShipments).where(sql`1=0`)
    ]);

    const itemCountMap = new Map(
        itemCounts.map((ic) => [
            ic.orderId,
            { count: ic.count, quantity: ic.totalQuantity },
        ]),
    );

    const shipmentMap = new Map<string, OrderShipmentSummary>();

    for (const shipment of shipments) {
        if (!shipmentMap.has(shipment.orderId)) {
            shipmentMap.set(shipment.orderId, {
                id: shipment.id,
                providerId: shipment.providerId,
                providerType: shipment.providerType,
                providerName: shipment.providerName,
                status: shipment.status,
                rawStatus: shipment.rawStatus,
                externalId: shipment.externalId,
                trackingId: shipment.trackingId,
                lastChecked: normalizeDate(shipment.lastChecked),
                updatedAt: normalizeDate(shipment.updatedAt) ?? new Date(),
                createdAt: normalizeDate(shipment.createdAt) ?? new Date(),
            });
        }
    }

    const formattedResults = results.map((order) => ({
        ...order,
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        itemCount: itemCountMap.get(order.id)?.count || 0,
        totalQuantity: itemCountMap.get(order.id)?.quantity || 0,
        latestShipment: shipmentMap.get(order.id) || null,
    }));

    return {
        orders: formattedResults,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
}

/**
 * Returns full order details including all items and variant info.
 * Returns null if the order does not exist.
 */
export async function getOrderDetails(
    id: string,
): Promise<OrderDetails | null> {
    const order = await db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            customerId: orders.customerId,
            totalAmount: orders.totalAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            notes: orders.notes,
            shippingAddress: orders.shippingAddress,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${orders.deletedAt} AS INTEGER)`,
            itemCount: sql<number>`(
        SELECT COUNT(*) 
        FROM ${orderItems} 
        WHERE ${orderItems.orderId} = ${orders.id}
      )`,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) return null;

    const items = await db
        .select({
            id: orderItems.id,
            productId: orderItems.productId,
            variantId: orderItems.variantId,
            quantity: orderItems.quantity,
            price: orderItems.price,
            productName: products.name,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .where(eq(orderItems.orderId, id));

    const variantIds = [...new Set(items.map((i) => i.variantId).filter(Boolean))] as string[];
    const variantMap = new Map<
        string,
        { size: string | null; color: string | null; weight: number | null; sku: string }
    >();
    if (variantIds.length > 0) {
        const variants = await db
            .select({
                id: productVariants.id,
                size: productVariants.size,
                color: productVariants.color,
                weight: productVariants.weight,
                sku: productVariants.sku,
            })
            .from(productVariants)
            .where(inArray(productVariants.id, variantIds));
        for (const v of variants) {
            variantMap.set(v.id, {
                size: v.size,
                color: v.color,
                weight: v.weight,
                sku: v.sku,
            });
        }
    }

    const formattedItems = items.map((item) => {
        const variant = item.variantId ? variantMap.get(item.variantId) : undefined;
        return {
            id: item.id,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            product: {
                name: item.productName || "Unknown Product",
                ...(variant && { variant }),
            },
        };
    });

    return {
        ...order,
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        items: formattedItems,
        latestShipment: null,
    };
}

// ─────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────

/**
 * Creates an order in the admin context (manual order entry).
 * Handles customer lookup/creation, location name resolution,
 * order row insertion, and order items insertion.
 */
export async function createOrder(data: CreateOrderInput): Promise<{ id: string }> {
    // Calculate total amount
    const totalAmount =
        data.items.reduce((sum, item) => sum + item.price * item.quantity, 0) +
        data.shippingCharge -
        (data.discountAmount || 0);

    // Resolve location names
    const locationIds = [data.city, data.zone, data.area].filter(Boolean) as string[];
    const locationMap = new Map<string, string>();
    if (locationIds.length > 0) {
        const locationResults = await db
            .select({ id: deliveryLocations.id, name: deliveryLocations.name })
            .from(deliveryLocations)
            .where(and(
                sql`${deliveryLocations.id} IN (${locationIds.join(",")})`,
                isNull(deliveryLocations.deletedAt),
            ));
        locationResults.forEach((loc) => locationMap.set(loc.id, loc.name));
    }

    const cityName = data.cityName || (data.city ? locationMap.get(data.city) || data.city : "");
    const zoneName = data.zoneName || (data.zone ? locationMap.get(data.zone) || data.zone : "");
    const areaName = data.areaName || (data.area ? locationMap.get(data.area) || null : null);

    // Get or create customer
    const existingCustomer = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, data.customerPhone))
        .get();

    let customerId = existingCustomer?.id;

    if (!existingCustomer) {
        const [newCustomer] = await db
            .insert(customers)
            .values({
                id: "cust_" + nanoid(),
                name: data.customerName,
                phone: data.customerPhone,
                email: data.customerEmail,
                address: data.shippingAddress,
                city: data.city,
                zone: data.zone,
                area: data.area,
                totalOrders: 1,
                totalSpent: totalAmount,
                lastOrderAt: sql`unixepoch()`,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })
            .returning();

        customerId = newCustomer.id;

        await db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId,
            name: data.customerName,
            email: data.customerEmail,
            phone: data.customerPhone,
            address: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            changeType: "created",
            createdAt: sql`unixepoch()`,
        });
    } else {
        const customerOrders = await db
            .select({ totalAmount: orders.totalAmount, createdAt: orders.createdAt })
            .from(orders)
            .where(eq(orders.customerId, existingCustomer.id));

        const allOrders = [
            ...customerOrders,
            { totalAmount, createdAt: Math.floor(Date.now() / 1000) },
        ];
        const stats = calculateCustomerStats(allOrders);

        await db.update(customers)
            .set({
                totalOrders: stats.totalOrders,
                totalSpent: stats.totalSpent,
                lastOrderAt: stats.lastOrderAt ? sql`${Math.floor(stats.lastOrderAt.getTime() / 1000)}` : null,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(customers.id, existingCustomer.id));

        await db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: existingCustomer.id,
            name: data.customerName,
            email: data.customerEmail,
            phone: data.customerPhone,
            address: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            changeType: "updated",
            createdAt: sql`unixepoch()`,
        });
    }

    // Create order
    const [order] = await db.insert(orders)
        .values({
            id: generateOrderId(),
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
            shippingCharge: data.shippingCharge,
            discountAmount: data.discountAmount,
            status: "pending",
            customerId,
            inventoryAction: "deducted",
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    // Create order items
    if (data.items.length > 0) {
        await db.insert(orderItems).values(
            data.items.map((item) => ({
                id: generateOrderId(),
                orderId: order.id,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                price: item.price,
                createdAt: sql`unixepoch()`,
            })),
        );
    }

    return { id: order.id };
}
