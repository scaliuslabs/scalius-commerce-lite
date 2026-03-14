// src/modules/orders/orders.service.ts
// Admin order service: queries and CRUD mutations.

import { db } from "@scalius/database/client";
import type { Database } from "@scalius/database/client";
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
    discounts,
    OrderStatus,
    FulfillmentStatus,
    ItemFulfillmentStatus,
} from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { reserveMultiple, releaseMultiple } from "../inventory";
import type { ReservationEntry } from "../inventory";
import { markCODReturned, recordCODCollection, recordCODFailure } from "../payments/cod";
import { DeliveryService } from "../delivery/service";

import { sql, desc, eq, inArray, isNull, and } from "drizzle-orm";
import { ftsMatch, sanitizeFtsQuery } from "../../search/fts5";
import { generateOrderId } from "@scalius/shared/order-utils";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
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

export async function updateOrder(id: string, data: Record<string, unknown>): Promise<{ id: string }> {
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

    const existingOrder = await db
        .select({
            id: orders.id,
            customerId: orders.customerId,
            customerPhone: orders.customerPhone,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
        })
        .from(orders)
        .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
        .get();

    if (!existingOrder) throw new Error("Order not found");

    const existingItems = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
    const pool = (existingOrder.inventoryPool as "regular" | "preorder" | "backorder") ?? "regular";

    if (existingOrder.inventoryAction === "reserved") {
        const oldEntries: ReservationEntry[] = existingItems
            .filter((i) => i.variantId)
            .map((i) => ({ variantId: i.variantId!, quantity: i.quantity, pool }));
        const newEntries: ReservationEntry[] = data.items
            .filter((i) => i.variantId)
            .map((i) => ({ variantId: i.variantId!, quantity: i.quantity, pool }));

        if (oldEntries.length > 0) await releaseMultiple(db, oldEntries, id);

        if (newEntries.length > 0) {
            const reserveResult = await reserveMultiple(db, newEntries, id);
            if (!reserveResult.success) {
                if (oldEntries.length > 0) await reserveMultiple(db, oldEntries, id);
                throw new Error(reserveResult.error ?? "Insufficient stock for updated items");
            }
        }
    } else if (existingOrder.inventoryAction === "deducted") {
        // Direct quantity comparisons
        for (const existingItem of existingItems) {
            if (existingItem.variantId) {
                const matchingNewItem = data.items.find(
                    (item: Record<string, unknown>) => item.variantId === existingItem.variantId && item.quantity === existingItem.quantity
                );
                if (!matchingNewItem) {
                    await db.update(productVariants)
                        .set({ stock: sql`${productVariants.stock} + ${existingItem.quantity}`, updatedAt: sql`unixepoch()` })
                        .where(eq(productVariants.id, existingItem.variantId));
                }
            }
        }
        for (const item of data.items) {
            if (item.variantId) {
                const existingItem = existingItems.find((ei) => ei.variantId === item.variantId);
                const quantityDiff = existingItem ? item.quantity - existingItem.quantity : item.quantity;

                if (quantityDiff !== 0) {
                    const variant = await db.select().from(productVariants).where(and(eq(productVariants.id, item.variantId), isNull(productVariants.deletedAt))).get();
                    if (!variant) throw new Error(`Variant ${item.variantId} not found`);
                    if (variant.stock < quantityDiff) {
                        throw new Error(`Insufficient stock for variant ${item.variantId}. Available: ${variant.stock}, Additional Requested: ${quantityDiff}`);
                    }
                    await db.update(productVariants)
                        .set({ stock: variant.stock - quantityDiff, updatedAt: sql`unixepoch()` })
                        .where(eq(productVariants.id, item.variantId));
                }
            }
        }
    }

    const totalAmount = data.items.reduce((sum: number, item: Record<string, unknown>) => sum + (item.price as number) * (item.quantity as number), 0) + data.shippingCharge - (data.discountAmount || 0);
    let customerId = existingOrder.customerId;

    if (data.customerPhone !== existingOrder.customerPhone) {
        const customer = await db.select().from(customers).where(eq(customers.phone, data.customerPhone)).get();
        if (customer) {
            customerId = customer.id;
        } else {
            const [newCustomer] = await db.insert(customers).values({
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
            }).returning();
            customerId = newCustomer.id;
        }
    }

    let newInventoryAction = existingOrder.inventoryAction;
    if (data.status !== existingOrder.status) {
        newInventoryAction = await applyInventoryForStatusChange(db, id, data.status);
    }

    const [order] = await db.update(orders).set({
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
        status: data.status,
        inventoryAction: newInventoryAction,
        customerId,
        updatedAt: sql`unixepoch()`,
    }).where(eq(orders.id, id)).returning();

    await db.delete(orderItems).where(eq(orderItems.orderId, id));

    if (data.items.length > 0) {
        await db.insert(orderItems).values(data.items.map((item: Record<string, unknown>) => ({
            id: "item_" + nanoid(),
            orderId: order.id,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            createdAt: sql`unixepoch()`,
        })));
    }

    if (existingOrder.customerId) {
        await updateCustomerStatsService(existingOrder.customerId);
    }
    if (customerId && customerId !== existingOrder.customerId) {
        await updateCustomerStatsService(customerId);
    }

    return { id: order.id };
}

async function updateCustomerStatsService(customerId: string) {
    const customerOrders = await db.select({ totalAmount: orders.totalAmount, createdAt: orders.createdAt })
        .from(orders).where(eq(orders.customerId, customerId));
    const stats = calculateCustomerStats(customerOrders);
    await db.update(customers).set({
        totalOrders: stats.totalOrders,
        totalSpent: stats.totalSpent,
        lastOrderAt: stats.lastOrderAt ? sql`${Math.floor(stats.lastOrderAt.getTime() / 1000)}` : null,
        updatedAt: sql`unixepoch()`,
    }).where(eq(customers.id, customerId));
}

export async function deleteOrder(id: string) {
    const orderToDelete = await db.select({ id: orders.id, inventoryAction: orders.inventoryAction }).from(orders).where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`).get();
    if (!orderToDelete) throw new Error("Order not found");
    if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.update(orders).set({ deletedAt: sql`unixepoch()`, inventoryAction: "restored" }).where(eq(orders.id, id));
}

export async function restoreOrder(id: string) {
    await db.update(orders).set({ deletedAt: null }).where(eq(orders.id, id));
}

export async function permanentlyDeleteOrder(id: string) {
    const orderToDelete = await db.select({ inventoryAction: orders.inventoryAction }).from(orders).where(eq(orders.id, id)).get();
    if (orderToDelete && (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted")) {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.delete(orderItems).where(eq(orderItems.orderId, id));
    await db.delete(orders).where(eq(orders.id, id));
}

export async function bulkDeleteOrders(orderIds: string[], permanent: boolean = false) {
    for (const orderId of orderIds) {
        const order = await db.select({ id: orders.id, inventoryAction: orders.inventoryAction }).from(orders).where(eq(orders.id, orderId)).get();
        if (!order) continue;
        if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
            await applyInventoryForStatusChange(db, orderId, "cancelled");
        }
    }

    if (permanent) {
        await db.delete(orders).where(sql`${orders.id} IN ${orderIds}`);
        await db.delete(orderItems).where(sql`${orderItems.orderId} IN ${orderIds}`);
    } else {
        await db.update(orders)
            .set({ deletedAt: sql`unixepoch()`, inventoryAction: "restored" })
            .where(sql`${orders.id} IN ${orderIds}`);
    }
}

const deliveryService = new DeliveryService();

export async function bulkShipOrders(orderIds: string[], providerId: string, options: Record<string, unknown>) {
    const results = [];
    for (const orderId of orderIds) {
        try {
            const shipment = await deliveryService.createShipment(orderId, providerId, options);
            if (shipment.success) {
                const newInventoryAction = await applyInventoryForStatusChange(db, orderId, OrderStatus.SHIPPED);
                await db.update(orders).set({
                    status: OrderStatus.SHIPPED,
                    fulfillmentStatus: FulfillmentStatus.COMPLETE,
                    inventoryAction: newInventoryAction,
                    updatedAt: sql`unixepoch()`,
                }).where(eq(orders.id, orderId));
            }
            results.push({ orderId, success: shipment.success, shipment: shipment.success ? shipment : undefined, error: shipment.success ? undefined : shipment.message });
        } catch (error) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}

export async function processCodAction(orderId: string, body: Record<string, unknown>) {
    switch (body.action) {
        case "collected":
            const colResult = await recordCODCollection(db, { orderId, collectedBy: body.collectedBy, collectedAmount: body.collectedAmount, receiptUrl: body.receiptUrl });
            if (!colResult.success) throw new Error(colResult.error);
            await db.update(orders).set({ status: OrderStatus.DELIVERED, updatedAt: sql`unixepoch()` }).where(eq(orders.id, orderId));
            return { success: true, message: "COD collection recorded" };
        case "failed":
            const failResult = await recordCODFailure(db, { orderId, reason: body.reason, notes: body.notes });
            if (!failResult.success) throw new Error(failResult.error);
            return { success: true, message: "COD failure recorded" };
        case "returned":
            const retResult = await markCODReturned(db, orderId);
            if (!retResult.success) throw new Error(retResult.error);
            await applyInventoryForStatusChange(db, orderId, OrderStatus.RETURNED);
            await db.update(orders).set({ status: OrderStatus.RETURNED, updatedAt: sql`unixepoch()` }).where(eq(orders.id, orderId));
            return { success: true, message: "Order marked as returned" };
        default:
            throw new Error("Invalid action");
    }
}

export async function getOrderShipments(orderId: string) {
    return db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, orderId)).all();
}

export async function createFulfillmentShipment(orderId: string, body: Record<string, unknown>) {
    const order = await db.select({ id: orders.id, status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new Error("Order not found");
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
        throw new Error("Cannot fulfill a cancelled/returned order");
    }

    const allItems = await db.select({ id: orderItems.id, fulfillmentStatus: orderItems.fulfillmentStatus }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const shipmentItemIds = body.itemIds ?? allItems.map((i) => i.id);

    const alreadyFulfilled = allItems.filter((i) => shipmentItemIds.includes(i.id) && (i.fulfillmentStatus === ItemFulfillmentStatus.SHIPPED || i.fulfillmentStatus === ItemFulfillmentStatus.DELIVERED));
    if (alreadyFulfilled.length > 0) throw new Error(`Items already shipped: ${alreadyFulfilled.map((i) => i.id).join(", ")}`);

    const shipmentId = `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    const unfulfilledItemIds = allItems.filter((i) => i.fulfillmentStatus === ItemFulfillmentStatus.PENDING || i.fulfillmentStatus === ItemFulfillmentStatus.PICKED || i.fulfillmentStatus === ItemFulfillmentStatus.PACKED).map((i) => i.id);
    const isFinalShipment = body.isFinalShipment ?? (shipmentItemIds.every((sid: string) => unfulfilledItemIds.includes(sid)) && unfulfilledItemIds.every((uid) => shipmentItemIds.includes(uid)));

    const newFulfillmentStatus = isFinalShipment ? FulfillmentStatus.COMPLETE : FulfillmentStatus.PARTIAL;
    // Drizzle D1 batch() requires specific tuple types
    const writes: unknown[] = [];

    writes.push(db.insert(deliveryShipments).values({
        id: shipmentId, orderId, trackingId: body.trackingId ?? null, trackingUrl: body.trackingUrl ?? null,
        courierName: body.courierName ?? null, status: "processing", note: body.note ?? null,
        shipmentItems: JSON.stringify(shipmentItemIds), shipmentAmount: body.shipmentAmount ?? null, isFinalShipment,
        createdAt: now, updatedAt: now,
    }));

    for (const itemId of shipmentItemIds) {
        writes.push(db.update(orderItems).set({ fulfillmentStatus: ItemFulfillmentStatus.SHIPPED }).where(eq(orderItems.id, itemId)));
    }

    const orderUpdate: Record<string, unknown> = { fulfillmentStatus: newFulfillmentStatus, updatedAt: sql`unixepoch()` };
    if (isFinalShipment && order.status === OrderStatus.CONFIRMED) orderUpdate.status = OrderStatus.SHIPPED;

    writes.push(db.update(orders).set(orderUpdate).where(eq(orders.id, orderId)));
    await db.batch(writes as any);

    if (isFinalShipment && order.status === OrderStatus.CONFIRMED) {
        await applyInventoryForStatusChange(db, orderId, OrderStatus.SHIPPED).catch(console.error);
    }

    return { success: true, shipmentId, isFinalShipment, fulfillmentStatus: newFulfillmentStatus };
}

// ─────────────────────────────────────────
// Storefront order creation
// ─────────────────────────────────────────

export interface StorefrontOrderItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
    productName?: string | null;
    variantLabel?: string | null;
}

export interface CreateStorefrontOrderInput {
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    shippingAddress: string;
    city: string;
    zone: string;
    area: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    areaName?: string | null;
    notes: string | null;
    items: StorefrontOrderItem[];
    discountAmount: number | null;
    discountCode?: string | null;
    shippingCharge: number;
    shippingMethodId?: string | null;
    paymentMethod: string;
    inventoryPool: string;
}

export interface CreateStorefrontOrderResult {
    checkoutToken: string;
    orderId: string;
    paymentMethod: string;
    totalAmount: number;
    queuePayload: Record<string, unknown>;
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
    calculateDiscountAmount: (db: Database, discount: unknown, total: number, items: unknown[], shippingCost: number) => number,
): Promise<CreateStorefrontOrderResult> {
    // ------------------------------------------------------------------
    // 1. Batched Reads
    // ------------------------------------------------------------------
    const variantIds = data.items
        .map((item) => item.variantId)
        .filter((id): id is string => id !== null);

    const locationIds = [data.city, data.zone, data.area].filter(Boolean);

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
                .select()
                .from(deliveryLocations)
                .where(
                    and(
                        sql`${deliveryLocations.id} IN ${locationIds}`,
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
    if (data.discountCode) {
        readBatch.push(
            storefrontDb
                .select({ id: discounts.id })
                .from(discounts)
                .where(eq(discounts.code, data.discountCode)),
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
    const { siteSettings: siteSettingsTable, shippingMethods: shippingMethodsTable, discounts: discountsTable } = await import("@scalius/database/schema");
    readBatch.push(storefrontDb.select().from(siteSettingsTable).limit(1));

    // 7. Shipping Method
    if (data.shippingMethodId) {
        readBatch.push(
            storefrontDb
                .select()
                .from(shippingMethodsTable)
                .where(eq(shippingMethodsTable.id, data.shippingMethodId)),
        );
    } else {
        readBatch.push(storefrontDb.select().from(shippingMethodsTable).limit(0));
    }

    // Execute Read Batch
    const readResults = await storefrontDb.batch(readBatch as [unknown, unknown, unknown, unknown, unknown, unknown, unknown]);

    // Unpack Results
    const variants = variantIds.length > 0 ? (readResults[0] as unknown[]) : [];
    const locationResults = locationIds.length > 0 ? (readResults[1] as unknown[]) : [];

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

    const settingsList = readResults[5] as unknown[];
    const settings = settingsList.length > 0 ? settingsList[0] : null;

    const shippingMethodList = readResults[6] as unknown[];
    const shippingMethod = shippingMethodList.length > 0 ? shippingMethodList[0] : null;

    // Validation (Pre-Check)
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const item of data.items) {
        if (item.variantId) {
            const variant = variantMap.get(item.variantId);
            if (!variant) {
                throw new Error(`VALIDATION_ERROR:Variant ${item.variantId} not found.`);
            }
        }
        const product = productMap.get(item.productId);
        if (!product) {
            throw new Error(`VALIDATION_ERROR:Product ${item.productId} not found or is inactive.`);
        }
    }

    // ------------------------------------------------------------------
    // SERVER-SIDE PRICE VERIFICATION
    // ------------------------------------------------------------------
    let serverItemTotal = 0;
    for (const item of data.items) {
        let unitPrice: number;

        if (item.variantId) {
            const variant = variantMap.get(item.variantId) as Record<string, unknown>;
            unitPrice = variant.price;

            if (variant.discountType === "percentage" && variant.discountPercentage > 0) {
                unitPrice = unitPrice * (1 - variant.discountPercentage / 100);
            } else if (variant.discountType === "flat" && variant.discountAmount > 0) {
                unitPrice = Math.max(0, unitPrice - variant.discountAmount);
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

        serverItemTotal += unitPrice * item.quantity;
    }

    serverItemTotal = Math.round(serverItemTotal * 100) / 100;

    // Determine exact shipping charge
    let verifiedShippingCharge = shippingMethod ? shippingMethod.fee : (data.shippingCharge || 0);

    const hasFreeDeliveryProduct = data.items.some((item) => {
        const product = productMap.get(item.productId);
        return product?.freeDelivery === true;
    });
    if (hasFreeDeliveryProduct) {
        verifiedShippingCharge = 0;
    }

    // ------------------------------------------------------------------
    // DISCOUNTS VERIFICATION
    // ------------------------------------------------------------------
    let verifiedDiscountAmount = 0;
    if (data.discountCode) {
        const validationResponse = await isDiscountValid(
            storefrontDb,
            data.discountCode,
            serverItemTotal + verifiedShippingCharge,
            data.items,
            data.customerPhone,
        );

        if (validationResponse && validationResponse.valid && validationResponse.discount) {
            verifiedDiscountAmount = calculateDiscountAmount(
                storefrontDb,
                validationResponse.discount,
                serverItemTotal + verifiedShippingCharge,
                data.items,
                verifiedShippingCharge,
            );
        } else {
            throw new Error(`VALIDATION_ERROR:Discount code ${data.discountCode} is invalid or expired.`);
        }
    }

    const totalAmount = serverItemTotal + verifiedShippingCharge - verifiedDiscountAmount;

    // ------------------------------------------------------------------
    // PARTIAL PAYMENT SECURITY CHECK
    // ------------------------------------------------------------------
    const { PaymentMethod: PaymentMethodEnum, PaymentStatus: PaymentStatusEnum, OrderStatus: OrderStatusEnum, FulfillmentStatus: FulfillmentStatusEnum } = await import("@scalius/database/schema");
    const isPartialEnabled = settings?.partialPaymentEnabled ?? false;
    if (isPartialEnabled && data.paymentMethod === PaymentMethodEnum.COD) {
        throw new Error("VALIDATION_ERROR:Advance deposit is required. COD cannot be selected for the full amount directly.");
    }

    // Process Location Data
    const locationMap = new Map(locationResults.map((l) => [l.id, l.name]));
    const cityName = locationMap.get(data.city) || data.cityName || null;
    const zoneName = locationMap.get(data.zone) || data.zoneName || null;
    const areaName = locationMap.get(data.area || "") || data.areaName || null;

    // ------------------------------------------------------------------
    // Build Queue Payload
    // ------------------------------------------------------------------
    const orderId = generateOrderId();
    const { nanoid: nanoIdFn } = await import("nanoid");
    const checkoutToken = `chk_${nanoIdFn()}`;

    const queuePayload = {
        type: "order.ingest",
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
            status: (isPartialEnabled && data.paymentMethod === PaymentMethodEnum.COD)
                ? OrderStatusEnum.INCOMPLETE
                : data.paymentMethod === PaymentMethodEnum.COD ? OrderStatusEnum.PENDING : OrderStatusEnum.INCOMPLETE,
            paymentMethod: data.paymentMethod,
            paymentStatus: PaymentStatusEnum.UNPAID,
            paidAmount: 0,
            balanceDue: totalAmount,
            fulfillmentStatus: FulfillmentStatusEnum.PENDING,
            inventoryPool: data.inventoryPool,
            inventoryAction: data.items.some(item => item.variantId !== null) ? "reserved" : "none",
        },
        items: data.items.map(item => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            productName: item.productName ?? null,
            variantLabel: item.variantLabel ?? null,
        })),
        discountUsage: appliedDiscount && data.discountAmount && data.discountAmount > 0 ? {
            discountId: appliedDiscount.id,
            amountDiscounted: data.discountAmount,
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

export async function updateOrderStatus(orderId: string, status: string) {
    const existingOrder = await db.select({ status: orders.status, inventoryAction: orders.inventoryAction }).from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) throw new Error("Order not found");
    if (existingOrder.status === status) return { message: "Status unchanged" };

    const newInventoryAction = await applyInventoryForStatusChange(db, orderId, status);
    const result = await db.update(orders).set({ status, inventoryAction: newInventoryAction, updatedAt: sql`unixepoch()` })
        .where(and(eq(orders.id, orderId), eq(orders.status, existingOrder.status))).returning({ id: orders.id });

    if (result.length === 0) throw new Error("Order status was changed by another request. Please reload and try again.");
    return { message: "Order status updated successfully" };
}
