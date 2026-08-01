// src/modules/customers/customers.service.ts
// All DB queries and business logic for the customers domain.

import {
    codTracking,
    customers,
    customerHistory,
    customerSessions,
    deliveryLocations,
    deliveryProviders,
    deliveryShipments,
    orderItems,
    orderNotificationDeliveryReceipts,
    orderPayments,
    orders,
    OrderStatus,
    paymentPlans,
    PaymentStatus,
    media,
    products,
} from "@scalius/database/schema";
import { sql, isNull, inArray, asc, desc, eq, and, or, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { addPrices, roundPrice } from "@scalius/shared/price-utils";
import { ftsMatch } from "../../search/fts5";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import {
    listOrderRefundAttempts,
    summarizeActiveRefundOperation,
} from "../payments/refund-attempt-visibility";
import {
    applyCustomerRequestPolicyToSupportActions,
    getActiveSupportRequestTypes,
    getCustomerOrderSupportRequestActions,
    listOrderSupportRequests,
    customerAccountOwnershipCondition,
} from "../orders/order-support-requests";
import {
    getCustomerRequestIntro,
    getCustomerRequestPolicy,
} from "../settings/customer-request-policy";
import { validateCustomerPhoneCountry } from "../settings/phone-country-policy";

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

type CustomerOrderListItem = {
    orderId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
    productName: string | null;
    productSlug: string | null;
    productImage: string | null;
    variantLabel: string | null;
};

function historicalOrderImageUrl(
    objectKey: string | null,
    status: string | null,
): string | null {
    return objectKey && (status === "ready" || status === "trashed")
        ? getCurrentPublicMediaUrl(objectKey)
        : null;
}

export interface CustomerOrderDetailTimelineEvent {
    id: string;
    type: "order" | "payment" | "refund" | "request" | "shipment" | "notification";
    status: string;
    label: string;
    happenedAt: string | null;
    details?: string | null;
}

export interface CustomerOrderNotificationReceiptRow {
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
}

export interface CustomerOrderNotificationReceipt {
    id: string;
    notificationType: string;
    channel: string;
    status: string;
    provider: string;
    providerStatus: string | null;
    acceptedAt: string | null;
    deliveredAt: string | null;
    failedAt: string | null;
    skippedAt: string | null;
    updatedAt: string | null;
    createdAt: string | null;
}

const normalizeStatusLabel = (status: string): string =>
    status
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");

const NOTIFICATION_CHANNEL_LABELS: Record<string, string> = {
    email: "Email",
    sms: "SMS",
    whatsapp: "WhatsApp",
};

const getNotificationChannelLabel = (channel: string): string =>
    NOTIFICATION_CHANNEL_LABELS[channel] ?? normalizeStatusLabel(channel);

const CUSTOMER_CLOSED_BALANCE_ORDER_STATUSES = [
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
    OrderStatus.RETURNED,
    OrderStatus.PARTIALLY_REFUNDED,
] as const;
const CUSTOMER_CLOSED_BALANCE_ORDER_STATUS_SET = new Set<string>(CUSTOMER_CLOSED_BALANCE_ORDER_STATUSES);

const CUSTOMER_CLOSED_BALANCE_PAYMENT_STATUSES = [
    PaymentStatus.FAILED,
    PaymentStatus.REFUNDED,
] as const;
const CUSTOMER_CLOSED_BALANCE_PAYMENT_STATUS_SET = new Set<string>(CUSTOMER_CLOSED_BALANCE_PAYMENT_STATUSES);

const CUSTOMER_COMPLETED_ORDER_STATUSES = [
    OrderStatus.DELIVERED,
    OrderStatus.COMPLETED,
] as const;
const CUSTOMER_COMPLETED_ORDER_STATUS_SET = new Set<string>(CUSTOMER_COMPLETED_ORDER_STATUSES);

const CUSTOMER_PENDING_ORDER_STATUSES = [
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
] as const;
const CUSTOMER_PENDING_ORDER_STATUS_SET = new Set<string>(CUSTOMER_PENDING_ORDER_STATUSES);

type CustomerOrderMoneyState = {
    status: string;
    paymentStatus: string;
    totalAmount: number | null | undefined;
    paidAmount: number | null | undefined;
    balanceDue?: number | null | undefined;
};

export type CustomerAccountOrderSummary = {
    totalOrders: number;
    totalSpent: number;
    completedOrders: number;
    pendingOrders: number;
};

type CustomerOrdersCursor = {
    createdAt: number;
    id: string;
};

export type CustomerOrdersPageOptions = {
    cursor?: string;
    limit?: number;
};

const CUSTOMER_ORDERS_DEFAULT_LIMIT = 50;
const CUSTOMER_ORDERS_MAX_LIMIT = 50;
const CUSTOMER_ORDER_CURSOR_SEPARATOR = "~";

export function encodeCustomerOrdersCursor(order: { createdAt: number | null | undefined; id: string }): string | null {
    if (!order.createdAt || !Number.isFinite(Number(order.createdAt))) return null;
    return `${Math.floor(Number(order.createdAt))}${CUSTOMER_ORDER_CURSOR_SEPARATOR}${encodeURIComponent(order.id)}`;
}

export function decodeCustomerOrdersCursor(cursor: string | undefined): CustomerOrdersCursor | null {
    const trimmed = cursor?.trim();
    if (!trimmed) return null;

    const separatorIndex = trimmed.indexOf(CUSTOMER_ORDER_CURSOR_SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
        throw new ValidationError("Invalid order-history cursor.");
    }

    const createdAt = Number(trimmed.slice(0, separatorIndex));
    const encodedId = trimmed.slice(separatorIndex + 1);
    let id: string;
    try {
        id = decodeURIComponent(encodedId);
    } catch {
        throw new ValidationError("Invalid order-history cursor.");
    }

    if (!Number.isInteger(createdAt) || createdAt <= 0 || !id) {
        throw new ValidationError("Invalid order-history cursor.");
    }

    return { createdAt, id };
}

function normalizeCustomerOrdersLimit(limit: number | undefined): number {
    if (!Number.isFinite(Number(limit))) return CUSTOMER_ORDERS_DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(Number(limit)), 1), CUSTOMER_ORDERS_MAX_LIMIT);
}

export function getCustomerVisibleBalanceDue(order: CustomerOrderMoneyState): number {
    if (
        CUSTOMER_CLOSED_BALANCE_ORDER_STATUS_SET.has(order.status) ||
        CUSTOMER_CLOSED_BALANCE_PAYMENT_STATUS_SET.has(order.paymentStatus)
    ) {
        return 0;
    }

    const storedBalance = order.balanceDue === null || order.balanceDue === undefined
        ? Number.NaN
        : Number(order.balanceDue);
    if (Number.isFinite(storedBalance)) {
        return roundPrice(Math.max(0, storedBalance));
    }

    const totalAmount = roundPrice(Math.max(0, Number(order.totalAmount ?? 0)));
    const paidAmount = roundPrice(Math.max(0, Number(order.paidAmount ?? 0)));
    return roundPrice(Math.max(0, totalAmount - paidAmount));
}

export function getCustomerSpendContribution(order: CustomerOrderMoneyState): number {
    return roundPrice(Math.max(0, Number(order.paidAmount ?? 0)));
}

export function summarizeCustomerAccountOrders(rows: CustomerOrderMoneyState[]): CustomerAccountOrderSummary {
    return {
        totalOrders: rows.length,
        totalSpent: addPrices(...rows.map(getCustomerSpendContribution)),
        completedOrders: rows.filter((order) => CUSTOMER_COMPLETED_ORDER_STATUS_SET.has(order.status)).length,
        pendingOrders: rows.filter((order) => CUSTOMER_PENDING_ORDER_STATUS_SET.has(order.status)).length,
    };
}

export function buildCustomerOrderMetricsProjection() {
    return {
        totalOrders: sql<number>`CAST(count(${orders.id}) AS INTEGER)`,
        totalSpent: sql<number>`COALESCE(SUM(CASE WHEN ${orders.paidAmount} > 0 THEN ${orders.paidAmount} ELSE 0 END), 0)`,
        lastOrderAt: sql<number | null>`max(CAST(${orders.createdAt} AS INTEGER))`,
    };
}

export function customerAccountOrderVisibilityCondition(customerId: string): SQL {
    return and(
        customerAccountOwnershipCondition(customerId),
        isNull(orders.deletedAt),
    )!;
}

export function buildCustomerOrderBaseTimelineEvents(order: {
    id: string;
    status: string;
    createdAt: number | null;
    updatedAt: number | null;
}): CustomerOrderDetailTimelineEvent[] {
    const currentStatusLabel = normalizeStatusLabel(order.status);
    return [
        {
            id: `order-created:${order.id}`,
            type: "order",
            status: "placed",
            label: "Order placed",
            happenedAt: timestampToIso(order.createdAt),
            details: "We received your order.",
        },
        {
            id: `order-status:${order.id}:${order.status}`,
            type: "order",
            status: order.status,
            label: `Current status: ${currentStatusLabel}`,
            happenedAt: timestampToIso(order.updatedAt ?? order.createdAt),
            details: `Order is currently ${currentStatusLabel}.`,
        },
    ];
}

export function projectCustomerOrderNotifications(
    receipts: CustomerOrderNotificationReceiptRow[],
): CustomerOrderNotificationReceipt[] {
    return receipts.map((receipt) => ({
        ...receipt,
        acceptedAt: timestampToIso(receipt.acceptedAt),
        deliveredAt: timestampToIso(receipt.deliveredAt),
        failedAt: timestampToIso(receipt.failedAt),
        skippedAt: timestampToIso(receipt.skippedAt),
        updatedAt: timestampToIso(receipt.updatedAt),
        createdAt: timestampToIso(receipt.createdAt),
    }));
}

export function buildCustomerOrderNotificationTimelineEvents(
    notifications: CustomerOrderNotificationReceipt[],
): CustomerOrderDetailTimelineEvent[] {
    return notifications.map((notification) => ({
        id: `notification:${notification.id}`,
        type: "notification",
        status: notification.status,
        label: `${getNotificationChannelLabel(notification.channel)} notification ${normalizeStatusLabel(notification.status)}`,
        happenedAt:
            notification.deliveredAt ??
            notification.acceptedAt ??
            notification.failedAt ??
            notification.skippedAt ??
            notification.updatedAt ??
            notification.createdAt,
        details: normalizeStatusLabel(notification.notificationType),
    }));
}

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
        const ftsCondition = ftsMatch(db, "customers_fts", "customers", search);

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

    const metrics = buildCustomerOrderMetricsProjection();
    const sortField = (() => {
        switch (sort) {
            case "name": return customers.name;
            case "totalOrders": return metrics.totalOrders;
            case "totalSpent": return metrics.totalSpent;
            case "lastOrderAt": return metrics.lastOrderAt;
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
            accountClaimedAt: sql<number | null>`CAST(${customers.accountClaimedAt} AS INTEGER)`,
            totalOrders: metrics.totalOrders,
            totalSpent: metrics.totalSpent,
            lastOrderAt: metrics.lastOrderAt,
            createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
        })
        .from(customers)
        .leftJoin(orders, and(
            eq(orders.customerId, customers.id),
            isNull(orders.deletedAt),
        ))
        .where(whereClause)
        .groupBy(customers.id)
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
        { id: string; name: string; email: string | null; phone: string; address: string | null; city: string | null; zone: string | null; area: string | null; accountClaimedAt: number | null; totalOrders: number; totalSpent: number; lastOrderAt: number | null; createdAt: number; updatedAt: number }[],
        { id: string; name: string }[],
    ];
    const count = countArr[0]?.count ?? 0;

    const locationMap = new Map<string, string>();
    locationResults.forEach((loc) => locationMap.set(loc.id, loc.name));

    const formattedCustomers = results.map((c) => ({
        ...c,
        accountClaimedAt: c.accountClaimedAt ? new Date(c.accountClaimedAt * 1000).toISOString() : null,
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
    await validateCustomerPhoneCountry(db, data.phone);
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
        await validateCustomerPhoneCountry(db, data.phone);
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
        db
            .update(customerSessions)
            .set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(eq(customerSessions.customerId, id), isNull(customerSessions.revokedAt))),
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
    const referencedOrder = await db
        .select({ id: orders.id })
        .from(orders)
        .where(or(eq(orders.customerId, id), eq(orders.accountOwnerCustomerId, id)))
        .limit(1)
        .get();
    if (referencedOrder) {
        throw new ValidationError("Customers with order history cannot be permanently deleted. Keep the customer archived.");
    }
    await db.batch([
        db.delete(customerSessions).where(eq(customerSessions.customerId, id)),
        db.delete(customerHistory).where(eq(customerHistory.customerId, id)),
        db.delete(customers).where(eq(customers.id, id)),
    ] as Parameters<Database["batch"]>[0]);
}

export async function restoreCustomer(db: Database, id: string): Promise<void> {
    await db.update(customers).set({ deletedAt: null }).where(eq(customers.id, id));
}

export async function bulkDeleteCustomers(db: Database, ids: string[], permanent = false): Promise<void> {
    if (permanent) {
        const referencedOrder = await db
            .select({ id: orders.id })
            .from(orders)
            .where(or(
                inArray(orders.customerId, ids),
                inArray(orders.accountOwnerCustomerId, ids),
            ))
            .limit(1)
            .get();
        if (referencedOrder) {
            throw new ValidationError("Customers with order history cannot be permanently deleted. Keep those customers archived.");
        }
        await db.batch([
            db.delete(customerSessions).where(inArray(customerSessions.customerId, ids)),
            db.delete(customerHistory).where(inArray(customerHistory.customerId, ids)),
            db.delete(customers).where(inArray(customers.id, ids)),
        ] as Parameters<Database["batch"]>[0]);
    } else {
        await db.batch([
            db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(inArray(customers.id, ids)),
            db
                .update(customerSessions)
                .set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(inArray(customerSessions.customerId, ids), isNull(customerSessions.revokedAt))),
        ] as Parameters<Database["batch"]>[0]);
    }
}

// ─────────────────────────────────────────
// Customer Orders (storefront)
// ─────────────────────────────────────────

export async function getCustomerOrders(
    db: Database,
    customerId: string,
    options: CustomerOrdersPageOptions = {},
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
            city: dbCustomer.city,
            zone: dbCustomer.zone,
            area: dbCustomer.area,
            cityName: dbCustomer.cityName,
            zoneName: dbCustomer.zoneName,
            areaName: dbCustomer.areaName,
        }
        : null;

    const accountSummaryQuery = db
        .select({
            totalOrders: sql<number>`CAST(count(*) AS INTEGER)`,
            totalSpent: sql<number>`COALESCE(SUM(CASE WHEN ${orders.paidAmount} > 0 THEN ${orders.paidAmount} ELSE 0 END), 0)`,
            completedOrders: sql<number>`CAST(COALESCE(SUM(CASE WHEN ${inArray(orders.status, [...CUSTOMER_COMPLETED_ORDER_STATUSES])} THEN 1 ELSE 0 END), 0) AS INTEGER)`,
            pendingOrders: sql<number>`CAST(COALESCE(SUM(CASE WHEN ${inArray(orders.status, [...CUSTOMER_PENDING_ORDER_STATUSES])} THEN 1 ELSE 0 END), 0) AS INTEGER)`,
        })
        .from(orders)
        .where(customerAccountOrderVisibilityCondition(customerId));

    const orderListLimit = normalizeCustomerOrdersLimit(options.limit);
    const cursor = decodeCustomerOrdersCursor(options.cursor);
    const orderWhereConditions: SQL[] = [
        customerAccountOrderVisibilityCondition(customerId),
    ];
    if (cursor) {
        orderWhereConditions.push(sql`(
            CAST(${orders.createdAt} AS INTEGER) < ${cursor.createdAt}
            OR (
                CAST(${orders.createdAt} AS INTEGER) = ${cursor.createdAt}
                AND ${orders.id} < ${cursor.id}
            )
        )`);
    }

    const customerOrdersQuery = db
        .select({
            id: orders.id,
            invoiceNumber: orders.invoiceNumber,
            status: orders.status,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingAmountMinor: orders.shippingAmountMinor,
            discountAmountMinor: orders.discountAmountMinor,
            taxAmountMinor: orders.taxAmountMinor,
            totalAmountMinor: orders.totalAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            expectedDelivery: orders.expectedDelivery,
            shippingAddress: orders.shippingAddress,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            notes: orders.notes,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`
        })
        .from(orders)
        .where(and(...orderWhereConditions))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(orderListLimit + 1);

    const [accountSummaryRows, customerOrdersWithLookahead] = await db.batch([
        accountSummaryQuery,
        customerOrdersQuery,
    ] as Parameters<Database["batch"]>[0]) as [
        Array<CustomerAccountOrderSummary>,
        Array<{
            id: string;
            invoiceNumber: number | null;
            status: string;
            totalAmount: number;
            paidAmount: number;
            balanceDue: number;
            shippingCharge: number;
            discountAmount: number | null;
            paymentStatus: string;
            paymentMethod: string;
            fulfillmentStatus: string;
            expectedDelivery: string | null;
            shippingAddress: string;
            cityName: string | null;
            zoneName: string | null;
            areaName: string | null;
            notes: string | null;
            createdAt: number | null;
        }>,
    ];

    const customerOrders = customerOrdersWithLookahead.slice(0, orderListLimit);
    const hasMore = customerOrdersWithLookahead.length > orderListLimit;
    const nextCursor = hasMore ? encodeCustomerOrdersCursor(customerOrders[customerOrders.length - 1]!) : null;
    const accountSummary = accountSummaryRows[0];
    const summary: CustomerAccountOrderSummary = accountSummary
        ? {
            totalOrders: Number(accountSummary.totalOrders ?? 0),
            totalSpent: roundPrice(Number(accountSummary.totalSpent ?? 0)),
            completedOrders: Number(accountSummary.completedOrders ?? 0),
            pendingOrders: Number(accountSummary.pendingOrders ?? 0),
        }
        : {
            totalOrders: 0,
            totalSpent: 0,
            completedOrders: 0,
            pendingOrders: 0,
        };

    // Fetch items for all orders in one batch
    const orderIds = customerOrders.map((o) => o.id);
    const itemsByOrder = new Map<string, CustomerOrderListItem[]>();
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
                    productName: orderItems.productName,
                    productSlug: products.slug,
                    productImageObjectKey: media.objectKey,
                    productImageStatus: media.status,
                    variantLabel: orderItems.variantLabel,
                })
                .from(orderItems)
                .leftJoin(products, eq(products.id, orderItems.productId))
                .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
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
            Array<CustomerOrderListItem & {
                productImageObjectKey: string | null;
                productImageStatus: string | null;
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

        for (const { productImageObjectKey, productImageStatus, ...item } of allItems) {
            const list = itemsByOrder.get(item.orderId) || [];
            list.push({
                ...item,
                productImage: historicalOrderImageUrl(
                    productImageObjectKey,
                    productImageStatus,
                ),
            });
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
        balanceDue: getCustomerVisibleBalanceDue(order),
        createdAt: order.createdAt
            ? new Date(order.createdAt * 1000).toISOString()
            : null,
        latestShipment: latestShipmentByOrder.get(order.id) ?? null,
        items: itemsByOrder.get(order.id) || []
    }));

    return {
        orders: formattedOrders,
        customerProfile,
        summary,
        pagination: {
            limit: orderListLimit,
            returned: formattedOrders.length,
            hasMore,
            nextCursor,
        },
    };
}

export async function getCustomerOwnedOrderForDetail(
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
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingAmountMinor: orders.shippingAmountMinor,
            discountAmountMinor: orders.discountAmountMinor,
            taxAmountMinor: orders.taxAmountMinor,
            totalAmountMinor: orders.totalAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            deletedAt: orders.deletedAt,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
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
            customerAccountOrderVisibilityCondition(customerId),
        ))
        .get();

    if (!order) {
        throw new NotFoundError("Order not found");
    }

    return order;
}

export type CustomerOwnedOrderForDetail = Awaited<ReturnType<typeof getCustomerOwnedOrderForDetail>>;

export function getCustomerPaymentSessionOrderForDetail(order: CustomerOwnedOrderForDetail) {
    return {
        id: order.id,
        totalAmount: order.totalAmount,
        totalAmountMinor: order.totalAmountMinor,
        currencyCode: order.currencyCode,
        currencyDecimalPlaces: order.currencyDecimalPlaces,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paidAmount: order.paidAmount,
        balanceDue: order.balanceDue,
        deletedAt: order.deletedAt,
        paymentMethod: order.paymentMethod,
        shipmentClaimId: order.shipmentClaimId,
        shipmentClaimExpiresAt: order.shipmentClaimExpiresAt,
    };
}

export async function getCustomerOrderDetail(
    db: Database,
    customerId: string,
    orderId: string,
) {
    const order = await getCustomerOwnedOrderForDetail(db, customerId, orderId);
    return getCustomerOrderDetailForOrder(db, order);
}

export async function getCustomerOrderDetailForOrder(
    db: Database,
    order: CustomerOwnedOrderForDetail,
) {
    const orderId = order.id;

    const [batchedRows, refundAttemptViews, supportRequests, customerRequestPolicy] = await Promise.all([
        db.batch([
        db
            .select({
                id: orderItems.id,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                price: orderItems.price,
                productName: orderItems.productName,
                productSlug: products.slug,
                productImageObjectKey: media.objectKey,
                productImageStatus: media.status,
                variantLabel: orderItems.variantLabel,
                unitPrice: orderItems.price,
                lineTotal: sql<number>`${orderItems.quantity} * ${orderItems.price}`.as("lineTotal"),
                fulfillmentStatus: orderItems.fulfillmentStatus,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
                discountAmountMinor: orderItems.discountAmountMinor,
                taxableAmountMinor: orderItems.taxableAmountMinor,
                taxAmountMinor: orderItems.taxAmountMinor,
                createdAt: sql<number>`CAST(${orderItems.createdAt} AS INTEGER)`,
            })
            .from(orderItems)
            .leftJoin(products, eq(products.id, orderItems.productId))
            .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
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
        ] as Parameters<Database["batch"]>[0]),
        listOrderRefundAttempts(db, orderId, { audience: "customer" }),
        listOrderSupportRequests(db, orderId),
        getCustomerRequestPolicy(db),
    ]);

    const [items, shipments, payments, plans, codRows, notificationReceipts] = batchedRows as [
        Array<{
            id: string;
            productId: string;
            variantId: string | null;
            quantity: number;
            price: number;
            productName: string | null;
            productSlug: string | null;
            productImageObjectKey: string | null;
            productImageStatus: string | null;
            variantLabel: string | null;
            unitPrice: number;
            lineTotal: number;
            fulfillmentStatus: string;
            unitPriceMinor: number | null;
            lineSubtotalMinor: number | null;
            discountAmountMinor: number | null;
            taxableAmountMinor: number | null;
            taxAmountMinor: number;
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
        CustomerOrderNotificationReceiptRow[],
    ];

    const formattedItems = items.map(({
        productImageObjectKey,
        productImageStatus,
        ...item
    }) => ({
        ...item,
        productImage: historicalOrderImageUrl(productImageObjectKey, productImageStatus),
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

    const notifications = projectCustomerOrderNotifications(notificationReceipts);
    const activeRefundOperation = summarizeActiveRefundOperation(refundAttemptViews, "customer");
    const supportRequestActions = applyCustomerRequestPolicyToSupportActions(
        customerRequestPolicy,
        getCustomerOrderSupportRequestActions(order, {
            hasShipment: formattedShipments.length > 0,
            hasActiveRefundOperation: Boolean(activeRefundOperation),
            activeRequestTypes: getActiveSupportRequestTypes(supportRequests),
        }),
    );

    const timeline: CustomerOrderDetailTimelineEvent[] = buildCustomerOrderBaseTimelineEvents(order);

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

    for (const refund of refundAttemptViews) {
        timeline.push({
            id: `refund:${refund.id}`,
            type: "refund",
            status: refund.status,
            label: refund.label,
            happenedAt: refund.refundedAt ?? refund.failedAt ?? refund.lastProbeAt ?? refund.updatedAt ?? refund.createdAt,
            details: refund.message,
        });
    }

    for (const request of supportRequests) {
        timeline.push({
            id: `request:${request.id}`,
            type: "request",
            status: request.status,
            label: request.label,
            happenedAt: request.submittedAt ?? request.updatedAt ?? request.createdAt,
            details: request.reason,
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

    timeline.push(...buildCustomerOrderNotificationTimelineEvents(notifications));

    timeline.sort((a, b) => {
        if (!a.happenedAt && !b.happenedAt) return 0;
        if (!a.happenedAt) return 1;
        if (!b.happenedAt) return -1;
        return new Date(a.happenedAt).getTime() - new Date(b.happenedAt).getTime();
    });

    return {
        order: {
            id: order.id,
            invoiceNumber: order.invoiceNumber,
            status: order.status,
            totalAmount: order.totalAmount,
            paidAmount: order.paidAmount,
            balanceDue: getCustomerVisibleBalanceDue(order),
            shippingCharge: order.shippingCharge,
            discountAmount: order.discountAmount,
            currencyCode: order.currencyCode,
            currencyDecimalPlaces: order.currencyDecimalPlaces,
            subtotalAmountMinor: order.subtotalAmountMinor,
            shippingAmountMinor: order.shippingAmountMinor,
            discountAmountMinor: order.discountAmountMinor,
            taxAmountMinor: order.taxAmountMinor,
            totalAmountMinor: order.totalAmountMinor,
            taxLabel: order.taxLabel,
            pricesIncludeTax: order.pricesIncludeTax,
            paymentStatus: order.paymentStatus,
            paymentMethod: order.paymentMethod,
            fulfillmentStatus: order.fulfillmentStatus,
            expectedDelivery: order.expectedDelivery,
            shippingAddress: order.shippingAddress,
            city: order.city,
            zone: order.zone,
            area: order.area,
            cityName: order.cityName,
            zoneName: order.zoneName,
            areaName: order.areaName,
            notes: order.notes,
            createdAt: timestampToIso(order.createdAt),
            updatedAt: timestampToIso(order.updatedAt),
        },
        items: formattedItems,
        shipments: formattedShipments,
        payments: formattedPayments,
        refundAttempts: refundAttemptViews,
        activeRefundOperation,
        supportRequests,
        supportRequestActions,
        supportRequestIntro: getCustomerRequestIntro(customerRequestPolicy),
        paymentPlan,
        cod,
        notifications,
        timeline,
    };
}
