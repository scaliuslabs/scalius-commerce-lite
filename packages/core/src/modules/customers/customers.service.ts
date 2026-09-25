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
    orderNotificationOutbox,
    orderPayments,
    orderSupportRequests,
    orders,
    OrderStatus,
    paymentPlans,
    PaymentStatus,
    media,
    products,
} from "@scalius/database/schema";
import { sql, isNull, isNotNull, inArray, asc, desc, eq, and, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { fromMinor } from "@scalius/shared/money";
import { orderMoneyAmounts, orderMoneySelection } from "../orders/money";
import { customerKind } from "./customer-identity";
import { ftsMatch } from "../../search/fts5";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import { publishedMediaObjectKey } from "../media/media.presentation";
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
    type OrderSupportRequestView,
} from "../orders/order-support-requests";
import {
    CUSTOMER_REQUEST_ACTION_COPY,
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

const customerCityLocation = alias(deliveryLocations, "customer_city_location");
const customerZoneLocation = alias(deliveryLocations, "customer_zone_location");
const customerAreaLocation = alias(deliveryLocations, "customer_area_location");

export interface CustomerOrderShipmentSummary {
    id: string;
    providerType: string;
    providerName: string | null;
    status: string;
    statusLabel: string;
    rawStatus: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
    courierName: string | null;
    lastChecked: string | null;
    updatedAt: string | null;
    createdAt: string | null;
}

export function buildCustomerOrderItemDetailProjection() {
    return {
        id: orderItems.id,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        productName: orderItems.productName,
        productSlug: products.slug,
        productImageObjectKey: publishedMediaObjectKey(),
        productImageStatus: media.status,
        variantLabel: orderItems.variantLabel,
        fulfillmentStatus: orderItems.fulfillmentStatus,
        unitPriceMinor: orderItems.unitPriceMinor,
        lineSubtotalMinor: orderItems.lineSubtotalMinor,
        discountAmountMinor: orderItems.discountAmountMinor,
        taxableAmountMinor: orderItems.taxableAmountMinor,
        taxAmountMinor: orderItems.taxAmountMinor,
        createdAt: sql<number>`CAST(${orderItems.createdAt} AS INTEGER)`,
    };
}

type CustomerOrderListItem = {
    orderId: string;
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPriceMinor: number;
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
    type: "order" | "payment" | "refund" | "request";
    status: string;
    label: string;
    happenedAt: string | null;
    details?: string | null;
}

/** Where an order is, in the buyer's words; never provider or internal states. */
type CustomerOrderMilestone =
    | "placed"
    | "confirmed"
    | "shipped"
    | "delivered"
    | "cancelled"
    | "returned"
    | "refunded"
    | "partially_refunded";

const CUSTOMER_ORDER_STEPS = ["placed", "confirmed", "shipped", "delivered"] as const;
type CustomerOrderStep = typeof CUSTOMER_ORDER_STEPS[number];

const MILESTONE_COPY: Record<CustomerOrderMilestone, { label: string; details: string | null }> = {
    placed: { label: "Order placed", details: "We received your order." },
    confirmed: { label: "Confirmed", details: "The store confirmed your order." },
    shipped: { label: "On its way", details: "Your order is with the courier." },
    delivered: { label: "Delivered", details: null },
    cancelled: { label: "Cancelled", details: null },
    returned: { label: "Returned", details: null },
    refunded: { label: "Refunded", details: null },
    partially_refunded: { label: "Partly refunded", details: null },
};

const ORDER_STATUS_MILESTONE: Record<string, CustomerOrderMilestone> = {
    pending: "placed",
    incomplete: "placed",
    confirmed: "confirmed",
    processing: "confirmed",
    shipped: "shipped",
    delivered: "delivered",
    completed: "delivered",
    cancelled: "cancelled",
    returned: "returned",
    refunded: "refunded",
    partially_refunded: "partially_refunded",
};

/** Every status change is recorded once in the notification outbox, whichever channels are on. */
const NOTIFICATION_MILESTONE: Record<string, CustomerOrderMilestone> = {
    order_confirmed: "confirmed",
    order_processing: "confirmed",
    order_shipped: "shipped",
    order_delivered: "delivered",
    order_completed: "delivered",
    order_cancelled: "cancelled",
    order_returned: "returned",
    order_refunded: "refunded",
    order_partially_refunded: "partially_refunded",
};

/** The one status word a buyer sees for an order ("On its way"). */
export function customerOrderStatusLabel(status: string): string {
    if (status === OrderStatus.INCOMPLETE) return "Awaiting payment";
    return MILESTONE_COPY[ORDER_STATUS_MILESTONE[status] ?? "placed"].label;
}

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
    picked_up: "On its way",
    in_transit: "On its way",
    out_for_delivery: "Out for delivery",
    delivered: "Delivered",
    partial_delivered: "Partly delivered",
    delivery_failed: "Delivery attempt failed",
    pickup_failed: "Delayed",
    on_hold: "Delayed",
    returned: "Returned to the store",
    cancelled: "Cancelled",
};

/** A courier status in buyer words; booking and sync states read "Booked with courier". */
export function customerShipmentStatusLabel(status: string): string {
    return SHIPMENT_STATUS_LABELS[status] ?? "Booked with courier";
}

export interface CustomerOrderProgress {
    steps: Array<{ key: CustomerOrderStep; label: string; done: boolean; happenedAt: string | null }>;
    /** Set when the order left the normal path (cancelled, returned, refunded). */
    outcome: { key: CustomerOrderMilestone; label: string; happenedAt: string | null } | null;
}

export interface CustomerOrderTrackingInput {
    order: { id: string; status: string; createdAt: number | null };
    statusEvents: Array<{ notificationType: string; createdAt: number | null }>;
    shipments: Array<{ createdAt: string | null; providerName: string | null; courierName: string | null }>;
    payments: Array<{ id: string; status: string; createdAt: string | null; updatedAt: string | null }>;
    refunds: Array<{
        id: string;
        status: string;
        label: string;
        message: string;
        refundedAt: string | null;
        failedAt: string | null;
        updatedAt: string | null;
        createdAt: string | null;
    }>;
    requests: Array<{
        id: string;
        status: string;
        label: string;
        reason: string;
        submittedAt: string | null;
        resolvedAt: string | null;
        updatedAt: string | null;
        createdAt: string | null;
    }>;
}

/** Buyers read the store email's word, "declined"; the dashboard keeps "Rejected". */
export function customerSupportRequestView(request: OrderSupportRequestView): OrderSupportRequestView {
    return request.status === "rejected"
        ? { ...request, label: `${CUSTOMER_REQUEST_ACTION_COPY[request.type].label} declined` }
        : request;
}

const PAYMENT_EVENT_LABELS: Record<string, string> = {
    confirmed: "Payment received",
    failed: "Payment didn't go through",
};

/**
 * One step tracker (placed, confirmed, on its way, delivered) plus a short
 * dated list of what happened, newest first, in buyer words only.
 */
export function buildCustomerOrderTracking(input: CustomerOrderTrackingInput): {
    progress: CustomerOrderProgress;
    timeline: CustomerOrderDetailTimelineEvent[];
} {
    const reachedAt = new Map<CustomerOrderMilestone, string>();
    const reach = (milestone: CustomerOrderMilestone, at: string | null) => {
        const known = reachedAt.get(milestone);
        if (at && (!known || at < known)) reachedAt.set(milestone, at);
    };
    reach("placed", timestampToIso(input.order.createdAt));
    for (const event of input.statusEvents) {
        const milestone = NOTIFICATION_MILESTONE[event.notificationType];
        if (milestone) reach(milestone, timestampToIso(event.createdAt));
    }
    if (!reachedAt.has("shipped")) {
        reach("shipped", input.shipments.map((shipment) => shipment.createdAt).filter(Boolean).sort()[0] ?? null);
    }
    const courier = input.shipments.find((shipment) => shipment.providerName || shipment.courierName);

    const current = ORDER_STATUS_MILESTONE[input.order.status] ?? "placed";
    const stepIndex = CUSTOMER_ORDER_STEPS.indexOf(current as CustomerOrderStep);
    const reachedIndex = stepIndex >= 0
        ? stepIndex
        : Math.max(...CUSTOMER_ORDER_STEPS.map((step, index) => reachedAt.has(step) ? index : 0));
    const progress: CustomerOrderProgress = {
        steps: CUSTOMER_ORDER_STEPS.map((key, index) => ({
            key,
            label: MILESTONE_COPY[key].label,
            done: index <= reachedIndex,
            happenedAt: index <= reachedIndex ? reachedAt.get(key) ?? null : null,
        })),
        outcome: stepIndex >= 0
            ? null
            : { key: current, label: MILESTONE_COPY[current].label, happenedAt: reachedAt.get(current) ?? null },
    };

    const timeline: CustomerOrderDetailTimelineEvent[] = [...reachedAt].map(([milestone, happenedAt]) => ({
        id: `order:${input.order.id}:${milestone}`,
        type: "order" as const,
        status: milestone,
        label: MILESTONE_COPY[milestone].label,
        happenedAt,
        details: milestone === "shipped" && courier
            ? `With ${courier.providerName || courier.courierName}.`
            : MILESTONE_COPY[milestone].details,
    }));
    for (const payment of input.payments) {
        const label = PAYMENT_EVENT_LABELS[payment.status];
        if (!label) continue;
        timeline.push({
            id: `payment:${payment.id}`,
            type: "payment",
            status: payment.status,
            label,
            happenedAt: payment.updatedAt ?? payment.createdAt,
            details: null,
        });
    }
    for (const refund of input.refunds) {
        timeline.push({
            id: `refund:${refund.id}`,
            type: "refund",
            status: refund.status,
            label: refund.label,
            happenedAt: refund.refundedAt ?? refund.failedAt ?? refund.updatedAt ?? refund.createdAt,
            details: refund.message,
        });
    }
    for (const request of input.requests) {
        // A decided request is dated by the decision, an open one by the ask.
        const decidedAt = request.status === "submitted" ? null : request.resolvedAt ?? request.updatedAt;
        timeline.push({
            id: `request:${request.id}`,
            type: "request",
            status: request.status,
            label: request.label,
            happenedAt: decidedAt ?? request.submittedAt ?? request.createdAt,
            details: request.reason,
        });
    }
    timeline.sort((a, b) => (b.happenedAt ?? "").localeCompare(a.happenedAt ?? ""));
    return { progress, timeline };
}

const CUSTOMER_CLOSED_BALANCE_ORDER_STATUSES = [
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
    OrderStatus.RETURNED,
] as const;
const CUSTOMER_CLOSED_BALANCE_ORDER_STATUS_SET = new Set<string>(CUSTOMER_CLOSED_BALANCE_ORDER_STATUSES);

const CUSTOMER_CLOSED_BALANCE_PAYMENT_STATUSES = [
    PaymentStatus.PARTIALLY_REFUNDED,
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
    balanceDueMinor: number;
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

/** The balance a buyer still owes, in minor units; closed or failed orders owe nothing. */
export function getCustomerVisibleBalanceDueMinor(order: CustomerOrderMoneyState): number {
    if (
        CUSTOMER_CLOSED_BALANCE_ORDER_STATUS_SET.has(order.status) ||
        CUSTOMER_CLOSED_BALANCE_PAYMENT_STATUS_SET.has(order.paymentStatus) ||
        (
            order.paymentStatus === PaymentStatus.FAILED &&
            order.status !== OrderStatus.INCOMPLETE
        )
    ) {
        return 0;
    }

    return Math.max(0, order.balanceDueMinor);
}

/**
 * Paid spend summed exactly in minor units. A store has one currency (it is
 * locked once orders exist), so the orders' own decimal places convert it.
 */
function paidSpendProjection() {
    return {
        totalSpentMinor: sql<number>`COALESCE(SUM(CASE WHEN ${orders.paidAmountMinor} > 0 THEN ${orders.paidAmountMinor} ELSE 0 END), 0)`,
        spendDecimalPlaces: sql<number>`COALESCE(MAX(${orders.currencyDecimalPlaces}), 2)`,
    };
}

export function paidSpendAmount(row: { totalSpentMinor: number; spendDecimalPlaces: number }): number {
    return fromMinor(Number(row.totalSpentMinor), Number(row.spendDecimalPlaces));
}

export function buildCustomerOrderMetricsProjection() {
    return {
        totalOrders: sql<number>`CAST(count(${orders.id}) AS INTEGER)`,
        ...paidSpendProjection(),
        lastOrderAt: sql<number | null>`max(CAST(${orders.createdAt} AS INTEGER))`,
    };
}

export function customerAccountOrderVisibilityCondition(customerId: string): SQL {
    return and(
        customerAccountOwnershipCondition(customerId),
        isNull(orders.deletedAt),
    )!;
}

/** The name on the record's most recent order (a guest record's secondary text). */
export function latestOrderNameSql(customerId: SQLWrapper) {
    return sql<string | null>`(SELECT ${orders.customerName} FROM ${orders} WHERE ${orders.customerId} = ${customerId} AND ${orders.deletedAt} IS NULL ORDER BY ${orders.createdAt} DESC, ${orders.orderNumber} DESC LIMIT 1)`;
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
        // A retired guest record (all its orders joined an account) is merged, not trashed.
        whereConditions.push(sql`${customers.deletedAt} IS NOT NULL AND ${customers.mergedIntoCustomerId} IS NULL`);
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
            case "totalSpent": return metrics.totalSpentMinor;
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
            cityName: sql<string | null>`COALESCE(${customerCityLocation.name}, ${customers.city})`,
            zoneName: sql<string | null>`COALESCE(${customerZoneLocation.name}, ${customers.zone})`,
            areaName: sql<string | null>`COALESCE(${customerAreaLocation.name}, ${customers.area})`,
            accountClaimedAt: sql<number | null>`CAST(${customers.accountClaimedAt} AS INTEGER)`,
            origin: customers.origin,
            latestOrderName: latestOrderNameSql(customers.id).as("latest_order_name"),
            totalOrders: metrics.totalOrders,
            totalSpentMinor: metrics.totalSpentMinor,
            spendDecimalPlaces: metrics.spendDecimalPlaces,
            lastOrderAt: metrics.lastOrderAt,
            createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
        })
        .from(customers)
        .leftJoin(orders, and(
            eq(orders.customerId, customers.id),
            isNull(orders.deletedAt),
        ))
        .leftJoin(customerCityLocation, and(
            eq(customerCityLocation.id, customers.city),
            isNull(customerCityLocation.deletedAt),
        ))
        .leftJoin(customerZoneLocation, and(
            eq(customerZoneLocation.id, customers.zone),
            isNull(customerZoneLocation.deletedAt),
        ))
        .leftJoin(customerAreaLocation, and(
            eq(customerAreaLocation.id, customers.area),
            isNull(customerAreaLocation.deletedAt),
        ))
        .where(whereClause)
        .groupBy(
            customers.id,
            customerCityLocation.name,
            customerZoneLocation.name,
            customerAreaLocation.name,
        )
        .limit(limit)
        .offset(offset)
        .orderBy(order === "asc" ? asc(sortField) : desc(sortField));

    const [countArr, results] = await db.batch([
        countQuery,
        resultsQuery,
    ] as Parameters<Database["batch"]>[0]) as [
        { count: number }[],
        { id: string; name: string; email: string | null; phone: string; address: string | null; city: string | null; zone: string | null; area: string | null; cityName: string | null; zoneName: string | null; areaName: string | null; accountClaimedAt: number | null; origin: string; latestOrderName: string | null; totalOrders: number; totalSpentMinor: number; spendDecimalPlaces: number; lastOrderAt: number | null; createdAt: number; updatedAt: number }[],
    ];
    const count = countArr[0]?.count ?? 0;

    const formattedCustomers = results.map(({ totalSpentMinor, spendDecimalPlaces, origin, ...c }) => ({
        ...c,
        kind: customerKind({ accountClaimedAt: c.accountClaimedAt, origin }),
        totalSpent: paidSpendAmount({ totalSpentMinor, spendDecimalPlaces }),
        accountClaimedAt: c.accountClaimedAt ? new Date(c.accountClaimedAt * 1000).toISOString() : null,
        lastOrderAt: c.lastOrderAt ? new Date(c.lastOrderAt * 1000).toISOString() : null,
        createdAt: new Date(c.createdAt * 1000).toISOString(),
        updatedAt: new Date(c.updatedAt * 1000).toISOString(),
    }));

    return {
        customers: formattedCustomers,
        pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
    };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createCustomer(
    db: Database,
    data: CreateCustomerInput,
    actorId: string | null = null,
): Promise<{ id: string }> {
    await validateCustomerPhoneCountry(db, data.phone);
    const existing = await findActiveCustomerWithPhone(db, data.phone);
    if (existing) throw new ValidationError("Customer with this phone number already exists", { customer: existing });

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
            origin: "merchant",
            totalOrders: 0,
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
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

    return { id: customerId };
}

export async function getCustomerById(db: Database, id: string) {
    return db.select().from(customers).where(eq(customers.id, id)).get() ?? null;
}

/** The customer row plus its paid spend, derived from its orders. */
export async function getCustomerDetail(db: Database, id: string) {
    const [customer, spend, latest] = await Promise.all([
        getCustomerById(db, id),
        db.select(paidSpendProjection()).from(orders)
            .where(and(eq(orders.customerId, id), isNull(orders.deletedAt)))
            .get(),
        db.select({ name: latestOrderNameSql(customers.id) }).from(customers).where(eq(customers.id, id)).get(),
    ]);
    if (!customer) return null;
    const mergedInto = customer.mergedIntoCustomerId
        ? await db.select({ id: customers.id, name: customers.name }).from(customers)
            .where(eq(customers.id, customer.mergedIntoCustomerId)).get() ?? null
        : null;
    return {
        ...customer,
        mergedInto,
        kind: customerKind(customer),
        latestOrderName: latest?.name ?? null,
        totalSpent: spend ? paidSpendAmount(spend) : 0,
    };
}

export async function updateCustomer(
    db: Database,
    id: string,
    data: UpdateCustomerInput,
    actorId: string | null = null,
) {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    if (data.phone && data.phone !== existing.phone) {
        await validateCustomerPhoneCountry(db, data.phone);
        const phoneConflict = await findActiveCustomerWithPhone(db, data.phone, id);
        if (phoneConflict) {
            throw new ValidationError("Another customer with this phone number already exists", { customer: phoneConflict });
        }
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

    const next = {
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
    };
    // A save that changes nothing writes nothing: no bumped timestamp, no empty "Updated" entry.
    if ((Object.keys(next) as Array<keyof typeof next>).every((key) => (next[key] ?? null) === (existing[key] ?? null))) return;

    // Naming a checkout guest record in the dashboard makes it the merchant's customer.
    const origin = !existing.accountClaimedAt && next.name !== existing.name ? { origin: "merchant" as const } : {};
    await db.batch([
        db.update(customers).set({ ...data, ...origin, cityName, zoneName, areaName, updatedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            ...next,
            changeType: "updated",
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

}


export async function deleteCustomer(db: Database, id: string, actorId: string | null = null): Promise<void> {
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
            actor: "staff",
            actorId,
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

/** Restores a trashed customer (a merged guest record stays merged) and logs who did it. */
export async function restoreCustomer(db: Database, id: string, actorId: string | null = null): Promise<void> {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");
    if (!existing.deletedAt) return;
    if (existing.mergedIntoCustomerId) {
        throw new ValidationError("This guest record was merged into an account and can't be restored.");
    }
    await db.batch([
        db.update(customers).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
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
            changeType: "restored",
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);
}

/** The active customer already using a phone, for a dashboard "uses this phone" link. */
async function findActiveCustomerWithPhone(db: Database, phone: string, exceptId?: string) {
    const row = await db
        .select({ id: customers.id, name: customers.name, phone: customers.phone, accountClaimedAt: customers.accountClaimedAt, origin: customers.origin })
        .from(customers)
        .where(and(
            eq(customers.phone, phone),
            isNull(customers.deletedAt),
            exceptId ? sql`${customers.id} != ${exceptId}` : undefined,
        ))
        .orderBy(desc(customers.accountClaimedAt))
        .get();
    return row ? { id: row.id, name: row.name, phone: row.phone, kind: customerKind(row) } : null;
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
            ...paidSpendProjection(),
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
            orderNumber: orders.orderNumber,
            invoiceNumber: orders.invoiceNumber,
            status: orders.status,
            ...orderMoneySelection(orders),
            currencyCode: orders.currencyCode,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingMethodId: orders.shippingMethodId,
            shippingMethodName: orders.shippingMethodName,
            shippingMethodDescription: orders.shippingMethodDescription,
            shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
            shippingFeeWaived: orders.shippingFeeWaived,
            taxAmountMinor: orders.taxAmountMinor,
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
        Array<Omit<CustomerAccountOrderSummary, "totalSpent"> & {
            totalSpentMinor: number;
            spendDecimalPlaces: number;
        }>,
        Array<{
            id: string;
            orderNumber: number | null;
            invoiceNumber: number | null;
            status: string;
            currencyCode: string;
            currencyDecimalPlaces: number;
            totalAmountMinor: number;
            shippingAmountMinor: number;
            discountAmountMinor: number;
            paidAmountMinor: number;
            balanceDueMinor: number;
            shippingMethodId: string | null;
            shippingMethodName: string | null;
            shippingMethodDescription: string | null;
            shippingMethodBaseAmountMinor: number | null;
            shippingFeeWaived: boolean | null;
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
            totalSpent: paidSpendAmount(accountSummary),
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
    const openRequestTypeByOrder = new Map<string, string>();

    if (orderIds.length > 0) {
        const [allItems, allShipments, openRequests] = await db.batch([
            db
                .select({
                    orderId: orderItems.orderId,
                    productId: orderItems.productId,
                    variantId: orderItems.variantId,
                    quantity: orderItems.quantity,
                    unitPriceMinor: orderItems.unitPriceMinor,
                    productName: orderItems.productName,
                    productSlug: products.slug,
                    productImageObjectKey: publishedMediaObjectKey(),
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
            // A request holds its active key only while it is open.
            db
                .select({ orderId: orderSupportRequests.orderId, type: orderSupportRequests.type })
                .from(orderSupportRequests)
                .where(and(
                    inArray(orderSupportRequests.orderId, orderIds),
                    isNotNull(orderSupportRequests.activeKey),
                )),
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
            Array<{ orderId: string; type: string }>,
        ];

        for (const request of openRequests) openRequestTypeByOrder.set(request.orderId, request.type);

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
                statusLabel: customerShipmentStatusLabel(shipment.status),
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
        ...orderMoneyAmounts(order),
        statusLabel: customerOrderStatusLabel(order.status),
        balanceDue: fromMinor(getCustomerVisibleBalanceDueMinor(order), order.currencyDecimalPlaces),
        createdAt: order.createdAt
            ? new Date(order.createdAt * 1000).toISOString()
            : null,
        openSupportRequestType: openRequestTypeByOrder.get(order.id) ?? null,
        latestShipment: latestShipmentByOrder.get(order.id) ?? null,
        items: (itemsByOrder.get(order.id) || []).map(({ unitPriceMinor, ...item }) => ({
            ...item,
            price: fromMinor(unitPriceMinor, order.currencyDecimalPlaces),
        })),
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
            orderNumber: orders.orderNumber,
            invoiceNumber: orders.invoiceNumber,
            status: orders.status,
            ...orderMoneySelection(orders),
            currencyCode: orders.currencyCode,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingMethodId: orders.shippingMethodId,
            shippingMethodName: orders.shippingMethodName,
            shippingMethodDescription: orders.shippingMethodDescription,
            shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
            shippingFeeWaived: orders.shippingFeeWaived,
            taxAmountMinor: orders.taxAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            deletedAt: orders.deletedAt,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            fulfillmentStatus: orders.fulfillmentStatus,
            expectedDelivery: orders.expectedDelivery,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
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
        totalAmountMinor: order.totalAmountMinor,
        currencyCode: order.currencyCode,
        currencyDecimalPlaces: order.currencyDecimalPlaces,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paidAmountMinor: order.paidAmountMinor,
        balanceDueMinor: order.balanceDueMinor,
        deletedAt: order.deletedAt,
        paymentMethod: order.paymentMethod,
        shipmentClaimId: order.shipmentClaimId,
        shipmentClaimExpiresAt: order.shipmentClaimExpiresAt,
    };
}

/** A courier tracking link a buyer may follow: http(s) only. */
function buyerTrackingUrl(value: string | null): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * Where an order is, for the tracked-order view of the receipt: the same step
 * tracker and dated timeline as the account order page, plus each parcel's
 * courier and tracking reference. The caller has already proved the viewer.
 */
export async function getBuyerOrderTracking(
    db: Database,
    order: { id: string; status: string; createdAt: number | null },
) {
    const [shipments, payments, statusEvents, refunds, requests] = await Promise.all([
        db
            .select({
                providerName: deliveryProviders.name,
                courierName: deliveryShipments.courierName,
                status: deliveryShipments.status,
                trackingId: deliveryShipments.trackingId,
                trackingUrl: deliveryShipments.trackingUrl,
                createdAt: sql<number>`CAST(${deliveryShipments.createdAt} AS INTEGER)`,
            })
            .from(deliveryShipments)
            .leftJoin(deliveryProviders, eq(deliveryProviders.id, deliveryShipments.providerId))
            .where(eq(deliveryShipments.orderId, order.id))
            .orderBy(desc(deliveryShipments.createdAt)),
        db
            .select({
                id: orderPayments.id,
                status: orderPayments.status,
                createdAt: sql<number>`CAST(${orderPayments.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${orderPayments.updatedAt} AS INTEGER)`,
            })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, order.id)),
        db
            .select({
                notificationType: orderNotificationOutbox.notificationType,
                createdAt: orderNotificationOutbox.createdAt,
            })
            .from(orderNotificationOutbox)
            .where(eq(orderNotificationOutbox.orderId, order.id)),
        listOrderRefundAttempts(db, order.id, { audience: "customer" }),
        listOrderSupportRequests(db, order.id),
    ]);

    const { progress, timeline } = buildCustomerOrderTracking({
        order,
        statusEvents,
        shipments: shipments.map((shipment) => ({ ...shipment, createdAt: timestampToIso(shipment.createdAt) })),
        payments: payments.map((payment) => ({
            ...payment,
            createdAt: timestampToIso(payment.createdAt),
            updatedAt: timestampToIso(payment.updatedAt),
        })),
        refunds,
        requests: requests.map(customerSupportRequestView),
    });

    return {
        progress,
        timeline,
        shipments: shipments.map((shipment) => ({
            statusLabel: customerShipmentStatusLabel(shipment.status),
            courierName: shipment.courierName?.trim() || shipment.providerName?.trim() || null,
            trackingId: shipment.trackingId?.trim() || null,
            trackingUrl: buyerTrackingUrl(shipment.trackingUrl),
        })),
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

    const [batchedRows, refundAttemptViews, supportRequestRows, customerRequestPolicy] = await Promise.all([
        db.batch([
        db
            .select(buildCustomerOrderItemDetailProjection())
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
                shipmentAmountMinor: deliveryShipments.shipmentAmountMinor,
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
                amountMinor: orderPayments.amountMinor,
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
                totalAmountMinor: paymentPlans.totalAmountMinor,
                depositAmountMinor: paymentPlans.depositAmountMinor,
                balanceDueMinor: paymentPlans.balanceDueMinor,
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
                collectedAmountMinor: codTracking.collectedAmountMinor,
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
                notificationType: orderNotificationOutbox.notificationType,
                createdAt: orderNotificationOutbox.createdAt,
            })
            .from(orderNotificationOutbox)
            .where(eq(orderNotificationOutbox.orderId, orderId)),
        ] as Parameters<Database["batch"]>[0]),
        listOrderRefundAttempts(db, orderId, { audience: "customer" }),
        listOrderSupportRequests(db, orderId),
        getCustomerRequestPolicy(db),
    ]);
    const supportRequests = supportRequestRows.map(customerSupportRequestView);

    const [items, shipments, payments, plans, codRows, statusEvents] = batchedRows as [
        Array<{
            id: string;
            productId: string;
            variantId: string | null;
            quantity: number;
            productName: string | null;
            productSlug: string | null;
            productImageObjectKey: string | null;
            productImageStatus: string | null;
            variantLabel: string | null;
            fulfillmentStatus: string;
            unitPriceMinor: number;
            lineSubtotalMinor: number;
            discountAmountMinor: number;
            taxableAmountMinor: number;
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
            shipmentAmountMinor: number | null;
            isFinalShipment: boolean;
            lastChecked: number | null;
            updatedAt: number | null;
            createdAt: number | null;
        }>,
        Array<{
            id: string;
            amountMinor: number;
            currency: string;
            paymentMethod: string;
            paymentType: string;
            status: string;
            codReceiptUrl: string | null;
            createdAt: number | null;
            updatedAt: number | null;
        }>,
        Array<{
            totalAmountMinor: number;
            depositAmountMinor: number;
            balanceDueMinor: number;
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
            collectedAmountMinor: number | null;
            receiptUrl: string | null;
            lastAttemptAt: number | null;
            collectedAt: number | null;
            updatedAt: number | null;
        }>,
        Array<{ notificationType: string; createdAt: number | null }>,
    ];

    const amount = (minor: number) => fromMinor(minor, order.currencyDecimalPlaces);
    const optionalAmount = (minor: number | null) => minor === null ? null : amount(minor);
    const formattedItems = items.map(({
        productImageObjectKey,
        productImageStatus,
        ...item
    }) => ({
        ...item,
        price: amount(item.unitPriceMinor),
        unitPrice: amount(item.unitPriceMinor),
        lineTotal: amount(item.unitPriceMinor * item.quantity),
        productImage: historicalOrderImageUrl(productImageObjectKey, productImageStatus),
        createdAt: timestampToIso(item.createdAt),
    }));

    const formattedShipments = shipments.map(({ shipmentAmountMinor, ...shipment }) => ({
        ...shipment,
        statusLabel: customerShipmentStatusLabel(shipment.status),
        shipmentAmount: optionalAmount(shipmentAmountMinor),
        lastChecked: timestampToIso(shipment.lastChecked),
        updatedAt: timestampToIso(shipment.updatedAt),
        createdAt: timestampToIso(shipment.createdAt),
    }));

    const formattedPayments = payments.map(({ amountMinor, ...payment }) => ({
        ...payment,
        amount: amount(amountMinor),
        createdAt: timestampToIso(payment.createdAt),
        updatedAt: timestampToIso(payment.updatedAt),
    }));

    const plan = plans[0];
    const paymentPlan = plan
        ? {
            totalAmount: amount(plan.totalAmountMinor),
            depositAmount: amount(plan.depositAmountMinor),
            balanceDue: amount(plan.balanceDueMinor),
            balanceDueDate: plan.balanceDueDate,
            status: plan.status,
            depositPaidAt: timestampToIso(plan.depositPaidAt),
            balancePaidAt: timestampToIso(plan.balancePaidAt),
            createdAt: timestampToIso(plan.createdAt),
            updatedAt: timestampToIso(plan.updatedAt),
        }
        : null;

    const codRow = codRows[0];
    const cod = codRow
        ? {
            codStatus: codRow.codStatus,
            deliveryAttempts: codRow.deliveryAttempts,
            failureReason: codRow.failureReason,
            collectedAmount: optionalAmount(codRow.collectedAmountMinor),
            receiptUrl: codRow.receiptUrl,
            lastAttemptAt: timestampToIso(codRow.lastAttemptAt),
            collectedAt: timestampToIso(codRow.collectedAt),
            updatedAt: timestampToIso(codRow.updatedAt),
        }
        : null;

    const activeRefundOperation = summarizeActiveRefundOperation(refundAttemptViews, "customer");
    const supportRequestActions = applyCustomerRequestPolicyToSupportActions(
        customerRequestPolicy,
        getCustomerOrderSupportRequestActions(order, {
            hasShipment: formattedShipments.length > 0,
            hasActiveRefundOperation: Boolean(activeRefundOperation),
            activeRequestTypes: getActiveSupportRequestTypes(supportRequests),
        }),
    );

    const { progress, timeline } = buildCustomerOrderTracking({
        order,
        statusEvents,
        shipments: formattedShipments,
        payments: formattedPayments,
        refunds: refundAttemptViews,
        requests: supportRequests,
    });

    return {
        order: {
            id: order.id,
            orderNumber: order.orderNumber,
            invoiceNumber: order.invoiceNumber,
            status: order.status,
            statusLabel: customerOrderStatusLabel(order.status),
            ...orderMoneyAmounts(order),
            balanceDue: amount(getCustomerVisibleBalanceDueMinor(order)),
            currencyCode: order.currencyCode,
            currencyDecimalPlaces: order.currencyDecimalPlaces,
            subtotalAmountMinor: order.subtotalAmountMinor,
            shippingAmountMinor: order.shippingAmountMinor,
            shippingMethodId: order.shippingMethodId,
            shippingMethodName: order.shippingMethodName,
            shippingMethodDescription: order.shippingMethodDescription,
            shippingMethodBaseAmountMinor: order.shippingMethodBaseAmountMinor,
            shippingFeeWaived: order.shippingFeeWaived,
            discountAmountMinor: order.discountAmountMinor,
            taxAmountMinor: order.taxAmountMinor,
            totalAmountMinor: order.totalAmountMinor,
            taxLabel: order.taxLabel,
            pricesIncludeTax: order.pricesIncludeTax,
            paymentStatus: order.paymentStatus,
            paymentMethod: order.paymentMethod,
            fulfillmentStatus: order.fulfillmentStatus,
            expectedDelivery: order.expectedDelivery,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            // Nullable from migration 0083; always present until the Wave A S3 contract.
            shippingAddress: order.shippingAddress ?? "",
            city: order.city ?? "",
            zone: order.zone ?? "",
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
        progress,
        timeline,
    };
}
