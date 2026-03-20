// src/modules/orders/orders.admin.ts
// Admin order service: queries and CRUD mutations.

import type { Database } from "@scalius/database/client";
import { roundPrice, addPrices, subtractPrice } from "@scalius/shared/price-utils";
import {
    orders,
    orderItems,
    customers,
    customerHistory,
    products,
    productVariants,
    productImages,
    deliveryShipments,
    deliveryProviders,
    deliveryLocations,
} from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { reserveMultiple, deductMultiple, releaseMultiple } from "../inventory";
import type { ReservationEntry } from "../inventory";

import { sql, desc, eq, inArray, isNull, and } from "drizzle-orm";
import { ftsMatch, sanitizeFtsQuery } from "../../search/fts5";
import { generateOrderId } from "@scalius/shared/order-utils";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
import { unixToDate } from "@scalius/shared/utils";
import { nanoid } from "nanoid";
import type { CreateOrderInput } from "./orders.validation";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { validateTransition } from "./order-state-machine";
import type { OrderShipmentSummary, OrderDetails } from "./orders.types";

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of orders for the admin dashboard.
 * Includes item counts and the latest shipment per order.
 */
export async function listOrders(db: Database, options: {
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

    const countArr = await db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(
            whereConditions.length > 0
                ? sql`${sql.join(whereConditions, sql` AND `)}`
                : undefined,
        );
    const count = countArr[0]?.count ?? 0;

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
                lastChecked: unixToDate(shipment.lastChecked),
                updatedAt: unixToDate(shipment.updatedAt) ?? new Date(),
                createdAt: unixToDate(shipment.createdAt) ?? new Date(),
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
    db: Database,
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
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
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
            productImage: productImages.url,
            variantSize: productVariants.size,
            variantColor: productVariants.color,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
        .leftJoin(
            productImages,
            and(
                eq(productImages.productId, orderItems.productId),
                eq(productImages.isPrimary, true),
            ),
        )
        .where(eq(orderItems.orderId, id));

    const formattedItems = items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
        productName: item.productName || null,
        productImage: item.productImage || null,
        variantSize: item.variantSize || null,
        variantColor: item.variantColor || null,
    }));

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
 *
 * Inventory flow:
 *   1. Reserve stock for all variant items (validates availability)
 *   2. Insert order + items atomically via db.batch()
 *   3. Convert reservations to permanent deductions (admin orders are immediately active)
 *   4. If batch fails, release all reservations (no orphaned holds)
 */
export async function createOrder(db: Database, data: CreateOrderInput): Promise<{ id: string }> {
    // Calculate total amount
    const totalAmount = subtractPrice(
        addPrices(...data.items.map(item => roundPrice(item.price * item.quantity)), data.shippingCharge),
        data.discountAmount || 0,
    );

    // Resolve location names (read-only, safe outside transaction)
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

    // Get or create customer (read outside batch, writes inside)
    const existingCustomer = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, data.customerPhone))
        .get();

    let customerId = existingCustomer?.id;

    // Pre-compute customer stats if existing customer
    let customerStats: { totalOrders: number; totalSpent: number; lastOrderAt: Date | null } | null = null;
    if (existingCustomer) {
        const customerOrders = await db
            .select({ totalAmount: orders.totalAmount, createdAt: orders.createdAt })
            .from(orders)
            .where(eq(orders.customerId, existingCustomer.id));

        const allOrders = [
            ...customerOrders,
            { totalAmount, createdAt: Math.floor(Date.now() / 1000) },
        ];
        customerStats = calculateCustomerStats(allOrders);
    }

    // ── Pre-validate and reserve inventory ─────────────────────────────
    // Reserve stock BEFORE inserting the order. This validates availability
    // and holds stock atomically. If any variant has insufficient stock,
    // the order creation fails immediately with a clear error.
    const orderId = generateOrderId();
    const reservationEntries: ReservationEntry[] = data.items
        .filter((item): item is typeof item & { variantId: string } => item.variantId !== null)
        .map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            pool: "regular" as const,
        }));

    if (reservationEntries.length > 0) {
        const reserveResult = await reserveMultiple(db, reservationEntries, orderId);
        if (!reserveResult.success) {
            throw new ValidationError(
                reserveResult.error ?? "Insufficient stock for one or more items",
            );
        }
    }

    // ── Atomic batch: customer + order + items ──────────────────────────
    // D1 batch() executes all statements in a single atomic operation.
    // If any statement fails, none are committed.
    const writeBatch: unknown[] = [];

    if (!existingCustomer) {
        customerId = "cust_" + nanoid();
        writeBatch.push(
            db.insert(customers).values({
                id: customerId,
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
            }),
        );
        writeBatch.push(
            db.insert(customerHistory).values({
                id: "hist_" + nanoid(),
                customerId: customerId!,
                name: data.customerName,
                email: data.customerEmail,
                phone: data.customerPhone,
                address: data.shippingAddress,
                city: data.city,
                zone: data.zone,
                area: data.area,
                changeType: "created",
                createdAt: sql`unixepoch()`,
            }),
        );
    } else {
        writeBatch.push(
            db.update(customers).set({
                totalOrders: customerStats!.totalOrders,
                totalSpent: customerStats!.totalSpent,
                lastOrderAt: customerStats!.lastOrderAt ? sql`${Math.floor(customerStats!.lastOrderAt.getTime() / 1000)}` : null,
                updatedAt: sql`unixepoch()`,
            }).where(eq(customers.id, existingCustomer.id)),
        );
        writeBatch.push(
            db.insert(customerHistory).values({
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
            }),
        );
    }

    // Order row
    writeBatch.push(
        db.insert(orders).values({
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
            shippingCharge: data.shippingCharge,
            discountAmount: data.discountAmount,
            status: "pending",
            customerId,
            inventoryAction: reservationEntries.length > 0 ? "reserved" : "none",
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
    );

    // Order items
    if (data.items.length > 0) {
        writeBatch.push(
            db.insert(orderItems).values(
                data.items.map((item) => ({
                    id: generateOrderId(),
                    orderId,
                    productId: item.productId,
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: item.price,
                    createdAt: sql`unixepoch()`,
                })),
            ),
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    try {
        await db.batch(writeBatch as any);
    } catch (batchError) {
        // DB write failed -- release any reservations we made
        if (reservationEntries.length > 0) {
            await releaseMultiple(db, reservationEntries, orderId);
        }
        throw batchError;
    }

    // ── Convert reservations to permanent deductions ────────────────────
    // Admin orders are immediately active, so we deduct right away.
    // This decrements `stock` and clears `reservedStock` for each variant.
    if (reservationEntries.length > 0) {
        const deductResult = await deductMultiple(db, reservationEntries, orderId);
        if (deductResult.success) {
            await db.update(orders)
                .set({ inventoryAction: "deducted", updatedAt: sql`unixepoch()` })
                .where(eq(orders.id, orderId));
        } else {
            // Deduction failed -- log but don't fail the order.
            // Stock is still reserved, so no overselling risk.
            console.error(
                `[orders.admin] Failed to deduct stock for order ${orderId}: ${deductResult.error}. Stock remains reserved.`,
            );
        }
    }

    return { id: orderId };
}

interface UpdateOrderItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
}

interface UpdateOrderData {
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    shippingAddress: string;
    city: string;
    zone: string;
    area: string | null;
    cityName?: string;
    zoneName?: string;
    areaName?: string;
    notes: string | null;
    items: UpdateOrderItem[];
    shippingCharge: number;
    discountAmount: number;
    status: string;
}

export async function updateOrder(db: Database, id: string, data: UpdateOrderData): Promise<{ id: string }> {
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
            version: orders.version,
        })
        .from(orders)
        .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
        .get();

    if (!existingOrder) throw new NotFoundError("Order not found");

    // Validate status transition if status is changing
    if (data.status !== existingOrder.status) {
        validateTransition("order", existingOrder.status, data.status);
    }

    const existingItems = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
    const pool = (existingOrder.inventoryPool as "regular" | "preorder" | "backorder") ?? "regular";

    const totalAmount = subtractPrice(
        addPrices(...data.items.map(item => roundPrice(item.price * item.quantity)), data.shippingCharge),
        data.discountAmount || 0,
    );
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
            if (newCustomer) customerId = newCustomer.id;
        }
    }

    // ── CAS check FIRST — before any inventory mutations ────────────────
    // Optimistic locking: only update if the version hasn't changed since we read it.
    // We write the order row before touching inventory so that a concurrent edit
    // is detected before any irreversible stock changes are made.
    // inventoryAction is updated after inventory ops below via a second UPDATE.
    const updateResult = await db.update(orders).set({
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
        customerId,
        version: existingOrder.version + 1,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(orders.id, id), eq(orders.version, existingOrder.version))).returning();

    if (updateResult.length === 0) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }
    const order = updateResult[0];
    if (!order) {
        throw new ConflictError("Order update failed unexpectedly.");
    }

    // ── Replace order items ─────────────────────────────────────────────
    await db.delete(orderItems).where(eq(orderItems.orderId, id));

    if (data.items.length > 0) {
        await db.insert(orderItems).values(data.items.map((item) => ({
            id: "item_" + nanoid(),
            orderId: order.id,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.price,
            createdAt: sql`unixepoch()`,
        })));
    }

    // ── Inventory adjustments AFTER CAS success ─────────────────────────
    // Now safe to mutate stock — we own this version of the order.
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
                throw new ValidationError(reserveResult.error ?? "Insufficient stock for updated items");
            }
        }
    } else if (existingOrder.inventoryAction === "deducted") {
        for (const existingItem of existingItems) {
            if (existingItem.variantId) {
                const matchingNewItem = data.items.find(
                    (item) => item.variantId === existingItem.variantId && item.quantity === existingItem.quantity
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
                    if (!variant) throw new NotFoundError(`Variant ${item.variantId} not found`);
                    if (variant.stock < quantityDiff) {
                        throw new ValidationError(`Insufficient stock for variant ${item.variantId}. Available: ${variant.stock}, Additional Requested: ${quantityDiff}`);
                    }
                    await db.update(productVariants)
                        .set({ stock: variant.stock - quantityDiff, updatedAt: sql`unixepoch()` })
                        .where(eq(productVariants.id, item.variantId));
                }
            }
        }
    }

    // ── Status-driven inventory transitions ─────────────────────────────
    if (data.status !== existingOrder.status) {
        const newInventoryAction = await applyInventoryForStatusChange(db, id, data.status);
        await db.update(orders)
            .set({ inventoryAction: newInventoryAction })
            .where(eq(orders.id, id));
    }

    if (existingOrder.customerId) {
        await updateCustomerStatsService(db, existingOrder.customerId);
    }
    if (customerId && customerId !== existingOrder.customerId) {
        await updateCustomerStatsService(db, customerId);
    }

    return { id: order.id };
}

async function updateCustomerStatsService(db: Database, customerId: string) {
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

export async function deleteOrder(db: Database, id: string) {
    const orderToDelete = await db.select({ id: orders.id, inventoryAction: orders.inventoryAction }).from(orders).where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`).get();
    if (!orderToDelete) throw new NotFoundError("Order not found");
    if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.update(orders).set({ deletedAt: sql`unixepoch()`, inventoryAction: "restored" }).where(eq(orders.id, id));
}

export async function restoreOrder(db: Database, id: string) {
    // Load the order to check its current inventory state
    const order = await db
        .select({
            id: orders.id,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            deletedAt: orders.deletedAt,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    if (!order.deletedAt) throw new ValidationError("Order is not deleted");

    // If inventory was released during deletion (inventoryAction = "restored"),
    // we must re-reserve stock before restoring the order.
    if (order.inventoryAction === "restored") {
        const items = await db
            .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
            .from(orderItems)
            .where(eq(orderItems.orderId, id));

        const pool = (order.inventoryPool as "regular" | "preorder" | "backorder") ?? "regular";
        const entries: ReservationEntry[] = items
            .filter((i): i is typeof i & { variantId: string } => i.variantId !== null)
            .map((i) => ({
                variantId: i.variantId,
                quantity: i.quantity,
                pool,
            }));

        if (entries.length > 0) {
            const reserveResult = await reserveMultiple(db, entries, id);
            if (!reserveResult.success) {
                throw new ValidationError(
                    `Cannot restore order: ${reserveResult.error ?? "insufficient stock to re-reserve inventory"}`,
                );
            }
        }

        await db.update(orders)
            .set({ deletedAt: null, inventoryAction: "reserved", updatedAt: sql`unixepoch()` })
            .where(eq(orders.id, id));
    } else {
        await db.update(orders)
            .set({ deletedAt: null, updatedAt: sql`unixepoch()` })
            .where(eq(orders.id, id));
    }
}

export async function permanentlyDeleteOrder(db: Database, id: string) {
    const orderToDelete = await db.select({ inventoryAction: orders.inventoryAction }).from(orders).where(eq(orders.id, id)).get();
    if (orderToDelete && (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted")) {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.delete(orderItems).where(eq(orderItems.orderId, id));
    await db.delete(orders).where(eq(orders.id, id));
}

export async function bulkDeleteOrders(db: Database, orderIds: string[], permanent: boolean = false) {
    for (const orderId of orderIds) {
        const order = await db.select({ id: orders.id, inventoryAction: orders.inventoryAction }).from(orders).where(eq(orders.id, orderId)).get();
        if (!order) continue;
        if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
            await applyInventoryForStatusChange(db, orderId, "cancelled");
        }
    }

    if (permanent) {
        await db.delete(orderItems).where(sql`${orderItems.orderId} IN ${orderIds}`);
        await db.delete(orders).where(sql`${orders.id} IN ${orderIds}`);
    } else {
        await db.update(orders)
            .set({ deletedAt: sql`unixepoch()`, inventoryAction: "restored" })
            .where(sql`${orders.id} IN ${orderIds}`);
    }
}
