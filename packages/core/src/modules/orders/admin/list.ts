// The dashboard order list: views, filters, search and export details.
import { safeBatch, type Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    orderSupportRequests,
    deliveryShipments,
    deliveryProviders,
    paymentSessionAttempts,
    codTracking,
    CodStatus,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
    FulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import { sql, desc, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "../../../search/fts5";
import { fromMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/utils";
import type { OrderPaymentRecoveryFilter, OrderShipmentSummary } from "../types";
import { orderNumberSearchCondition } from "../number";
import { buildPhoneSearchTerms, isEmailSearch, isLikelyPhoneSearch } from "../search";
import { orderMoneyAmounts, orderMoneySelection } from "../money";
import {
    resolveActiveRefundOperationsForOrders,
    selectActiveRefundAttemptRowsForOrders,
    type RefundAttemptVisibilityRow,
} from "../../payments/refund-attempt-visibility";
import { activePaymentSessionAttemptExistsCondition } from "../../payments/payment-session-attempts";
import {
    HOSTED_PAYMENT_METHODS,
    paymentRecoveryLifecycleCondition,
    orderListFactsSelection,
    type OrderListFactsRow,
    type OrderListPaymentAttemptRow,
    presentOrderListFacts,
    buildShipmentRecoverySummary,
    buildPaymentRecoverySummary,
} from "./shared";

const MAX_ORDER_LIST_LIMIT = 100;

type OrderListSort = "relevance" | "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
type OrderListItemCountRow = {
    orderId: string;
    count: number;
    totalQuantity: number;
};
type OrderListShipmentRow = {
    orderId: string;
    id: string;
    providerId: string | null;
    providerType: string | null;
    status: string;
    rawStatus: string | null;
    externalId: string | null;
    trackingId: string | null;
    lastChecked: Date | null;
    updatedAt: Date | null;
    createdAt: Date | null;
    providerName: string | null;
};

function staleOrFailedPaymentSessionAttemptExistsCondition(orderIdSql: SQL) {
    return sql`EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.orderId} = ${orderIdSql}
          AND (
            ${paymentSessionAttempts.status} = 'failed'
            OR (
              ${paymentSessionAttempts.status} = 'processing'
              AND (
                ${paymentSessionAttempts.claimExpiresAt} IS NULL
                OR ${paymentSessionAttempts.claimExpiresAt} <= unixepoch()
              )
            )
          )
    )`;
}

function paymentRecoveryFilterCondition(filter: OrderPaymentRecoveryFilter) {
    const orderIdSql = sql`${orders.id}`;
    const activeAttempt = activePaymentSessionAttemptExistsCondition(orderIdSql);
    const staleOrFailedAttempt = staleOrFailedPaymentSessionAttemptExistsCondition(orderIdSql);
    const hostedMethod = inArray(orders.paymentMethod, [...HOSTED_PAYMENT_METHODS]);
    const needsAttention = sql`(
        ${hostedMethod}
        AND ${paymentRecoveryLifecycleCondition()} = 1
        AND (
          ${orders.paymentStatus} = ${PaymentStatus.FAILED}
          OR ${staleOrFailedAttempt}
        )
    )`;
    const awaitingPayment = sql`(
        ${hostedMethod}
        AND ${orders.status} = ${OrderStatus.INCOMPLETE}
        AND ${orders.paymentStatus} = ${PaymentStatus.UNPAID}
        AND NOT ${activeAttempt}
        AND NOT ${staleOrFailedAttempt}
    )`;

    switch (filter) {
        case "processing":
            return activeAttempt;
        case "needs_attention":
            return needsAttention;
        case "awaiting_payment":
            return awaitingPayment;
        case "recoverable":
            return sql`(${activeAttempt} OR ${needsAttention} OR ${awaitingPayment})`;
    }
}

export const ORDER_LIST_VIEWS = [
    "unfulfilled",
    "unpaid",
    "cod_to_collect",
    "delivery_failed",
    "returned",
] as const;
export type OrderListView = (typeof ORDER_LIST_VIEWS)[number];

function codTrackingStatusExists(statuses: readonly string[]): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${codTracking}
        WHERE ${codTracking.orderId} = ${orders.id}
          AND ${inArray(codTracking.codStatus, [...statuses])}
    )`;
}

function openCustomerRequestExists(): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${orderSupportRequests}
        WHERE ${orderSupportRequests.orderId} = ${orders.id}
          AND ${orderSupportRequests.activeKey} IS NOT NULL
    )`;
}

/**
 * The order tabs. Each view means money or work the merchant still has, so
 * cancelled, returned and unfinished online checkouts never sit in Unpaid or
 * Unfulfilled (ORD-09); cash on delivery gets its own views (ORD-29).
 */
function orderListViewCondition(view: OrderListView): SQL {
    switch (view) {
        case "unfulfilled":
            return sql`${inArray(orders.status, [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.CONFIRMED])}
                AND ${orders.fulfillmentStatus} <> ${FulfillmentStatus.COMPLETE}`;
        case "unpaid":
            return sql`${inArray(orders.paymentStatus, [PaymentStatus.UNPAID, PaymentStatus.PARTIAL])}
                AND ${notInArray(orders.status, [
                    OrderStatus.CANCELLED,
                    OrderStatus.RETURNED,
                    OrderStatus.REFUNDED,
                    OrderStatus.INCOMPLETE,
                ])}`;
        case "cod_to_collect":
            return sql`${orders.paymentMethod} = ${PaymentMethod.COD}
                AND ${inArray(orders.status, [OrderStatus.SHIPPED, OrderStatus.DELIVERED])}
                AND ${orders.balanceDueMinor} > 0
                AND ${codTrackingStatusExists([CodStatus.PENDING, CodStatus.FAILED])}`;
        case "delivery_failed":
            return sql`${orders.status} = ${OrderStatus.SHIPPED}
                AND ${codTrackingStatusExists([CodStatus.FAILED])}`;
        case "returned":
            return sql`${orders.status} = ${OrderStatus.RETURNED}`;
    }
}

function normalizeListPositiveInteger(value: number | undefined, fallback: number, max?: number): number {
    if (!Number.isFinite(value)) return fallback;
    const integer = Math.trunc(value as number);
    const minBounded = Math.max(1, integer);
    return max == null ? minBounded : Math.min(minBounded, max);
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
    paymentRecovery?: OrderPaymentRecoveryFilter;
    view?: OrderListView;
    openRequest?: boolean;
    /** Exactly these orders (an export of a page or a selection). */
    ids?: string[];
    page?: number;
    limit?: number;
    showArchived?: boolean;
    sort?: OrderListSort;
    order?: "asc" | "desc";
    startDate?: Date;
    endDate?: Date;
}) {
    const {
        search,
        status,
        view,
        openRequest = false,
        ids,
        paymentStatus,
        paymentMethod,
        fulfillmentStatus,
        paymentRecovery,
        page: rawPage = 1,
        limit: rawLimit = 10,
        showArchived = false,
        sort = "createdAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const page = normalizeListPositiveInteger(rawPage, 1);
    const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT);
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [];

    whereConditions.push(sql`${orders.deletedAt} IS NULL`);
    if (ids) {
        // An explicit selection is exported as picked, archived or not.
        whereConditions.push(ids.length > 0 ? inArray(orders.id, ids) : sql`1 = 0`);
    } else {
        whereConditions.push(showArchived ? sql`${orders.archivedAt} IS NOT NULL` : sql`${orders.archivedAt} IS NULL`);
    }

    let rankExpression: SQL | undefined = undefined;
    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
        const phoneSearchTerms = buildPhoneSearchTerms(trimmedSearch);
        const phoneCondition = isLikelyPhoneSearch(trimmedSearch)
            ? buildPhoneSearchCondition(phoneSearchTerms)
            : undefined;
        // A full email finds that address only: "rahim@x.com" must not also
        // find "rahima@x.com" through word matching (R2-ORD-14).
        const emailSearch = isEmailSearch(trimmedSearch);
        const ftsCondition = emailSearch
            ? sql`lower(${orders.customerEmail}) = lower(${trimmedSearch})`
            : ftsMatch(db, "orders_fts", "orders", trimmedSearch);
        // Merchants also look orders up by the courier's consignment or tracking id.
        const courierIdCondition = sql`EXISTS (
            SELECT 1 FROM ${deliveryShipments}
            WHERE ${deliveryShipments.orderId} = ${orders.id}
              AND (lower(${deliveryShipments.trackingId}) = lower(${trimmedSearch})
                OR lower(${deliveryShipments.externalId}) = lower(${trimmedSearch}))
        )`;
        const orderNumberCondition = orderNumberSearchCondition(trimmedSearch);
        const matches = [orderNumberCondition, ftsCondition, phoneCondition, courierIdCondition].filter(
            (condition): condition is SQL => condition !== undefined,
        );
        whereConditions.push(sql`(${sql.join(matches, sql` OR `)})`);
        const ftsRank = ftsCondition && !emailSearch && isFts5SearchEnabled(db)
            ? sql`COALESCE(
                    (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitizeFtsQuery(trimmedSearch)}),
                    999999
                ) ASC`
            : undefined;
        // "#1001" puts that order first, then the best text matches.
        const numberRank = orderNumberCondition
            ? sql`CASE WHEN ${orderNumberCondition} THEN 0 ELSE 1 END ASC`
            : undefined;
        rankExpression = numberRank && ftsRank
            ? sql`${numberRank}, ${ftsRank}`
            : numberRank ?? ftsRank;
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (view) {
        whereConditions.push(orderListViewCondition(view));
    }

    if (openRequest) {
        whereConditions.push(openCustomerRequestExists());
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

    if (paymentRecovery) {
        whereConditions.push(paymentRecoveryFilterCondition(paymentRecovery));
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
            // Equally good matches read newest first.
            return [
                rankExpression,
                sql`${orders.createdAt} desc`,
                sql`${orders.id} desc`,
            ];
        }

        const sortField = (() => {
            switch (sort) {
                case "customerName":
                    return orders.customerName;
                case "totalAmount":
                    return orders.totalAmountMinor;
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
            ...orderMoneySelection(orders),
            currencyCode: orders.currencyCode,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            taxAmountMinor: orders.taxAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            version: orders.version,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...orderListFactsSelection(),
        })
        .from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(...orderByExpressions);

    // Batch count + data in a single round-trip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const batchResult = await db.batch([countQuery, dataQuery] as any) as any;
    const countArr = batchResult[0] as { count: number }[];
    const results = batchResult[1] as ({
        id: string; customerName: string; customerPhone: string; customerEmail: string | null;
        customerId: string | null;
        currencyDecimalPlaces: number; totalAmountMinor: number; shippingAmountMinor: number;
        discountAmountMinor: number; paidAmountMinor: number; balanceDueMinor: number;
        subtotalAmountMinor: number;
        status: string; paymentStatus: string; paymentMethod: string | null; fulfillmentStatus: string;
        createdAt: number; updatedAt: number; version: number;
        city: string | null; zone: string | null; area: string | null;
        cityName: string | null; zoneName: string | null; areaName: string | null;
        shipmentClaimId: string | null; shipmentClaimExpiresAt: Date | number | string | null;
        paymentRecoveryApplicable: number;
    } & OrderListFactsRow)[];
    const count = countArr[0]?.count ?? 0;

    const orderIds = results.map((r) => r.id);

    const enrichmentResults = await safeBatch(db, [
        results.length > 0
            ? db
                .select({
                    orderId: orderItems.orderId,
                    count: sql<number>`COUNT(*)`,
                    totalQuantity: sql<number>`SUM(${orderItems.quantity})`,
                })
                .from(orderItems)
                .where(inArray(orderItems.orderId, orderIds))
                .groupBy(orderItems.orderId)
            : db.select({
                orderId: sql<string>`NULL`.as("orderId"),
                count: sql<number>`0`.as("count"),
                totalQuantity: sql<number>`0`.as("totalQuantity"),
            }).from(orderItems).where(sql`1=0`),
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
            }).from(deliveryShipments).where(sql`1=0`),
        results.length > 0
            ? db
                .select({
                    orderId: paymentSessionAttempts.orderId,
                    gateway: paymentSessionAttempts.gateway,
                    paymentType: paymentSessionAttempts.paymentType,
                    status: paymentSessionAttempts.status,
                    attempts: paymentSessionAttempts.attempts,
                    claimExpiresAt: paymentSessionAttempts.claimExpiresAt,
                    createdAt: paymentSessionAttempts.createdAt,
                    updatedAt: paymentSessionAttempts.updatedAt,
                })
                .from(paymentSessionAttempts)
                .where(inArray(paymentSessionAttempts.orderId, orderIds))
                .orderBy(desc(paymentSessionAttempts.updatedAt), desc(paymentSessionAttempts.createdAt))
            : db.select({
                orderId: sql<string>`NULL`.as("orderId"),
                gateway: sql<string>`NULL`.as("gateway"),
                paymentType: sql<string>`NULL`.as("paymentType"),
                status: sql<string>`NULL`.as("status"),
                attempts: sql<number>`0`.as("attempts"),
                claimExpiresAt: sql<number | null>`NULL`.as("claimExpiresAt"),
                createdAt: sql<number>`0`.as("createdAt"),
                updatedAt: sql<number>`0`.as("updatedAt"),
            }).from(paymentSessionAttempts).where(sql`1=0`),
        selectActiveRefundAttemptRowsForOrders(db, orderIds),
    ]);
    const itemCounts = enrichmentResults[0] as OrderListItemCountRow[];
    const shipments = enrichmentResults[1] as OrderListShipmentRow[];
    const paymentAttempts = enrichmentResults[2] as OrderListPaymentAttemptRow[];
    const activeRefundAttemptRows = enrichmentResults[3] as RefundAttemptVisibilityRow[];
    const activeRefundOperations = resolveActiveRefundOperationsForOrders(
        activeRefundAttemptRows,
    );

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

    const attemptsByOrderId = new Map<string, OrderListPaymentAttemptRow[]>();
    for (const attempt of paymentAttempts) {
        if (!attempt.orderId) continue;
        const attempts = attemptsByOrderId.get(attempt.orderId) ?? [];
        attempts.push(attempt);
        attemptsByOrderId.set(attempt.orderId, attempts);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);

    const formattedResults = results.map((order) => {
        const latestShipment = shipmentMap.get(order.id) || null;
        const {
            paymentRecoveryApplicable: _paymentRecoveryApplicable,
            codStatus: _codStatus,
            codDeliveryAttempts: _codDeliveryAttempts,
            returnedValueMinor: _returnedValueMinor,
            refundedMinor: _refundedMinor,
            ...publicOrder
        } = order;
        return {
            ...publicOrder,
            ...orderMoneyAmounts(order),
            ...presentOrderListFacts(order),
            createdAt: new Date(order.createdAt * 1000),
            updatedAt: new Date(order.updatedAt * 1000),
            itemCount: itemCountMap.get(order.id)?.count || 0,
            totalQuantity: itemCountMap.get(order.id)?.quantity || 0,
            latestShipment,
            shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds),
            paymentRecovery: buildPaymentRecoverySummary(
                order,
                attemptsByOrderId.get(order.id) ?? [],
                nowSeconds,
            ),
            activeRefundOperation: activeRefundOperations.get(order.id) ?? null,
        };
    });

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

/** Address, note and line items for an export page (at most 90 orders per read). */
export async function loadOrderExportDetails(db: Database, orderIds: readonly string[]) {
    const details = new Map<string, {
        shippingAddress: string;
        notes: string | null;
        /** Every parcel's courier and tracking, in the order they left. */
        courierName: string | null;
        trackingId: string | null;
        lines: Array<{
            productName: string | null;
            variantLabel: string | null;
            quantity: number;
            unitPrice: number;
            lineTotal: number;
        }>;
    }>();
    for (const chunk of chunkIds(orderIds)) {
        const [orderRows, itemRows, shipmentRows] = await Promise.all([
            db.select({
                id: orders.id,
                shippingAddress: orders.shippingAddress,
                notes: orders.notes,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
            }).from(orders).where(inArray(orders.id, chunk)).all(),
            db.select({
                orderId: orderItems.orderId,
                productName: orderItems.productName,
                variantLabel: orderItems.variantLabel,
                quantity: orderItems.quantity,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
            }).from(orderItems).where(inArray(orderItems.orderId, chunk)).orderBy(orderItems.createdAt, orderItems.id).all(),
            db.select({
                orderId: deliveryShipments.orderId,
                courierName: deliveryShipments.courierName,
                providerName: deliveryProviders.name,
                providerType: deliveryShipments.providerType,
                trackingId: deliveryShipments.trackingId,
                status: deliveryShipments.status,
            }).from(deliveryShipments)
                .leftJoin(deliveryProviders, eq(deliveryProviders.id, deliveryShipments.providerId))
                .where(inArray(deliveryShipments.orderId, chunk))
                .orderBy(deliveryShipments.createdAt, deliveryShipments.id)
                .all(),
        ]);
        const places = new Map(orderRows.map((row) => [row.id, row.currencyDecimalPlaces]));
        const parcels = new Map<string, { couriers: Set<string>; tracking: Set<string> }>();
        for (const shipment of shipmentRows) {
            if (shipment.status === ShipmentStatus.CANCELLED || shipment.status === ShipmentStatus.FAILED) continue;
            const entry = parcels.get(shipment.orderId) ?? { couriers: new Set<string>(), tracking: new Set<string>() };
            const courier = shipment.courierName?.trim() || shipment.providerName?.trim()
                || (shipment.providerType === "manual" ? "Own courier" : "");
            if (courier) entry.couriers.add(courier);
            if (shipment.trackingId?.trim()) entry.tracking.add(shipment.trackingId.trim());
            parcels.set(shipment.orderId, entry);
        }
        for (const row of orderRows) {
            const parcel = parcels.get(row.id);
            details.set(row.id, {
                shippingAddress: row.shippingAddress,
                notes: row.notes,
                courierName: parcel?.couriers.size ? [...parcel.couriers].join("; ") : null,
                trackingId: parcel?.tracking.size ? [...parcel.tracking].join("; ") : null,
                lines: [],
            });
        }
        for (const item of itemRows) {
            const decimals = places.get(item.orderId) ?? 2;
            details.get(item.orderId)?.lines.push({
                productName: item.productName,
                variantLabel: item.variantLabel,
                quantity: item.quantity,
                unitPrice: fromMinor(item.unitPriceMinor, decimals),
                lineTotal: fromMinor(item.lineSubtotalMinor, decimals),
            });
        }
    }
    return details;
}

function chunkIds(ids: readonly string[]): string[][] {
    const chunks: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += 90) chunks.push(ids.slice(offset, offset + 90));
    return chunks;
}
