// Automatic fulfilment: hand over eligible digital and gift-card units
// with their ledger, entitlements, cards and notifications in one batch.
// Preparation does no handover; the batch rechecks the authority it read.
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { orderItems, orderPayments, orderRefundLines, orderRefunds, orderWithheldUnits, orders, settings, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
    AUTO_FULFILLMENT_TYPES,
    isFulfillmentType,
    type FulfillmentType,
} from "@scalius/shared/fulfilment";
import { nanoid } from "nanoid";
import { sha256Hex } from "@scalius/shared/hash";
import {
    AutoFulfilLinesOwedError,
    autoFulfillerFor,
    FULFILLER_REGISTRY,
    type AutoFulfilLine,
    type AutoFulfilRuntime,
    type FulfillerRegistry,
} from "./registry";
import { buildFulfilmentInsertStatements, orderFulfilmentStatusSql } from "./ledger";
import { applyOrderStatusChange, listOrderHolds, noOpenOrderHoldCondition } from "../orders";
import { awaitingAppHoldDecision } from "./hold-window";
import { type AutoFulfilMode, checkoutDocument } from "../settings";
import { noActiveRefundAttemptForOrderIdCondition } from "../order-kernel";
import { DIGITAL_KEYS_EXHAUSTED } from "../digital";
import { ConflictError } from "../../errors";
import { qualifiedColumn } from "../../utils/qualified-column";

const ORDER_ON_HOLD = "AUTO_FULFIL_ORDER_ON_HOLD";
const ELIGIBILITY_CHANGED = "AUTO_FULFIL_ELIGIBILITY_CHANGED";
const SETTLED_PAYMENT_STATUSES = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED];
const CLOSED_ORDER_STATUSES = [
    OrderStatus.CANCELLED,
    OrderStatus.RETURNED,
    OrderStatus.REFUNDED,
    OrderStatus.INCOMPLETE,
];
/** The payment and order states automatic handover needs; a grant of digital access needs the same (`digital-access.ts`). */
export { SETTLED_PAYMENT_STATUSES as AUTO_HANDOVER_SETTLED_PAYMENT_STATUSES, CLOSED_ORDER_STATUSES as AUTO_HANDOVER_CLOSED_ORDER_STATUSES };
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

/** Completed money and claimed line units are separate facts: amount-only refunds name no units. */
function refundedAmountSql(orderId: string) {
    return sql<number>`(SELECT coalesce(sum(${orderPayments.amountMinor}), 0) FROM ${orderPayments}
        WHERE ${orderPayments.orderId} = ${orderId} AND ${orderPayments.paymentType} = 'refund'
          AND ${orderPayments.status} = 'refunded')`;
}

function refundedLineQuantitySql() {
    return sql<number>`(SELECT coalesce(sum(${qualifiedColumn(orderRefundLines.quantity)}), 0) FROM ${orderRefundLines}
        INNER JOIN ${orderRefunds} ON ${qualifiedColumn(orderRefunds.id)} = ${qualifiedColumn(orderRefundLines.refundId)}
        WHERE ${qualifiedColumn(orderRefundLines.orderItemId)} = ${qualifiedColumn(orderItems.id)}
          AND ${qualifiedColumn(orderRefunds.status)} <> 'failed')
      + (SELECT coalesce(sum(${qualifiedColumn(orderWithheldUnits.quantity)}), 0) FROM ${orderWithheldUnits}
        WHERE ${qualifiedColumn(orderWithheldUnits.orderItemId)} = ${qualifiedColumn(orderItems.id)})`;
}

/**
 * A failed refund can restore owed units, including an entire line omitted
 * from preparation; and a concurrent handover of the same units (whose
 * request key may differ) moves the handed-over quantity. Either refuses.
 */
function autoLineObligationsUnchangedCondition(
    orderId: string,
    type: FulfillmentType,
    lines: readonly { id: string; quantity: number; refundedQuantity: number; fulfilledQuantity: number }[],
) {
    const snapshot = JSON.stringify(lines.map(({ id, quantity, refundedQuantity, fulfilledQuantity }) => ({ id, quantity, refundedQuantity, fulfilledQuantity })));
    return sql`(SELECT count(*) FROM ${orderItems}
        WHERE ${orderItems.orderId} = ${orderId} AND ${orderItems.fulfillmentType} = ${type}) = ${lines.length}
        AND NOT EXISTS (SELECT 1 FROM json_each(${snapshot}) AS expected
            WHERE NOT EXISTS (SELECT 1 FROM ${orderItems}
                WHERE ${orderItems.orderId} = ${orderId}
                  AND ${orderItems.fulfillmentType} = ${type}
                  AND ${orderItems.id} = json_extract(expected.value, '$.id')
                  AND ${orderItems.quantity} = CAST(json_extract(expected.value, '$.quantity') AS INTEGER)
                  AND ${orderItems.fulfilledQuantity} = CAST(json_extract(expected.value, '$.fulfilledQuantity') AS INTEGER)
                  AND ${refundedLineQuantitySql()} = CAST(json_extract(expected.value, '$.refundedQuantity') AS INTEGER)))`;
}

export interface AutoFulfilResult {
    orderId: string;
    /** Types handed over in this run. */
    fulfilledTypes: FulfillmentType[];
    /** Auto types still waiting: no fulfiller registered (fails closed). */
    unavailableTypes: FulfillmentType[];
    /** `awaiting_confirmation`: the store hands over only after staff confirm the order. */
    /** `on_hold`: staff review an app's hold; the sweep hands it over once released. */
    /** `hold_window`: an app that may hold the order has not seen it yet (hold-window.ts). */
    skipped: "no_auto_lines" | "unsettled" | "closed" | "awaiting_confirmation" | "on_hold" | "hold_window" | null;
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
 * The request key of one handover: its type and exactly the units it hands
 * over (each line with the quantity already handed over before it). Two runs
 * that read the same owed units collide on the unique index; a later run for
 * the lines left owed gets its own key.
 */
async function autoRequestKey(
    type: FulfillmentType,
    lines: readonly AutoFulfilLine[],
    fulfilledBefore: ReadonlyMap<string, number>,
): Promise<string> {
    const units = lines.map((line) => [line.orderItemId, fulfilledBefore.get(line.orderItemId) ?? 0, line.quantity]);
    return `auto:${type}:${(await sha256Hex(JSON.stringify(units))).slice(0, 40)}`;
}

/**
 * Hands every settled order's automatic lines over, idempotently: per type,
 * one fulfilment for the lines that can be handed over now (its request key
 * names them, and the unique index makes retries and concurrent runs safe).
 * A line that cannot be handed over yet (no file ready, a short key pool, a
 * card with no value) stays owed with a staff alert; the sweep retries only
 * what is missing. Only after settlement (F10), and in `after_confirmation`
 * mode only once staff confirmed the order.
 */
export async function autoFulfilOrder(
    db: Database,
    orderId: string,
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
    runtime: AutoFulfilRuntime = {},
): Promise<AutoFulfilResult> {
    const result: AutoFulfilResult = { orderId, fulfilledTypes: [], unavailableTypes: [], skipped: null, delivered: false };
    const order = await db.select({
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paidAmountMinor: orders.paidAmountMinor,
        refundedAmountMinor: refundedAmountSql(orderId),
        deletedAt: orders.deletedAt,
        createdAt: orders.createdAt,
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
        refundedQuantity: refundedLineQuantitySql(),
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id)).all();
    const pending = items.filter((item) =>
        isFulfillmentType(item.fulfillmentType)
        && (AUTO_FULFILLMENT_TYPES as readonly string[]).includes(item.fulfillmentType)
        && item.fulfilledQuantity < item.quantity - item.refundedQuantity);
    if (pending.length === 0) return { ...result, skipped: "no_auto_lines" };
    if (!(SETTLED_PAYMENT_STATUSES as string[]).includes(order.paymentStatus)) {
        return { ...result, skipped: "unsettled" };
    }
    // With no fulfiller for any pending type there is nothing to time.
    const deliverable = pending.some((item) => autoFulfillerFor(item.fulfillmentType as FulfillmentType, registry));
    const timing = deliverable ? await checkoutDocument.readDetailed(db, {}, { skipCache: true }) : null;
    const requiresConfirmation = timing?.invalid || timing?.value.autoFulfilMode === "after_confirmation";
    if (
        deliverable
        && requiresConfirmation
        && !(STAFF_CONFIRMED_ORDER_STATUSES as string[]).includes(order.status)
    ) {
        return { ...result, skipped: "awaiting_confirmation" };
    }
    if ((await listOrderHolds(db, [orderId])).get(orderId)?.some((hold) => hold.releasedAt === null)) {
        return { ...result, skipped: "on_hold" };
    }
    if (deliverable && await awaitingAppHoldDecision(db, orderId, Math.floor(order.createdAt.getTime() / 1000))) {
        return { ...result, skipped: "hold_window" };
    }

    const fulfilledAfter = new Map(items.map((item) => [item.id, item.fulfilledQuantity]));
    // One type that can't be handed over (a download with no file yet) never
    // keeps the others back: a gift card still goes out. The first failure is
    // raised once the rest are done, so the sweep retries it.
    let firstFailure: unknown = null;
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
            credentialEncryptionKey: runtime.credentialEncryptionKey,
            lines: lines.map((item) => ({
                orderItemId: item.id,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity - item.refundedQuantity - item.fulfilledQuantity,
            })),
        };
        let prepared: Awaited<ReturnType<typeof fulfiller.prepare>>;
        try {
            prepared = await fulfiller.prepare(db, context);
        } catch (error) {
            firstFailure ??= error;
            continue;
        }
        const preparation = Array.isArray(prepared)
            ? { statements: prepared, deliveredLineIds: context.lines.map((line) => line.orderItemId), owedReason: undefined }
            : prepared;
        const deliveredIds = new Set(preparation.deliveredLineIds);
        const deliveredLines = context.lines.filter((line) => deliveredIds.has(line.orderItemId));
        if (deliveredLines.length < context.lines.length) {
            const owed = context.lines.filter((line) => !deliveredIds.has(line.orderItemId)).map((line) => line.orderItemId);
            firstFailure ??= new AutoFulfilLinesOwedError(type, owed, preparation.owedReason);
        }
        if (deliveredLines.length === 0) continue;
        const afterThis = new Map(fulfilledAfter);
        for (const line of deliveredLines) {
            afterThis.set(line.orderItemId, (afterThis.get(line.orderItemId) ?? 0) + line.quantity);
        }
        const statements: BatchItem<"sqlite">[] = [
            // A hold that committed since the check above wins: the batch
            // stops before anything is handed over.
            buildBatchGuard(db, noOpenOrderHoldCondition(orderId), ORDER_ON_HOLD) as BatchItem<"sqlite">,
            // Preparation may await files, licence keys or encryption. Every
            // authority that permitted handover must still hold at commit.
            buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${orders}
                WHERE ${orders.id} = ${orderId}
                  AND ${isNull(orders.deletedAt)}
                  AND ${notInArray(orders.status, CLOSED_ORDER_STATUSES)}
                  AND ${inArray(orders.paymentStatus, SETTLED_PAYMENT_STATUSES)}
                  AND ${orders.paymentStatus} = ${order.paymentStatus}
                  AND ${orders.paidAmountMinor} = ${order.paidAmountMinor}
                  AND ${refundedAmountSql(orderId)} = ${order.refundedAmountMinor}
                  AND ${autoLineObligationsUnchangedCondition(orderId, type, items.filter((item) => item.fulfillmentType === type))}
                  AND ${requiresConfirmation ? inArray(orders.status, STAFF_CONFIRMED_ORDER_STATUSES) : sql`1 = 1`}
                  AND ${noActiveRefundAttemptForOrderIdCondition(orderId)}
            ) AND coalesce((SELECT ${settings.revision} FROM ${settings}
                WHERE ${settings.category} = ${checkoutDocument.key} AND ${settings.key} = 'document'), 0) = ${timing?.revision ?? 0}`,
            ELIGIBILITY_CHANGED),
            // The ledger rows next: their unique request key makes a
            // concurrent or repeated run fail here before any delivery.
            ...buildFulfilmentInsertStatements(db, {
                fulfillmentId,
                orderId,
                kind: type,
                requestKey: await autoRequestKey(type, deliveredLines, fulfilledAfter),
                actor: { type: "system", id: null },
                lines: deliveredLines,
            }),
            ...preparation.statements,
            db.update(orders).set({
                fulfillmentStatus: orderFulfilmentStatusSql(orderId),
                version: sql`${orders.version} + 1`,
                updatedAt: sql`unixepoch()`,
            }).where(eq(orders.id, orderId)) as BatchItem<"sqlite">,
        ];
        try {
            await safeBatch(db, statements);
            result.fulfilledTypes.push(type);
            for (const [id, quantity] of afterThis) fulfilledAfter.set(id, quantity);
        } catch (error) {
            if (isBatchGuardError(error, ORDER_ON_HOLD)) {
                // Types handed over earlier in this run stay handed over; the rest wait for staff.
                return { ...result, skipped: result.fulfilledTypes.length > 0 ? null : "on_hold" };
            }
            if (isBatchGuardError(error, ELIGIBILITY_CHANGED)) {
                throw new ConflictError("The order or its delivery settings changed before handover. Please retry.");
            }
            // A licence-key pool ran out between the plan and the batch: these
            // lines stay owed, as a pool short at plan time leaves them.
            if (isBatchGuardError(error, DIGITAL_KEYS_EXHAUSTED)) {
                firstFailure ??= new AutoFulfilLinesOwedError(
                    type,
                    deliveredLines.map((line) => line.orderItemId),
                    `${DIGITAL_KEYS_EXHAUSTED}: licence keys ran out before ${deliveredLines.length} digital line(s) were handed over`,
                );
                continue;
            }
            const message = error instanceof Error ? error.message : "";
            // Another run already handed these units over.
            if (
                message.includes("order_fulfillments_order_request_key_unique")
                || message.includes("order_fulfillments.order_id, order_fulfillments.request_key")
            ) {
                for (const [id, quantity] of afterThis) fulfilledAfter.set(id, quantity);
                continue;
            }
            firstFailure ??= error;
        }
    }
    if (firstFailure !== null) throw firstFailure;

    // A digital-only order is delivered once everything is handed over
    // (two validated transitions); an order with manual lines waits for them.
    const everythingHandedOver = items.every((item) => (fulfilledAfter.get(item.id) ?? 0) >= item.quantity - item.refundedQuantity);
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
    afterOrderId?: string,
): Promise<string[]> {
    const autoFulfilMode = mode ?? await readAutoFulfilMode(db);
    // The owed lines' partial index drives the read; the unary `+` keeps the
    // order's columns off every orders index (deleted_at, payment_status and
    // status lead indexes over the whole settled history).
    const orderIn = (column: typeof orders.paymentStatus | typeof orders.status, values: readonly string[]) =>
        sql`+${column} IN (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
    const rows = await db.selectDistinct({ id: orderItems.orderId })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(
            AUTO_PENDING_LINE,
            sql`${orderItems.fulfilledQuantity} < ${orderItems.quantity} - ${refundedLineQuantitySql()}`,
            afterOrderId ? gt(orderItems.orderId, afterOrderId) : undefined,
            orderIn(orders.paymentStatus, SETTLED_PAYMENT_STATUSES),
            notInArray(orders.status, CLOSED_ORDER_STATUSES),
            sql`+${orders.deletedAt} IS NULL`,
            autoFulfilMode === "after_confirmation"
                ? orderIn(orders.status, STAFF_CONFIRMED_ORDER_STATUSES)
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
    runtime: AutoFulfilRuntime = {},
    page: { limit?: number; afterOrderId?: string } = {},
): Promise<{ scanned: number; fulfilled: number; failed: number; lastOrderId: string | null }> {
    // Nothing can be handed over without a registered automatic fulfiller.
    if (!AUTO_FULFILLMENT_TYPES.some((type) => autoFulfillerFor(type, registry))) {
        return { scanned: 0, fulfilled: 0, failed: 0, lastOrderId: null };
    }
    const orderIds = await listOrdersAwaitingAutoFulfil(db, page.limit, undefined, page.afterOrderId);
    let fulfilled = 0;
    let failed = 0;
    for (const orderId of orderIds) {
        try {
            const result = await autoFulfilOrder(db, orderId, registry, runtime);
            if (result.fulfilledTypes.length > 0) fulfilled += 1;
        } catch (error) {
            failed += 1;
            console.error(`[auto-fulfil] order ${orderId.slice(0, 12)} failed:`, error instanceof Error ? error.message : "unknown error");
        }
    }
    return { scanned: orderIds.length, fulfilled, failed, lastOrderId: orderIds.at(-1) ?? null };
}
