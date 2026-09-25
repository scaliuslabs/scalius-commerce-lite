// Automatic fulfilment (Wave A §2.6): digital and gift-card lines are handed
// over by the system once payment settles. Wave A ships the seam — the
// registry lookup, the idempotent job and the sweep — with no automatic
// fulfiller registered, so every run is a no-op until Wave B adds them.
import { safeBatch, type Database } from "@scalius/database/client";
import { orderItems, orders, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
    AUTO_FULFILLMENT_TYPES,
    isFulfillmentType,
    type FulfillmentType,
} from "@scalius/shared/fulfilment";
import { nanoid } from "nanoid";
import { autoFulfillerFor, FULFILLER_REGISTRY, type FulfillerRegistry } from "./registry";
import { buildFulfilmentInsertStatements, deriveOrderFulfilmentStatus } from "./ledger";
import { applyOrderStatusChange } from "../orders/status/lifecycle";
import { checkoutDocument, type AutoFulfilMode } from "../settings/documents";

/** Queue message: hand an order's automatic lines over (ids only, no buyer data). */
export interface OrderAutoFulfilQueueMessage {
    type: "order.auto_fulfil";
    orderId: string;
}

const SETTLED_PAYMENT_STATUSES = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED];
const CLOSED_ORDER_STATUSES = [
    OrderStatus.CANCELLED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
    OrderStatus.INCOMPLETE,
];
/**
 * Staff confirmed the order: settling a payment never moves an order past
 * `pending` (an incomplete order becomes `pending`), so `confirmed` or any
 * later handover status is a staff decision. `processing` still precedes
 * confirmation (processing → confirmed).
 */
const STAFF_CONFIRMED_ORDER_STATUSES = [
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.COMPLETED,
];

export interface AutoFulfilResult {
    orderId: string;
    /** Types handed over in this run. */
    fulfilledTypes: FulfillmentType[];
    /** Auto types still waiting: no fulfiller registered (fails closed). */
    unavailableTypes: FulfillmentType[];
    /** `awaiting_confirmation`: the store hands over only after staff confirm the order. */
    skipped: "no_auto_lines" | "unsettled" | "closed" | "awaiting_confirmation" | null;
    delivered: boolean;
}

/**
 * The store's delivery timing (`checkout.autoFulfilMode`). A stored document
 * that fails validation waits for staff confirmation: keys and codes are
 * never handed over on a guess. A failed read throws (the job retries).
 */
async function readAutoFulfilMode(db: Database): Promise<AutoFulfilMode> {
    const { value, invalid } = await checkoutDocument.readDetailed(db);
    return invalid ? "after_confirmation" : value.autoFulfilMode;
}

/**
 * Hands every settled order's automatic lines over, idempotently: one
 * fulfilment per type (request key `auto:<type>`), whose unique index makes
 * retries and concurrent queue deliveries safe. Only after settlement (F10),
 * and in `after_confirmation` mode only once staff confirmed the order.
 */
export async function autoFulfilOrder(
    db: Database,
    orderId: string,
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
): Promise<AutoFulfilResult> {
    const result: AutoFulfilResult = { orderId, fulfilledTypes: [], unavailableTypes: [], skipped: null, delivered: false };
    const order = await db.select({
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        deletedAt: orders.deletedAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order || order.deletedAt || (CLOSED_ORDER_STATUSES as string[]).includes(order.status)) {
        return { ...result, skipped: "closed" };
    }
    const items = await db.select({
        id: orderItems.id,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        fulfilledQuantity: orderItems.fulfilledQuantity,
        fulfillmentType: orderItems.fulfillmentType,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id)).all();
    const pending = items.filter((item) =>
        isFulfillmentType(item.fulfillmentType)
        && (AUTO_FULFILLMENT_TYPES as readonly string[]).includes(item.fulfillmentType)
        && item.fulfilledQuantity < item.quantity);
    if (pending.length === 0) return { ...result, skipped: "no_auto_lines" };
    if (!(SETTLED_PAYMENT_STATUSES as string[]).includes(order.paymentStatus)) {
        return { ...result, skipped: "unsettled" };
    }
    // With no fulfiller for any pending type there is nothing to time.
    const deliverable = pending.some((item) => autoFulfillerFor(item.fulfillmentType as FulfillmentType, registry));
    if (
        deliverable
        && await readAutoFulfilMode(db) === "after_confirmation"
        && !(STAFF_CONFIRMED_ORDER_STATUSES as string[]).includes(order.status)
    ) {
        return { ...result, skipped: "awaiting_confirmation" };
    }

    const fulfilledAfter = new Map(items.map((item) => [item.id, item.fulfilledQuantity]));
    for (const type of AUTO_FULFILLMENT_TYPES) {
        const lines = pending.filter((item) => item.fulfillmentType === type);
        if (lines.length === 0) continue;
        const fulfiller = autoFulfillerFor(type, registry);
        if (!fulfiller) {
            result.unavailableTypes.push(type);
            continue;
        }
        const fulfillmentId = `ful_${nanoid(16)}`;
        const context = {
            orderId,
            fulfillmentId,
            lines: lines.map((item) => ({
                orderItemId: item.id,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity - item.fulfilledQuantity,
            })),
        };
        for (const line of context.lines) {
            fulfilledAfter.set(line.orderItemId, (fulfilledAfter.get(line.orderItemId) ?? 0) + line.quantity);
        }
        const nextFulfillmentStatus = deriveOrderFulfilmentStatus(items.map((item) => ({
            quantity: item.quantity,
            fulfilledQuantity: fulfilledAfter.get(item.id) ?? item.fulfilledQuantity,
        })));
        const statements: BatchItem<"sqlite">[] = [
            // The ledger rows first: their unique request key makes a
            // concurrent or repeated run fail here before any delivery.
            ...buildFulfilmentInsertStatements(db, {
                fulfillmentId,
                orderId,
                kind: type,
                requestKey: `auto:${type}`,
                actor: { type: "system", id: null },
                lines: context.lines,
            }),
            ...await fulfiller.prepare(db, context),
            db.update(orders).set({
                fulfillmentStatus: nextFulfillmentStatus,
                updatedAt: sql`unixepoch()`,
            }).where(eq(orders.id, orderId)) as BatchItem<"sqlite">,
        ];
        try {
            await safeBatch(db, statements);
            result.fulfilledTypes.push(type);
        } catch (error) {
            const message = error instanceof Error ? error.message : "";
            // Another run already handed this type over.
            if (
                message.includes("order_fulfillments_order_request_key_unique")
                || message.includes("order_fulfillments.order_id, order_fulfillments.request_key")
            ) continue;
            throw error;
        }
    }

    // A digital-only order is delivered once everything is handed over
    // (two validated transitions); an order with manual lines waits for them.
    const everythingHandedOver = items.every((item) => (fulfilledAfter.get(item.id) ?? 0) >= item.quantity);
    if (result.fulfilledTypes.length > 0 && everythingHandedOver) {
        const current = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
        if (current && (current.status === OrderStatus.PENDING || current.status === OrderStatus.PROCESSING)) {
            await applyOrderStatusChange(db, orderId, OrderStatus.CONFIRMED, undefined, { generic: false });
        }
        if (current && current.status !== OrderStatus.DELIVERED && current.status !== OrderStatus.COMPLETED) {
            await applyOrderStatusChange(db, orderId, OrderStatus.DELIVERED, undefined, { generic: false });
            result.delivered = true;
        }
    }
    return result;
}

/** At most this many orders per sweep (Wave B §11.3), run sequentially. */
export const AUTO_FULFIL_SWEEP_LIMIT = 50;

/**
 * The partial index `order_items_auto_pending_idx` predicate, written out
 * literally: SQLite uses a partial index only when the query's WHERE contains
 * its terms as written (bound parameters never match). Keep it identical to
 * the index and to `AUTO_FULFILLMENT_TYPES`.
 */
const AUTO_PENDING_LINE = sql`${orderItems.fulfillmentType} IN ('digital', 'gift_card') AND ${orderItems.fulfilledQuantity} < ${orderItems.quantity}`;

/**
 * The 15-minute backstop: settled, open orders with automatic lines not
 * handed over yet (and, in `after_confirmation` mode, confirmed by staff).
 * Driven from the partial index of owed automatic lines, so it never visits
 * the store's settled order history. Each is then run through `autoFulfilOrder`.
 */
export async function listOrdersAwaitingAutoFulfil(
    db: Database,
    limit = AUTO_FULFIL_SWEEP_LIMIT,
    mode?: AutoFulfilMode,
): Promise<string[]> {
    const autoFulfilMode = mode ?? await readAutoFulfilMode(db);
    const rows = await db.selectDistinct({ id: orderItems.orderId })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(
            AUTO_PENDING_LINE,
            inArray(orders.paymentStatus, SETTLED_PAYMENT_STATUSES),
            notInArray(orders.status, CLOSED_ORDER_STATUSES),
            isNull(orders.deletedAt),
            autoFulfilMode === "after_confirmation"
                ? inArray(orders.status, STAFF_CONFIRMED_ORDER_STATUSES)
                : undefined,
        ))
        .orderBy(asc(orderItems.orderId))
        .limit(Math.max(1, Math.min(limit, AUTO_FULFIL_SWEEP_LIMIT)))
        .all();
    return rows.map((row) => row.id);
}

/** Runs the sweep sequentially (bounded D1 concurrency); failures are per order. */
export async function sweepAutoFulfilment(
    db: Database,
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
): Promise<{ scanned: number; fulfilled: number; failed: number }> {
    // Nothing can be handed over without a registered automatic fulfiller.
    if (!AUTO_FULFILLMENT_TYPES.some((type) => autoFulfillerFor(type, registry))) {
        return { scanned: 0, fulfilled: 0, failed: 0 };
    }
    const orderIds = await listOrdersAwaitingAutoFulfil(db);
    let fulfilled = 0;
    let failed = 0;
    for (const orderId of orderIds) {
        try {
            const result = await autoFulfilOrder(db, orderId, registry);
            if (result.fulfilledTypes.length > 0) fulfilled += 1;
        } catch (error) {
            failed += 1;
            console.error(`[auto-fulfil] order ${orderId.slice(0, 12)} failed:`, error instanceof Error ? error.message : "unknown error");
        }
    }
    return { scanned: orderIds.length, fulfilled, failed };
}
