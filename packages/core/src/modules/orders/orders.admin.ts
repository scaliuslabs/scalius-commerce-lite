// src/modules/orders/orders.admin.ts
// Admin order service: queries and CRUD mutations.

import { safeBatch, type Database } from "@scalius/database/client";
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
    OrderStatus,
    PaymentStatus,
    ItemFulfillmentStatus,
} from "@scalius/database/schema";
import {
    applyInventoryForStatusChange,
    isStockDeductStatus,
    isStockReservableStatus,
    isStockRestoreStatus,
} from "../inventory/inventory-transitions";
import {
    reserveStockBatch,
    deductMultiple,
    releaseMultiple,
    restoreDeductedMultiple,
    validateStockBatchAvailability,
} from "../inventory";
import type { ReservationEntry } from "../inventory";

import { sql, desc, eq, inArray, isNotNull, and, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ftsMatch, sanitizeFtsQuery } from "../../search/fts5";
import { generateOrderId } from "@scalius/shared/order-utils";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
import { unixToDate } from "@scalius/shared/utils";
import { nanoid } from "nanoid";
import type { CreateOrderInput } from "./orders.validation";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { validateTransition } from "./order-state-machine";
import type { OrderShipmentSummary, OrderDetails } from "./orders.types";
import { buildPhoneSearchTerms, isLikelyPhoneSearch } from "./orders.search";
import { assertNoActiveShipmentClaim, hasActiveShipmentClaim } from "./shipment-claim";
import { computeOrderPaymentState } from "../payments/payment-state";
import {
    assertNoActiveRefundAttempt,
    assertNoActiveRefundAttemptsForOrders,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    listOrderRefundAttempts,
    summarizeActiveRefundOperation,
} from "../payments/refund-attempt-visibility";
import { resolveActiveDeliveryLocationNames } from "./delivery-location-validation";
import { listOrderSupportRequests } from "./order-support-requests";

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

const TRASH_RESTORE_DEDUCTED_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.COMPLETED,
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
]);
type SQLiteBatchItem = BatchItem<"sqlite">;
const MAX_ORDER_LIST_LIMIT = 100;
type OrderListSort = "relevance" | "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
type AdminOrderSkuItem = { productId: string; variantId: string | null };
type AdminOrderItemWithInventory<T extends AdminOrderSkuItem> = T & {
    variantId: string;
    inventoryTracked: boolean;
};
type AdminOrderSkuIssueCode =
    | "SKU_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "PRODUCT_UNAVAILABLE";

interface AdminOrderSkuIssue {
    index: number;
    productId: string;
    variantId: string | null;
    code: AdminOrderSkuIssueCode;
    message: string;
}

function throwAdminOrderSkuIssues(issues: AdminOrderSkuIssue[]): never {
    throw new ValidationError("Some manual order items need attention.", { itemIssues: issues });
}

function addAdminOrderSkuIssue(
    issues: AdminOrderSkuIssue[],
    item: AdminOrderSkuItem,
    index: number,
    code: AdminOrderSkuIssueCode,
    message: string,
) {
    issues.push({
        index,
        productId: item.productId,
        variantId: item.variantId ?? null,
        code,
        message,
    });
}

function orderEditReadyCondition(orderId: string, expectedVersion: number) {
    return sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId}
          AND ${orders.version} = ${expectedVersion}
          AND ${orders.deletedAt} IS NULL
          AND ${noActiveRefundAttemptForOrderIdCondition(orderId)}
    )`;
}

function orderEditCommittedCondition(orderId: string, committedVersion: number) {
    return sql`changes() = 1
        AND EXISTS (
            SELECT 1 FROM ${orders}
            WHERE ${orders.id} = ${orderId}
              AND ${orders.version} = ${committedVersion}
              AND ${orders.deletedAt} IS NULL
        )`;
}

function buildGuardedCustomerInsert(
    db: Database,
    orderId: string,
    customerId: string,
    data: UpdateOrderData,
    totalAmount: number,
    expectedOrderVersion: number,
): SQLiteBatchItem {
    return db.insert(customers).select(sql`
        SELECT
            ${customerId},
            ${data.customerName},
            ${data.customerEmail},
            ${data.customerPhone},
            ${data.shippingAddress},
            ${data.city},
            ${data.zone},
            ${data.area},
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            1,
            ${totalAmount},
            unixepoch(),
            unixepoch(),
            unixepoch(),
            NULL
        WHERE ${orderEditReadyCondition(orderId, expectedOrderVersion)}
    `);
}

function buildGuardedOrderItemInsert(
    db: Database,
    orderId: string,
    committedOrderVersion: number,
    item: AdminOrderItemWithInventory<UpdateOrderData["items"][number]>,
): SQLiteBatchItem {
    const itemId = "item_" + nanoid();
    return db.insert(orderItems).select(sql`
        SELECT
            ${itemId},
            ${orderId},
            ${item.productId},
            ${item.variantId},
            ${item.quantity},
            ${item.price},
            NULL,
            NULL,
            ${item.inventoryTracked ? 1 : 0},
            ${ItemFulfillmentStatus.PENDING},
            unixepoch()
        WHERE ${orderEditCommittedCondition(orderId, committedOrderVersion)}
    `);
}

function buildGuardedOrderItemsDelete(
    db: Database,
    orderId: string,
    committedOrderVersion: number,
    existingItems: Array<{ id: string }>,
): SQLiteBatchItem | null {
    const itemIds = existingItems.map((item) => item.id).filter(Boolean);
    if (itemIds.length === 0) return null;

    return db.delete(orderItems).where(and(
        eq(orderItems.orderId, orderId),
        inArray(orderItems.id, itemIds),
        orderEditCommittedCondition(orderId, committedOrderVersion),
    ));
}

function assertAdminOrderItemsUseSkus(items: AdminOrderSkuItem[]) {
    const issues: AdminOrderSkuIssue[] = [];
    items.forEach((item, index) => {
        if (!item.variantId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "SKU_REQUIRED",
                "Select a product SKU before saving the order.",
            );
        }
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }
}

export async function resolveAdminOrderItemInventory<T extends AdminOrderSkuItem>(
    db: Database,
    items: T[],
): Promise<Array<AdminOrderItemWithInventory<T>>> {
    assertAdminOrderItemsUseSkus(items);

    const variantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id)))];
    if (variantIds.length === 0) return [];

    const rows = await db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            trackInventory: productVariants.trackInventory,
            variantDeletedAt: productVariants.deletedAt,
            productActive: products.isActive,
            productDeletedAt: products.deletedAt,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, variantIds));

    const skuByVariantId = new Map(rows.map((row) => [row.id, row]));
    const issues: AdminOrderSkuIssue[] = [];
    const resolvedItems: Array<AdminOrderItemWithInventory<T>> = [];

    items.forEach((item, index) => {
        const variantId = item.variantId!;
        const sku = skuByVariantId.get(variantId);
        if (!sku) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU is no longer available.",
            );
            return;
        }
        if (sku.productId !== item.productId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_MISMATCH",
                "Selected SKU does not belong to this product.",
            );
            return;
        }
        if (sku.variantDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU has been deleted.",
            );
            return;
        }
        if (!sku.productActive || sku.productDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "PRODUCT_UNAVAILABLE",
                "Selected product is not active.",
            );
            return;
        }

        resolvedItems.push({
            ...item,
            variantId,
            inventoryTracked: sku.trackInventory,
        });
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }

    return resolvedItems;
}

function normalizeListPositiveInteger(value: number | undefined, fallback: number, max?: number): number {
    if (!Number.isFinite(value)) return fallback;
    const integer = Math.trunc(value as number);
    const minBounded = Math.max(1, integer);
    return max == null ? minBounded : Math.min(minBounded, max);
}

function assertTrashRestoreInventoryActionAllowed(status: string, inventoryAction: string): void {
    if (inventoryAction === "reserved" && isStockReservableStatus(status)) return;
    if (inventoryAction === "deducted" && TRASH_RESTORE_DEDUCTED_STATUSES.has(status)) return;
    if (inventoryAction === "restored" && isStockRestoreStatus(status)) return;
    if (inventoryAction === "none") return;

    throw new ValidationError(
        `Cannot restore order with status "${status}" and inventory action "${inventoryAction}". Reconcile inventory or move the order to a compatible status first.`,
    );
}

function buildPhoneSearchCondition(searchTerms: string[]): SQL | undefined {
    if (searchTerms.length === 0) return undefined;

    const normalizedCustomerPhone = sql<string>`
        replace(
            replace(
                replace(
                    replace(
                        replace(
                            replace(${orders.customerPhone}, '+', ''),
                        ' ', ''),
                    '-', ''),
                '(', ''),
            ')', ''),
        '.', '')
    `;

    return sql`(${sql.join(
        searchTerms.map((term) => sql`${normalizedCustomerPhone} LIKE ${`%${term}%`}`),
        sql` OR `,
    )})`;
}

/**
 * Returns a paginated, searchable list of orders for the admin dashboard.
 * Includes item counts and the latest shipment per order.
 */
export async function listOrders(db: Database, options: {
    search?: string;
    status?: string;
    paymentStatus?: string;
    paymentMethod?: string;
    fulfillmentStatus?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?: OrderListSort;
    order?: "asc" | "desc";
    startDate?: Date;
    endDate?: Date;
}) {
    const {
        search,
        status,
        paymentStatus,
        paymentMethod,
        fulfillmentStatus,
        page: rawPage = 1,
        limit: rawLimit = 10,
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const page = normalizeListPositiveInteger(rawPage, 1);
    const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT);
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [];

    if (showTrashed) {
        whereConditions.push(sql`${orders.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${orders.deletedAt} IS NULL`);
    }

    let rankExpression: SQL | undefined = undefined;
    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
        const phoneSearchTerms = buildPhoneSearchTerms(trimmedSearch);
        const phoneCondition = buildPhoneSearchCondition(phoneSearchTerms);
        const ftsCondition = ftsMatch("orders_fts", "orders", trimmedSearch);

        if (isLikelyPhoneSearch(trimmedSearch) && phoneCondition) {
            whereConditions.push(ftsCondition ? sql`(${ftsCondition} OR ${phoneCondition})` : phoneCondition);
            const sanitized = sanitizeFtsQuery(trimmedSearch);
            rankExpression = sql`
                COALESCE(
                    (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}),
                    999999
                ) ASC
            `;
        } else if (ftsCondition) {
            whereConditions.push(ftsCondition);
            const sanitized = sanitizeFtsQuery(trimmedSearch);
            rankExpression = sql`
                COALESCE(
                    (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}),
                    999999
                ) ASC
            `;
        }
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (paymentStatus) {
        whereConditions.push(sql`${orders.paymentStatus} = ${paymentStatus}`);
    }

    if (paymentMethod) {
        whereConditions.push(sql`${orders.paymentMethod} = ${paymentMethod}`);
    }

    if (fulfillmentStatus) {
        whereConditions.push(sql`${orders.fulfillmentStatus} = ${fulfillmentStatus}`);
    }

    if (startDate) {
        const startTs = Math.floor(startDate.getTime() / 1000);
        whereConditions.push(sql`${orders.createdAt} >= ${startTs}`);
    }

    if (endDate) {
        const endTs = Math.floor(endDate.getTime() / 1000);
        whereConditions.push(sql`${orders.createdAt} <= ${endTs}`);
    }

    const whereClause = whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined;

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(whereClause);

    const orderByExpressions = (() => {
        if (rankExpression && sort === "relevance") {
            return [
                rankExpression,
                sql`${orders.updatedAt} desc`,
                sql`${orders.id} desc`,
            ];
        }

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
                case "relevance":
                case "updatedAt":
                default:
                    return orders.updatedAt;
            }
        })();

        return [
            order === "asc" ? sql`${sortField} asc` : sql`${sortField} desc`,
            order === "asc" ? sql`${orders.id} asc` : sql`${orders.id} desc`,
        ];
    })();

    const dataQuery = db
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
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(...orderByExpressions);

    // Batch count + data in a single round-trip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const batchResult = await db.batch([countQuery, dataQuery] as any) as any;
    const countArr = batchResult[0] as { count: number }[];
    const results = batchResult[1] as {
        id: string; customerName: string; customerPhone: string; customerEmail: string | null;
        customerId: string | null; totalAmount: number; shippingCharge: number; discountAmount: number;
        status: string; paymentStatus: string; paymentMethod: string | null; fulfillmentStatus: string;
        createdAt: number; updatedAt: number;
        city: string | null; zone: string | null; area: string | null;
        cityName: string | null; zoneName: string | null; areaName: string | null;
    }[];
    const count = countArr[0]?.count ?? 0;

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

    const [items, refundAttemptViews, supportRequests] = await Promise.all([
        db
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
                fulfillmentStatus: orderItems.fulfillmentStatus,
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
            .where(eq(orderItems.orderId, id)),
        listOrderRefundAttempts(db, id, { audience: "admin" }),
        listOrderSupportRequests(db, id),
    ]);

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
        fulfillmentStatus: item.fulfillmentStatus,
    }));

    return {
        ...order,
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        items: formattedItems,
        latestShipment: null,
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        supportRequests,
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
    const initialPaymentState = computeOrderPaymentState({
        totalAmount,
        paidAmount: 0,
    });

    const { cityName, zoneName, areaName } = await resolveActiveDeliveryLocationNames(db, data);

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
    const trackedItems = await resolveAdminOrderItemInventory(db, data.items);
    const reservationEntries: ReservationEntry[] = trackedItems
        .filter((item) => item.inventoryTracked)
        .map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            pool: "regular" as const,
        }));

    if (reservationEntries.length > 0) {
        const batchItems = reservationEntries.map(e => ({
            variantId: e.variantId,
            quantity: e.quantity,
            orderId,
        }));
        const reserveResult = await reserveStockBatch(db, batchItems, "regular");
        if (!reserveResult.success) {
            throw new ValidationError(
                reserveResult.error ?? "Insufficient stock for one or more items",
            );
        }
    }

    // ── Atomic batch: customer + order + items ──────────────────────────
    // D1 batch() executes all statements in a single atomic operation.
    // If any statement fails, none are committed.
    const writeBatch: SQLiteBatchItem[] = [];

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
            paidAmount: initialPaymentState.paidAmount,
            balanceDue: initialPaymentState.balanceDue,
            paymentStatus: initialPaymentState.paymentStatus,
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
                trackedItems.map((item) => ({
                    id: generateOrderId(),
                    orderId,
                    productId: item.productId,
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: item.price,
                    inventoryTracked: item.inventoryTracked,
                    createdAt: sql`unixepoch()`,
                })),
            ),
        );
    }

    try {
        await safeBatch(db, writeBatch);
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
    inventoryTracked?: boolean;
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

function buildInventoryEntries(
    items: { variantId: string | null; quantity: number; inventoryTracked?: boolean }[],
    pool: NonNullable<ReservationEntry["pool"]>,
): ReservationEntry[] {
    const merged = new Map<string, number>();
    for (const item of items) {
        if (!item.variantId || item.inventoryTracked === false) continue;
        merged.set(item.variantId, (merged.get(item.variantId) ?? 0) + item.quantity);
    }
    return Array.from(merged.entries()).map(([variantId, quantity]) => ({ variantId, quantity, pool }));
}

function computeInventoryDeltas(
    oldEntries: ReservationEntry[],
    newEntries: ReservationEntry[],
    pool: NonNullable<ReservationEntry["pool"]>,
): { positiveEntries: ReservationEntry[]; negativeEntries: ReservationEntry[] } {
    const deltaMap = new Map<string, number>();
    for (const entry of oldEntries) {
        deltaMap.set(entry.variantId, (deltaMap.get(entry.variantId) ?? 0) - entry.quantity);
    }
    for (const entry of newEntries) {
        deltaMap.set(entry.variantId, (deltaMap.get(entry.variantId) ?? 0) + entry.quantity);
    }

    const positiveEntries: ReservationEntry[] = [];
    const negativeEntries: ReservationEntry[] = [];
    for (const [variantId, delta] of deltaMap) {
        if (delta > 0) {
            positiveEntries.push({ variantId, quantity: delta, pool });
        } else if (delta < 0) {
            negativeEntries.push({ variantId, quantity: Math.abs(delta), pool });
        }
    }

    return { positiveEntries, negativeEntries };
}

function toReservationBatchItems(entries: ReservationEntry[], orderId: string) {
    return entries.map((entry) => ({
        variantId: entry.variantId,
        quantity: entry.quantity,
        orderId,
    }));
}

type InventoryBatchResult = {
    success: boolean;
    results: { success: boolean }[];
    error?: string;
};

function successfulEntries(entries: ReservationEntry[], result: InventoryBatchResult): ReservationEntry[] {
    return entries.filter((_, index) => result.results[index]?.success);
}

function groupEntriesByPool(entries: ReservationEntry[]) {
    const groups = new Map<NonNullable<ReservationEntry["pool"]>, ReservationEntry[]>();
    for (const entry of entries) {
        const pool = entry.pool ?? "regular";
        const group = groups.get(pool) ?? [];
        group.push({ ...entry, pool });
        groups.set(pool, group);
    }
    return groups;
}

async function reserveEntriesForCompensation(
    db: Database,
    orderId: string,
    entries: ReservationEntry[],
): Promise<{ success: boolean; error?: string }> {
    const reserved: ReservationEntry[] = [];
    for (const [pool, group] of groupEntriesByPool(entries)) {
        const result = await reserveStockBatch(db, toReservationBatchItems(group, orderId), pool);
        if (!result.success) {
            if (reserved.length > 0) {
                await releaseMultiple(db, reserved, orderId);
            }
            return { success: false, error: result.error };
        }
        reserved.push(...group);
    }
    return { success: true };
}

async function redeductRestoredEntriesForCompensation(
    db: Database,
    orderId: string,
    entries: ReservationEntry[],
): Promise<{ success: boolean; error?: string }> {
    const preorderEntries = entries.filter((entry) => (entry.pool ?? "regular") === "preorder");
    const directEntries = entries.filter((entry) => (entry.pool ?? "regular") === "regular");

    if (preorderEntries.length > 0) {
        const reserveResult = await reserveEntriesForCompensation(db, orderId, preorderEntries);
        if (!reserveResult.success) {
            return reserveResult;
        }
        const deductResult = await deductMultiple(db, preorderEntries, orderId);
        if (!deductResult.success) {
            await releaseMultiple(db, preorderEntries, orderId);
            return { success: false, error: deductResult.error };
        }
    }

    if (directEntries.length > 0) {
        const deductResult = await deductMultiple(db, directEntries, orderId);
        if (!deductResult.success) {
            return { success: false, error: deductResult.error };
        }
    }

    return { success: true };
}

async function releaseReservationsForOrderEdit(
    db: Database,
    orderId: string,
    entries: ReservationEntry[],
    errorMessage: string,
): Promise<void> {
    if (entries.length === 0) return;
    const result = await releaseMultiple(db, entries, orderId);
    if (!result.success) {
        const releasedEntries = successfulEntries(entries, result);
        if (releasedEntries.length > 0) {
            const compensation = await reserveEntriesForCompensation(db, orderId, releasedEntries);
            if (!compensation.success) {
                console.error(
                    `[orders.admin] Failed to compensate released reservations for order ${orderId}: ${compensation.error}`,
                );
            }
        }
        throw new ValidationError(result.error ?? errorMessage);
    }
}

async function restoreDeductedForOrderEdit(
    db: Database,
    orderId: string,
    entries: ReservationEntry[],
    errorMessage: string,
): Promise<void> {
    if (entries.length === 0) return;
    const result = await restoreDeductedMultiple(db, entries, orderId);
    if (!result.success) {
        const restoredEntries = successfulEntries(entries, result);
        if (restoredEntries.length > 0) {
            const compensation = await redeductRestoredEntriesForCompensation(db, orderId, restoredEntries);
            if (!compensation.success) {
                console.error(
                    `[orders.admin] Failed to compensate restored deducted stock for order ${orderId}: ${compensation.error}`,
                );
            }
        }
        throw new ValidationError(result.error ?? errorMessage);
    }
}

async function compensatePreWriteInventory(
    db: Database,
    orderId: string,
    acquiredReservations: ReservationEntry[],
    deductedEntries: ReservationEntry[],
    releasedReservations: ReservationEntry[],
    restoredDeductedEntries: ReservationEntry[],
) {
    if (restoredDeductedEntries.length > 0) {
        const redeductResult = await redeductRestoredEntriesForCompensation(db, orderId, restoredDeductedEntries);
        if (!redeductResult.success) {
            console.error(`[orders.admin] Failed to compensate restored deducted stock for order ${orderId}: ${redeductResult.error}`);
        }
    }
    if (releasedReservations.length > 0) {
        const reserveResult = await reserveEntriesForCompensation(db, orderId, releasedReservations);
        if (!reserveResult.success) {
            console.error(`[orders.admin] Failed to compensate released reservations for order ${orderId}: ${reserveResult.error}`);
        }
    }
    if (deductedEntries.length > 0) {
        const restoreResult = await restoreDeductedMultiple(db, deductedEntries, orderId);
        if (!restoreResult.success) {
            console.error(`[orders.admin] Failed to compensate deducted stock for order ${orderId}: ${restoreResult.error}`);
        }
    }
    if (acquiredReservations.length > 0) {
        const releaseResult = await releaseMultiple(db, acquiredReservations, orderId);
        if (!releaseResult.success) {
            console.error(`[orders.admin] Failed to compensate reserved stock for order ${orderId}: ${releaseResult.error}`);
        }
    }
}

export async function updateOrder(db: Database, id: string, data: UpdateOrderData): Promise<{ id: string }> {
    const { cityName, zoneName, areaName } = await resolveActiveDeliveryLocationNames(db, data);

    const existingOrder = await db
        .select({
            id: orders.id,
            customerId: orders.customerId,
            customerPhone: orders.customerPhone,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            paidAmount: orders.paidAmount,
            paymentStatus: orders.paymentStatus,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
        .get();

    if (!existingOrder) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(existingOrder);
    await assertNoActiveRefundAttempt(db, id);

    // Validate status transition if status is changing
    if (data.status !== existingOrder.status) {
        validateTransition("order", existingOrder.status, data.status);
    }

    const existingItems = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
    const trackedNewItems = await resolveAdminOrderItemInventory(db, data.items);
    const pool = (existingOrder.inventoryPool as "regular" | "preorder" | "backorder") ?? "regular";
    const existingInventoryAction = existingOrder.inventoryAction as string;
    const targetRestoresStock = isStockRestoreStatus(data.status);
    const targetDeductsStock = isStockDeductStatus(data.status);
    const oldEntries = buildInventoryEntries(existingItems, pool);
    const newEntries = buildInventoryEntries(trackedNewItems, pool);
    const { positiveEntries, negativeEntries } = computeInventoryDeltas(oldEntries, newEntries, pool);

    const totalAmount = subtractPrice(
        addPrices(...data.items.map(item => roundPrice(item.price * item.quantity)), data.shippingCharge),
        data.discountAmount || 0,
    );
    const nextPaymentState = computeOrderPaymentState({
        totalAmount,
        paidAmount: existingOrder.paidAmount,
        paymentStatus: existingOrder.paymentStatus === PaymentStatus.REFUNDED
            ? PaymentStatus.REFUNDED
            : existingOrder.paymentStatus === PaymentStatus.FAILED
                ? PaymentStatus.FAILED
                : undefined,
    });
    let customerId = existingOrder.customerId;
    let newCustomerId: string | null = null;
    let acquiredReservations: ReservationEntry[] = [];
    let deductedEntries: ReservationEntry[] = [];
    let releasedReservations: ReservationEntry[] = [];
    let restoredDeductedEntries: ReservationEntry[] = [];
    let inventoryActionOverride: string | null = null;
    let statusTransitionHandled = false;
    let writesCommitted = false;

    try {
        if (existingInventoryAction === "reserved" && !targetRestoresStock && positiveEntries.length > 0) {
            const availability = await validateStockBatchAvailability(db, toReservationBatchItems(positiveEntries, id), pool);
            if (!availability.success) {
                throw new ValidationError(availability.error ?? "Insufficient stock for updated items");
            }

            const reserveResult = await reserveStockBatch(db, toReservationBatchItems(positiveEntries, id), pool);
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock for updated items");
            }
            acquiredReservations = positiveEntries;
        }

        if (existingInventoryAction === "deducted" && !targetRestoresStock && positiveEntries.length > 0) {
            const reserveResult = await reserveStockBatch(db, toReservationBatchItems(positiveEntries, id), pool);
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock for updated items");
            }
            acquiredReservations = positiveEntries;

            const deductResult = await deductMultiple(db, positiveEntries, id);
            if (!deductResult.success) {
                await compensatePreWriteInventory(db, id, acquiredReservations, [], [], []);
                acquiredReservations = [];
                throw new ValidationError(deductResult.error ?? "Failed to deduct additional stock for updated items");
            }
            acquiredReservations = [];
            deductedEntries = positiveEntries;
        }

        if (existingInventoryAction === "restored" && !targetRestoresStock && !targetDeductsStock && newEntries.length > 0) {
            const reserveResult = await reserveStockBatch(db, toReservationBatchItems(newEntries, id), pool);
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock to reactivate order");
            }
            acquiredReservations = newEntries;
        }

        if (existingInventoryAction === "reserved") {
            if (targetRestoresStock) {
                await releaseReservationsForOrderEdit(
                    db,
                    id,
                    oldEntries,
                    "Failed to release order reservations",
                );
                releasedReservations = oldEntries;
                inventoryActionOverride = "restored";
                statusTransitionHandled = true;
            } else if (negativeEntries.length > 0) {
                await releaseReservationsForOrderEdit(
                    db,
                    id,
                    negativeEntries,
                    "Failed to release removed reservations",
                );
                releasedReservations = negativeEntries;
            }
        } else if (existingInventoryAction === "deducted") {
            if (targetRestoresStock) {
                await restoreDeductedForOrderEdit(
                    db,
                    id,
                    oldEntries,
                    "Failed to restore deducted stock",
                );
                restoredDeductedEntries = oldEntries;
                inventoryActionOverride = "restored";
                statusTransitionHandled = true;
            } else if (negativeEntries.length > 0) {
                await restoreDeductedForOrderEdit(
                    db,
                    id,
                    negativeEntries,
                    "Failed to restore removed deducted stock",
                );
                restoredDeductedEntries = negativeEntries;
            }
        } else if (existingInventoryAction === "restored" && !targetRestoresStock && !targetDeductsStock && newEntries.length > 0) {
            inventoryActionOverride = "reserved";
            statusTransitionHandled = true;
        }

        if (data.customerPhone !== existingOrder.customerPhone) {
            const customer = await db.select().from(customers).where(eq(customers.phone, data.customerPhone)).get();
            if (customer) {
                customerId = customer.id;
            } else {
                newCustomerId = "cust_" + nanoid();
                customerId = newCustomerId;
            }
        }

        const committedOrderVersion = existingOrder.version + 1;
        const atomicEditStatements: SQLiteBatchItem[] = [];
        if (newCustomerId) {
            atomicEditStatements.push(buildGuardedCustomerInsert(
                db,
                id,
                newCustomerId,
                data,
                totalAmount,
                existingOrder.version,
            ));
        }

        const orderUpdateResultIndex = atomicEditStatements.length;
        atomicEditStatements.push(
            db.update(orders).set({
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
                paidAmount: nextPaymentState.paidAmount,
                balanceDue: nextPaymentState.balanceDue,
                paymentStatus: nextPaymentState.paymentStatus,
                status: data.status,
                customerId,
                version: committedOrderVersion,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, id),
                eq(orders.version, existingOrder.version),
                noActiveRefundAttemptForOrderIdCondition(id),
            )).returning({ id: orders.id }),
        );

        for (const item of trackedNewItems) {
            atomicEditStatements.push(buildGuardedOrderItemInsert(db, id, committedOrderVersion, item));
        }

        const guardedOldItemsDelete = buildGuardedOrderItemsDelete(db, id, committedOrderVersion, existingItems);
        if (guardedOldItemsDelete) {
            atomicEditStatements.push(guardedOldItemsDelete);
        }

        const batchResults = await safeBatch(db, atomicEditStatements) as unknown[];
        const updateResult = batchResults[orderUpdateResultIndex] as Array<{ id: string }> | undefined;

        if ((updateResult?.length ?? 0) === 0) {
            throw new ConflictError("Order was modified by another request. Please reload and try again.");
        }
        writesCommitted = true;

        if (!statusTransitionHandled) {
            inventoryActionOverride = await applyInventoryForStatusChange(db, id, data.status);
        }

        if (inventoryActionOverride) {
            await db.update(orders)
                .set({ inventoryAction: inventoryActionOverride })
                .where(eq(orders.id, id));
        }

        if (existingOrder.customerId) {
            await updateCustomerStatsService(db, existingOrder.customerId);
        }
        if (customerId && customerId !== existingOrder.customerId) {
            await updateCustomerStatsService(db, customerId);
        }

        return { id };
    } catch (error) {
        if (!writesCommitted) {
            try {
                await compensatePreWriteInventory(
                    db,
                    id,
                    acquiredReservations,
                    deductedEntries,
                    releasedReservations,
                    restoredDeductedEntries,
                );
            } catch (compensationError) {
                console.error(`[orders.admin] Inventory compensation failed after order update error for ${id}:`, compensationError);
            }
        }
        throw error;
    }
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
    const orderToDelete = await db.select({
        id: orders.id,
        inventoryAction: orders.inventoryAction,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`).get();
    if (!orderToDelete) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(orderToDelete);
    await assertNoActiveRefundAttempt(db, id);
    if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.update(orders).set({ deletedAt: sql`unixepoch()`, inventoryAction: "restored", version: sql`${orders.version} + 1`, updatedAt: sql`unixepoch()` }).where(eq(orders.id, id));
}

export async function restoreOrder(db: Database, id: string) {
    // Load the order to check its current inventory state
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            deletedAt: orders.deletedAt,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    if (!order.deletedAt) throw new ValidationError("Order is not deleted");
    await assertNoActiveRefundAttempt(db, id);

    let nextInventoryAction = order.inventoryAction as "none" | "reserved" | "deducted" | "restored";
    let reservedEntries: ReservationEntry[] = [];

    if (order.inventoryAction === "restored") {
        if (isStockReservableStatus(order.status)) {
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
                const batchItems = entries.map(e => ({
                    variantId: e.variantId,
                    quantity: e.quantity,
                    orderId: id,
                }));
                const reserveResult = await reserveStockBatch(db, batchItems, pool);
                if (!reserveResult.success) {
                    throw new ValidationError(
                        `Cannot restore order: ${reserveResult.error ?? "insufficient stock to re-reserve inventory"}`,
                    );
                }
                reservedEntries = entries;
                nextInventoryAction = "reserved";
            } else {
                nextInventoryAction = "none";
            }
        } else {
            assertTrashRestoreInventoryActionAllowed(order.status, order.inventoryAction);
            nextInventoryAction = "restored";
        }
    } else {
        assertTrashRestoreInventoryActionAllowed(order.status, order.inventoryAction);
    }

    const restoreResult = await db.update(orders)
        .set({ deletedAt: null, inventoryAction: nextInventoryAction, version: sql`${orders.version} + 1`, updatedAt: sql`unixepoch()` })
        .where(and(
            eq(orders.id, id),
            eq(orders.version, order.version),
            isNotNull(orders.deletedAt),
            noActiveRefundAttemptForOrderIdCondition(id),
        ))
        .returning({ id: orders.id });

    if (restoreResult.length === 0) {
        if (reservedEntries.length > 0) {
            const releaseResult = await releaseMultiple(db, reservedEntries, id);
            if (!releaseResult.success) {
                console.error(`[orders.admin] Failed to compensate restore reservation for ${id}:`, releaseResult.error);
            }
        }
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }
}

export async function permanentlyDeleteOrder(db: Database, id: string) {
    const orderToDelete = await db.select({
        inventoryAction: orders.inventoryAction,
        deletedAt: orders.deletedAt,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, id)).get();
    if (!orderToDelete) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(orderToDelete);
    await assertNoActiveRefundAttempt(db, id);
    if (!orderToDelete.deletedAt) throw new ValidationError("Order must be soft-deleted before permanent deletion");
    if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.delete(orderItems).where(eq(orderItems.orderId, id));
    await db.delete(orders).where(eq(orders.id, id));
}

export async function bulkDeleteOrders(db: Database, orderIds: string[], permanent: boolean = false) {
    if (orderIds.length === 0) return;

    // Batch-read ALL affected orders in ONE query (Fix N+1)
    const affectedOrders = await db
        .select({
            id: orders.id,
            inventoryAction: orders.inventoryAction,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(inArray(orders.id, orderIds));

    const claimedOrders = affectedOrders.filter((order) => hasActiveShipmentClaim(order));
    if (claimedOrders.length > 0) {
        throw new ConflictError(`Orders have active shipment creation in progress: ${claimedOrders.map((order) => order.id).join(", ")}`);
    }
    await assertNoActiveRefundAttemptsForOrders(db, affectedOrders.map((order) => order.id));

    // Apply inventory transitions for orders that need it
    // (applyInventoryForStatusChange reads order items internally and uses CAS operations)
    for (const order of affectedOrders) {
        if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
            await applyInventoryForStatusChange(db, order.id, "cancelled");
        }
    }

    // Batch the final delete/soft-delete statements atomically (Fix atomicity)
    if (permanent) {
        const deleteStmts: SQLiteBatchItem[] = [
            db.delete(orderItems).where(inArray(orderItems.orderId, orderIds)),
            db.delete(orders).where(inArray(orders.id, orderIds)),
        ];
        await safeBatch(db, deleteStmts);
    } else {
        await db.update(orders)
            .set({
                deletedAt: sql`unixepoch()`,
                inventoryAction: "restored",
                version: sql`${orders.version} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(inArray(orders.id, orderIds));
    }
}
