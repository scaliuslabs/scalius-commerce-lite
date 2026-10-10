// The dashboard order list: views, filters, search and export details.
import { chunkForD1, type Database, getDatabaseProviderForClient, safeBatch } from "@scalius/database/client";
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
import { and, asc, sql, desc, eq, inArray, notInArray, type SQL, type SQLWrapper } from "drizzle-orm";
import { BULK_MATCHING_SLICE, matchingSliceCondition, nextMatchingCursor } from "../../../utils/bulk-matching";
import { ARCHIVABLE_ORDER_STATUSES } from "../archive-policy";
import { containsText } from "../../../utils/text-match";
import { anySetIsSmall } from "../../../utils/list-lead";
import type { CursorValueKind } from "@scalius/shared/pagination";
import {
    COUNT_PROBE_COLUMN,
    cappedCountQuery,
    cappedPagination,
    planKeysetPage,
    resolveReferencedBoundary,
} from "../../../utils/keyset";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "../../../search/fts5";
import { fromMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/utils";
import type { OrderChannel } from "@scalius/shared/order-channel";
import type { OrderBillingAddressFields, OrderPaymentRecoveryFilter, OrderShipmentSummary } from "../types";
import { orderBillingAddressFields, orderBillingAddressSelection } from "../billing-address";
import { orderNumberSearchCondition } from "../number";
import { buildPhoneSearchTerms, isEmailSearch, isLikelyPhoneSearch, phonePrefixFtsQuery } from "../../../utils/phone-search";
import { orderMoneyAmounts, orderMoneySelection } from "../money";
import { formatOrderCsvLineProperties } from "../csv-export";
import {
  paymentMethodAliases,
  type RefundAttemptVisibilityRow,
  resolveActiveRefundOperationsForOrders,
  selectActiveRefundAttemptRowsForOrders,
} from "../../payments";
import { activePaymentSessionAttemptExistsCondition } from "../../order-kernel";
import {
    onlinePaymentMethod,
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

/**
 * The sorts that walk by keyset: the sort column (read raw, exactly as the
 * ORDER BY compares it) and the type of its cursor value. `id` is the unique
 * tiebreaker. None of these columns is nullable. The customer's name is
 * personal data, so its cursors are references: they name the order and never
 * carry the name (a URL must not hold it); the name is read back by id.
 */
const ORDER_KEYSET_SORTS = {
    createdAt: { column: orders.createdAt, kind: "number" },
    updatedAt: { column: orders.updatedAt, kind: "number" },
    totalAmount: { column: orders.totalAmountMinor, kind: "number" },
    customerName: { column: orders.customerName, kind: "text", referenced: true },
    status: { column: orders.status, kind: "text" },
} as const satisfies Record<Exclude<OrderListSort, "relevance">, { column: SQLWrapper; kind: CursorValueKind; referenced?: boolean }>;
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
    const hostedMethod = onlinePaymentMethod(orders.paymentMethod);
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
    "ready_for_pickup",
] as const;
export type OrderListView = (typeof ORDER_LIST_VIEWS)[number];

/**
 * The rowids of the orders a set names (`orderIds` selects `order_id`).
 * The CROSS JOIN keeps SQLite's join order: the set first, then each order
 * by id (SQLite has no statistics to choose by).
 */
function namedOrderRowids(orderIds: SQL): SQL {
    return sql`SELECT named_order.rowid FROM (${orderIds}) AS named
        CROSS JOIN orders AS named_order ON named_order.id = named.order_id`;
}

/**
 * The orders a set names, as a condition: an indexed lookup of the set,
 * never a per-order EXISTS probe of every order. When the set is small the
 * list reads it first (`orderListLeads`).
 */
function ordersAmong(db: Database, orderIds: SQL): SQL {
    if (getDatabaseProviderForClient(db) === "postgres") {
        return sql`${orders.id} IN (SELECT named.order_id FROM (${orderIds}) AS named)`;
    }
    return sql`orders.rowid IN (${namedOrderRowids(orderIds)})`;
}

// Cash on delivery still out (`cod_tracking_status_idx`): couriers' work in flight.
function codTrackingOrderIds(statuses: readonly string[]): SQL {
    return sql`SELECT ${codTracking.orderId} AS order_id FROM ${codTracking}
        WHERE ${inArray(codTracking.codStatus, [...statuses])}`;
}

const COD_TO_COLLECT_STATUSES = [CodStatus.PENDING, CodStatus.FAILED] as const;
const COD_FAILED_STATUSES = [CodStatus.FAILED] as const;

function codTrackingStatusExists(db: Database, statuses: readonly string[]): SQL {
    return ordersAmong(db, codTrackingOrderIds(statuses));
}

// Open customer requests (the active-key index).
const openRequestOrderIds = () => sql`SELECT ${orderSupportRequests.orderId} AS order_id FROM ${orderSupportRequests}
    WHERE ${orderSupportRequests.activeKey} IS NOT NULL`;

function openCustomerRequestExists(db: Database): SQL {
    return ordersAmong(db, openRequestOrderIds());
}

/**
 * The order tabs. Each view means money or work the merchant still has, so
 * cancelled, returned and unfinished online checkouts never sit in Unpaid or
 * Unfulfilled (ORD-09); cash on delivery gets its own views (ORD-29).
 */
function orderListViewCondition(db: Database, view: OrderListView): SQL {
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
                AND ${codTrackingStatusExists(db, COD_TO_COLLECT_STATUSES)}`;
        case "delivery_failed":
            return sql`${orders.status} = ${OrderStatus.SHIPPED}
                AND ${codTrackingStatusExists(db, COD_FAILED_STATUSES)}`;
        case "returned":
            return sql`${orders.status} = ${OrderStatus.RETURNED}`;
        case "ready_for_pickup": {
            // Shopify's "Ready for pickup": marked ready, not collected yet.
            // Read from the pickup orders' own index (`orders_list_pickup_idx`):
            // SQLite's `+` keeps it off the status index, whose open orders
            // are mostly shipped ones.
            const status = getDatabaseProviderForClient(db) === "postgres" ? sql`${orders.status}` : sql`+${orders.status}`;
            return sql`${orders.shippingMethodKind} = 'pickup'
                AND ${orders.pickupReadyAt} IS NOT NULL
                AND ${orders.fulfillmentStatus} <> ${FulfillmentStatus.COMPLETE}
                AND ${status} IN (${sql.join([OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.CONFIRMED].map((value) => sql`${value}`), sql`, `)})`;
        }
    }
}

/** How the order reaches the buyer: shipped, collected, or nothing physical. */
export const ORDER_DELIVERY_METHOD_FILTERS = ["delivery", "pickup", "none"] as const;
export type OrderDeliveryMethodFilter = (typeof ORDER_DELIVERY_METHOD_FILTERS)[number];

function orderDeliveryMethodCondition(filter: OrderDeliveryMethodFilter): SQL {
    switch (filter) {
        case "delivery":
            return sql`${orders.requiresShipping} = 1`;
        case "pickup":
            return sql`${orders.shippingMethodKind} = 'pickup'`;
        case "none":
            return sql`${orders.requiresShipping} = 0 AND ${orders.shippingMethodKind} IS NULL`;
    }
}

function normalizeListPositiveInteger(value: number | undefined, fallback: number, max?: number): number {
    if (!Number.isFinite(value)) return fallback;
    const integer = Math.trunc(value as number);
    const minBounded = Math.max(1, integer);
    return max == null ? minBounded : Math.min(minBounded, max);
}

/**
 * The orders a search finds: the order number, a word of the buyer's name,
 * phone or email (`orders_fts`), a whole email, a phone written any way, or
 * the courier's consignment or tracking id. Every source is an index lookup,
 * so a search reads its matches only, never every order (a million-order
 * store). With FTS5 the sources are one union of rowids; a phone matches
 * from its start (with or without the country code), as Shopify's search does.
 */
function orderSearchCondition(db: Database, term: string): SQL {
    const rowids = orderSearchRowids(db, term);
    if (rowids) return sql`orders.rowid IN (${rowids})`;
    const parts = orderSearchParts(term);
    const matches = [
        parts.orderNumberCondition,
        parts.emailCondition ?? ftsMatch(db, "orders_fts", "orders", term),
        buildPhoneSearchCondition(parts.phoneTerms),
        parts.courierCondition,
    ].filter((condition): condition is SQL => condition !== undefined);
    return sql`(${sql.join(matches, sql` OR `)})`;
}

function orderSearchParts(term: string) {
    // A full email finds that address only: "rahim@x.com" must not also
    // find "rahima@x.com" through word matching (R2-ORD-14).
    const emailCondition = isEmailSearch(term)
        ? sql`lower(trim(${orders.customerEmail})) = lower(trim(${term}))`
        : undefined;
    return {
        orderNumberCondition: orderNumberSearchCondition(term),
        phoneTerms: isLikelyPhoneSearch(term) ? buildPhoneSearchTerms(term) : [],
        emailCondition,
        // Merchants also look orders up by the courier's consignment or tracking id.
        courierCondition: sql`${orders.id} IN (
            SELECT ${deliveryShipments.orderId} FROM ${deliveryShipments}
            WHERE lower(${deliveryShipments.trackingId}) = lower(${term})
              OR lower(${deliveryShipments.externalId}) = lower(${term})
        )`,
    };
}

/** With FTS5, the search's matching rowids: one union of index lookups. */
function orderSearchRowids(db: Database, term: string): SQL | undefined {
    if (!isFts5SearchEnabled(db)) return undefined;
    const { orderNumberCondition, phoneTerms, emailCondition, courierCondition } = orderSearchParts(term);
    const sources: SQL[] = [];
    if (orderNumberCondition) sources.push(sql`SELECT rowid FROM ${orders} WHERE ${orderNumberCondition}`);
    if (emailCondition) {
        sources.push(sql`SELECT rowid FROM ${orders} WHERE ${emailCondition}`);
    } else {
        const words = sanitizeFtsQuery(term);
        if (words) sources.push(sql`SELECT rowid FROM orders_fts WHERE orders_fts MATCH ${words}`);
    }
    if (phoneTerms.length > 0) {
        const phoneQuery = phonePrefixFtsQuery("customer_phone", phoneTerms);
        sources.push(sql`SELECT rowid FROM orders_fts WHERE orders_fts MATCH ${phoneQuery}`);
    }
    sources.push(sql`SELECT rowid FROM ${orders} WHERE ${courierCondition}`);
    return sql.join(sources, sql` UNION `);
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
        searchTerms.map((term) => containsText(normalizedCustomerPhone, term)),
        sql` OR `,
    )})`;
}

/** The order list's filters, shared by the list, its export and its "all matching" bulk actions. */
export interface OrderListFilter {
    search?: string;
    status?: string;
    view?: OrderListView;
    openRequest?: boolean;
    ids?: string[];
    paymentStatus?: string;
    paymentMethod?: string;
    fulfillmentStatus?: string;
    paymentRecovery?: OrderPaymentRecoveryFilter;
    deliveryMethod?: OrderDeliveryMethodFilter;
    channel?: OrderChannel;
    channelSource?: string;
    showArchived?: boolean;
    startDate?: Date;
    endDate?: Date;
    appCondition?: SQL;
    /**
     * Read the orders the search or the open-request filter names first,
     * then the other conditions; set when those are few (`orderListLeads`).
     */
    leadWithMatches?: boolean;
}

/**
 * Whether a list read should start from a set of orders its filter names
 * (`utils/list-lead.ts`): the search's matches, the orders with an open
 * request, or cash on delivery still out, when one of them is small.
 */
export async function orderListLeads(
    db: Database,
    filter: Pick<OrderListFilter, "search" | "openRequest" | "ids" | "view">,
): Promise<boolean> {
    if (filter.ids || getDatabaseProviderForClient(db) === "postgres") return false;
    const sets: SQL[] = [];
    const term = filter.search?.trim();
    const searchRowids = term ? orderSearchRowids(db, term) : undefined;
    if (searchRowids) sets.push(searchRowids);
    if (filter.openRequest) sets.push(openRequestOrderIds());
    if (filter.view === "cod_to_collect") sets.push(codTrackingOrderIds(COD_TO_COLLECT_STATUSES));
    if (filter.view === "delivery_failed") sets.push(codTrackingOrderIds(COD_FAILED_STATUSES));
    return anySetIsSmall(db, sets);
}

/**
 * The list's WHERE conditions and, for a search, its relevance order: one
 * definition for the rows the list shows and the rows an "all matching"
 * bulk action acts on.
 */
export function orderListConditions(db: Database, filter: OrderListFilter): { conditions: SQL[]; rankExpression: SQL | undefined } {
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
        deliveryMethod,
        channel,
        channelSource,
        showArchived = false,
        startDate,
        endDate,
    } = filter;
    const whereConditions: SQL[] = [];

    // Every list index starts with `deleted_at`: the unary `+` keeps SQLite
    // off them, so it reads the named orders by rowid instead of walking an
    // index past rows that cannot match.
    whereConditions.push(filter.leadWithMatches
        ? sql`+${orders.deletedAt} IS NULL`
        : sql`${orders.deletedAt} IS NULL`);
    if (filter.appCondition) whereConditions.push(filter.appCondition);
    if (ids) {
        // An explicit selection is exported as picked, archived or not.
        whereConditions.push(ids.length > 0 ? inArray(orders.id, ids) : sql`1 = 0`);
    } else {
        whereConditions.push(showArchived ? sql`${orders.archivedAt} IS NOT NULL` : sql`${orders.archivedAt} IS NULL`);
    }

    let rankExpression: SQL | undefined = undefined;
    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
        const orderNumberCondition = orderNumberSearchCondition(trimmedSearch);
        whereConditions.push(orderSearchCondition(db, trimmedSearch));
        // "#1001" puts that order first; the other matches read newest first.
        if (orderNumberCondition) rankExpression = sql`CASE WHEN ${orderNumberCondition} THEN 0 ELSE 1 END ASC`;
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (view) {
        whereConditions.push(orderListViewCondition(db, view));
    }

    if (openRequest) {
        whereConditions.push(openCustomerRequestExists(db));
    }

    if (paymentStatus) {
        whereConditions.push(sql`${orders.paymentStatus} = ${paymentStatus}`);
    }

    if (paymentMethod) {
        // An app gateway and the retired built-in id it replaced are one method.
        const aliases = paymentMethodAliases(paymentMethod);
        whereConditions.push(aliases.length === 1
            ? sql`${orders.paymentMethod} = ${paymentMethod}`
            : sql`${orders.paymentMethod} IN (${sql.join(aliases.map((alias) => sql`${alias}`), sql`, `)})`);
    }

    if (fulfillmentStatus) {
        whereConditions.push(sql`${orders.fulfillmentStatus} = ${fulfillmentStatus}`);
    }

    if (deliveryMethod) {
        whereConditions.push(orderDeliveryMethodCondition(deliveryMethod));
    }

    if (channel) {
        whereConditions.push(sql`${orders.channel} = ${channel}`);
    }

    if (channelSource) {
        whereConditions.push(sql`${orders.channelSource} = ${channelSource}`);
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

    return { conditions: whereConditions, rankExpression };
}

/**
 * One slice of "archive all matching orders" (`utils/bulk-matching.ts`): the
 * next `limit` orders the list's filter matches after `cursor`, in id order,
 * that archiving could take (a finished status, no live shipment claim),
 * with the version each write claims.
 */
export async function listMatchingArchivableOrders(
    db: Database,
    filter: OrderListFilter,
    cursor: string | undefined,
    limit: number = BULK_MATCHING_SLICE,
): Promise<{ claims: Array<{ id: string; expectedVersion: number }>; next: string | null }> {
    const leadWithMatches = await orderListLeads(db, { search: filter.search, openRequest: filter.openRequest, view: filter.view });
    const { conditions } = orderListConditions(db, { ...filter, showArchived: false, ids: undefined, leadWithMatches });
    const after = matchingSliceCondition(orders.id, cursor);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = await db
        .select({ id: orders.id, version: orders.version })
        .from(orders)
        .where(and(
            ...conditions,
            ...(after ? [after] : []),
            inArray(orders.status, [...ARCHIVABLE_ORDER_STATUSES]),
            sql`(${orders.shipmentClaimId} IS NULL OR ${orders.shipmentClaimExpiresAt} IS NULL OR ${orders.shipmentClaimExpiresAt} <= ${nowSeconds})`,
        ))
        .orderBy(asc(orders.id))
        .limit(limit);
    return {
        claims: rows.map((row) => ({ id: row.id, expectedVersion: row.version })),
        next: nextMatchingCursor(rows, limit),
    };
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
    deliveryMethod?: OrderDeliveryMethodFilter;
    /** Where the order came from (`orders_list_channel_idx`). */
    channel?: OrderChannel;
    /** A stored source slug (`facebook`, `walk_in`, …). */
    channelSource?: string;
    openRequest?: boolean;
    /** Exactly these orders (an export of a page or a selection). */
    ids?: string[];
    /** A numbered page; only the first `maxOffset` rows (plan limit) are reachable this way. */
    page?: number;
    limit?: number;
    /** Rows after this cursor (`pageInfo.endCursor` of the previous page). Excludes `before` and `page`. */
    after?: string;
    /** Rows before this cursor (`pageInfo.startCursor` of the next page). */
    before?: string;
    showArchived?: boolean;
    sort?: OrderListSort;
    order?: "asc" | "desc";
    startDate?: Date;
    endDate?: Date;
    /** An app column filter (plugins/list-columns.ts): an indexed match on the app's records. */
    appCondition?: SQL;
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
        deliveryMethod,
        channel,
        channelSource,
        page: rawPage = 1,
        limit: rawLimit = 10,
        after,
        before,
        showArchived = false,
        sort = "createdAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const page = normalizeListPositiveInteger(rawPage, 1);
    const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT);

    const { conditions: whereConditions, rankExpression } = orderListConditions(db, {
        search,
        status,
        view,
        openRequest,
        ids,
        paymentStatus,
        paymentMethod,
        fulfillmentStatus,
        paymentRecovery,
        deliveryMethod,
        channel,
        channelSource,
        showArchived,
        startDate,
        endDate,
        appCondition: options.appCondition,
        leadWithMatches: await orderListLeads(db, { search, openRequest, ids, view }),
    });

    const whereClause = whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined;

    // Relevance is the order number first, then newest first. An order-number
    // search ranks per row and cannot seek, so it pages by position inside
    // the first `maxOffset` matches (it matches few). Every other sort walks
    // by keyset (sort value + id), relevance without a number as newest first.
    const relevanceRanked = sort === "relevance" && rankExpression !== undefined;
    const keysetSort = sort === "relevance" ? "createdAt" : sort;
    const direction = sort === "relevance" ? "desc" : order;
    const keysetSpec = ORDER_KEYSET_SORTS[keysetSort as keyof typeof ORDER_KEYSET_SORTS] ?? ORDER_KEYSET_SORTS.updatedAt;
    const referenced = !relevanceRanked && "referenced" in keysetSpec && keysetSpec.referenced === true;
    const boundary = referenced
        ? await resolveReferencedBoundary({ after, before }, { sort: keysetSort, direction }, async (id) => {
            const [row] = await db.select({ value: sql<string>`${keysetSpec.column}` }).from(orders).where(eq(orders.id, id)).limit(1);
            return row?.value;
        })
        : undefined;
    const plan = planKeysetPage({ page, limit, after, before, boundary }, {
        sort: relevanceRanked ? "relevance" : keysetSort,
        order: { column: keysetSpec.column, id: orders.id, direction },
        kind: keysetSpec.kind,
        referenced,
        ranked: relevanceRanked
            ? [
                rankExpression!,
                // Equally good matches read newest first.
                sql`${orders.createdAt} desc`,
                sql`${orders.id} desc`,
            ]
            : undefined,
    });

    // The page's ids first, read from the sort index alone; the wide row and
    // its per-order facts are then read for those ids only. Sorting full rows
    // would compute every fact of every row tied on the sort value, and a
    // status or payment tab can tie thousands (a million-order store).
    const pageKeys = db
        .select({ id: orders.id })
        .from(orders)
        .where(plan.pageWhere(whereClause))
        .orderBy(...plan.orderBy)
        .limit(plan.fetchLimit)
        .offset(plan.offset);

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
            shippingCountryCode: orders.shippingCountryCode,
            shippingLocality: orders.shippingLocality,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            // The sort column as stored (not the CAST above): a cursor must
            // compare exactly what the ORDER BY compared.
            keysetValue: sql<number | string>`${keysetSpec.column}`.as("keyset_value"),
            ...orderListFactsSelection(),
        })
        .from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(inArray(orders.id, pageKeys))
        .orderBy(...plan.orderBy);

    // The total reads at most `countCap` + 1 rows. A cursor page also
    // counts the rows up to its cursor (same cap) so the dashboard can print
    // "51-100 of 1,000+" instead of only a total.
    const countProbe = (where: SQL | undefined) =>
        cappedCountQuery(db, db.select(COUNT_PROBE_COLUMN).from(orders).where(where).$dynamic());
    const positionWhere = plan.positionWhere(whereClause);
    const statements: unknown[] = [countProbe(whereClause), dataQuery];
    if (positionWhere) statements.push(countProbe(positionWhere));

    // Batch counts + data in a single round-trip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const batchResult = await db.batch(statements as any) as any;
    const countArr = batchResult[0] as { count: number }[];
    const fetched = batchResult[1] as ({
        id: string; customerName: string; customerPhone: string | null; customerEmail: string | null;
        customerId: string | null;
        currencyDecimalPlaces: number; totalAmountMinor: number; shippingAmountMinor: number;
        discountAmountMinor: number; paidAmountMinor: number; balanceDueMinor: number;
        subtotalAmountMinor: number;
        status: string; paymentStatus: string; paymentMethod: string | null; fulfillmentStatus: string;
        createdAt: number; updatedAt: number; version: number;
        shippingCountryCode: string | null; shippingLocality: string | null;
        city: string | null; zone: string | null; area: string | null;
        cityName: string | null; zoneName: string | null; areaName: string | null;
        shipmentClaimId: string | null; shipmentClaimExpiresAt: Date | number | string | null;
        paymentRecoveryApplicable: number;
        keysetValue: number | string;
    } & OrderListFactsRow)[];
    const { rows: results, pageInfo, pageStart } = plan.finish(fetched, batchResult[2]?.[0]?.count);

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
            keysetValue: _keysetValue,
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
        pagination: cappedPagination(countArr[0]?.count ?? 0, pageStart, limit),
        pageInfo,
    };
}

/** Address, note and line items for an export page (at most 90 orders per read). */
export async function loadOrderExportDetails(db: Database, orderIds: readonly string[]) {
    const details = new Map<string, {
        shippingAddress: string | null;
        shippingAddressLine2: string | null;
        shippingDependentLocality: string | null;
        shippingAdminArea: string | null;
        shippingPostalCode: string | null;
        /** The billing snapshot (0119). */
        billing: OrderBillingAddressFields;
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
            /** Buyer inputs as "Engraving: Anika (+৳200)". */
            properties: string[];
        }>;
    }>();
    for (const chunk of chunkForD1(orderIds)) {
        const [orderRows, itemRows, shipmentRows] = await Promise.all([
            db.select({
                id: orders.id,
                shippingAddress: orders.shippingAddress,
                shippingAddressLine2: orders.shippingAddressLine2,
                shippingDependentLocality: orders.shippingDependentLocality,
                shippingAdminArea: orders.shippingAdminArea,
                shippingPostalCode: orders.shippingPostalCode,
                ...orderBillingAddressSelection(orders),
                notes: orders.notes,
                currencyCode: orders.currencyCode,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
            }).from(orders).where(inArray(orders.id, chunk)).all(),
            db.select({
                orderId: orderItems.orderId,
                productName: orderItems.productName,
                variantLabel: orderItems.variantLabel,
                quantity: orderItems.quantity,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
                properties: orderItems.properties,
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
        const currencies = new Map(orderRows.map((row) => [row.id, row]));
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
                shippingAddressLine2: row.shippingAddressLine2,
                shippingDependentLocality: row.shippingDependentLocality,
                shippingAdminArea: row.shippingAdminArea,
                shippingPostalCode: row.shippingPostalCode,
                billing: orderBillingAddressFields(row),
                notes: row.notes,
                courierName: parcel?.couriers.size ? [...parcel.couriers].join("; ") : null,
                trackingId: parcel?.tracking.size ? [...parcel.tracking].join("; ") : null,
                lines: [],
            });
        }
        for (const item of itemRows) {
            const currency = currencies.get(item.orderId);
            const decimals = currency?.currencyDecimalPlaces ?? 2;
            details.get(item.orderId)?.lines.push({
                productName: item.productName,
                variantLabel: item.variantLabel,
                quantity: item.quantity,
                unitPrice: fromMinor(item.unitPriceMinor, decimals),
                lineTotal: fromMinor(item.lineSubtotalMinor, decimals),
                properties: formatOrderCsvLineProperties(item.properties, currency?.currencyCode ?? "BDT", decimals),
            });
        }
    }
    return details;
}

