// The order status kernel: validated status changes, inventory reconciliation, COD gates and cancel guards. Fulfilment actions call it.
import { buildBatchGuard, chunkForD1, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { buildOrderEventInsert, newOrderEventId, orderEventIdForRequest, type OrderEventKind } from "../timeline";
import {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardReleaseStatements,
    listHeldGiftCardTenders,
    type HeldGiftCardTender,
} from "../../gift-cards";
import {
    orders,
    orderItems,
    orderEvents,
    codTracking,
    deliveryShipments,
    CodStatus,
    OrderStatus,
    PaymentMethod,
    PaymentRecordStatus,
    PaymentStatus,
    ShipmentStatus,
    orderPayments,
} from "@scalius/database/schema";
import {
    applyInventoryForStatusChangeWithImpact,
    isOrderInventoryConflictError,
    prepareInventoryForStatusChange,
} from "../../inventory";
import {
  ACTIVE_PAYMENT_SESSION_SETUP_MESSAGE,
  ORDER_REFUND_MUTATION_BLOCKED_MESSAGE,
  SHIPMENT_CLAIM_CONFLICT_MESSAGE,
  activePaymentSessionAttemptExistsCondition,
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  assertNoActiveShipmentClaim,
  hasActiveShipmentClaim,
  noActivePaymentSessionAttemptForOrderIdCondition,
  noActiveRefundAttemptForOrderColumnCondition,
  noActiveRefundAttemptForOrderIdCondition,
  noActiveShipmentClaimCondition,
  validateTransition,
  shipmentClaimShipmentStatusSql,
} from "../../order-kernel";
import { sql, eq, and, inArray, type SQL } from "drizzle-orm";
import { AppError, NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import {
    canProcessOrderCodAction,
    normalizeOrderStatus,
    type OrderCodAction,
} from "@scalius/shared/order-state";
import {
  assertOrderPaymentCurrency,
  deriveOrderPaymentState,
  isCODCollectionConflictError,
  type OrderCurrencySnapshot,
  resolveOrderCurrencySnapshot,
} from "../../payments";
import type { StatusUpdateResult } from "../types";
import {
    buildOrderNotificationOutboxInsert,
    buildOrderStatusNotificationDedupeKey,
    type OrderNotificationType,
} from "../../notifications";
import { assertGenericAdminOrderStatusTransition } from "./policy";
import { assertOrderNotOnHold, noOpenOrderHoldCondition } from "../holds";
import { inJsonArray } from "../../../utils/in-json-array";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Brings an order's stock in line with `status` (its own batch); the SKUs whose buyer availability changed. */
export async function reconcileInventoryForStatus(
    db: Database,
    orderId: string,
    status: string,
): Promise<string[]> {
    const impact = await applyInventoryForStatusChangeWithImpact(db, orderId, status);
    return impact.availabilityTransitionVariantIds;
}

const CANCELLATION_REQUIRES_REFUND_MESSAGE =
    "This order has been paid. Refund the payment first, then cancel.";
const CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION_MESSAGE =
    "A payment for this order is still being processed. Check the payment before cancelling.";

/** Historical captures remain succeeded after a refund; only their net money or an unfinished payment blocks cancellation. */
function cancellationPaymentRecordsSafeCondition(orderId: string): SQL {
    return sql`
        NOT EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} IN (
                  ${PaymentRecordStatus.PENDING},
                  ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED}
              )
        )
        AND (SELECT coalesce(sum(CASE
            WHEN ${orderPayments.paymentType} <> 'refund' AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
              THEN ${orderPayments.amountMinor}
            WHEN ${orderPayments.paymentType} = 'refund' AND ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED}
              THEN -${orderPayments.amountMinor}
            ELSE 0 END), 0)
            FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId}) = 0
    `;
}

function noUnsafeCancellationPaymentCondition(orderId: string): SQL {
    return sql`${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})
        AND ${orders.paidAmountMinor} = 0
        AND ${cancellationPaymentRecordsSafeCondition(orderId)}`;
}

async function assertGenericCancellationPaymentSafe(
    db: Database,
    orderId: string,
    payment: { paymentStatus: string; paidAmountMinor: number },
): Promise<void> {
    const hasSafeOrderPaymentStatus =
        payment.paymentStatus === PaymentStatus.UNPAID
        || payment.paymentStatus === PaymentStatus.FAILED;
    if (
        !hasSafeOrderPaymentStatus
        || payment.paidAmountMinor !== 0
    ) {
        throw new ValidationError(CANCELLATION_REQUIRES_REFUND_MESSAGE);
    }

    const unsafePayment = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(and(
            eq(orderPayments.orderId, orderId),
            sql`NOT (${cancellationPaymentRecordsSafeCondition(orderId)})`,
        ))
        .get();
    if (unsafePayment) {
        throw new ValidationError(CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION_MESSAGE);
    }
}

// ─────────────────────────────────────────
// Gift-card tender on cancel (Wave B §4.3, G4)
// ─────────────────────────────────────────

const GIFT_CARD_CANCEL_RELEASE_CONFLICT = "gift_card_cancel_release_conflict";

/**
 * The money on the order is gift-card tender only (no gateway or cash was
 * taken, and nothing else is pending): the held tenders, which cancelling
 * gives back. Null when the order has no gift-card money, or other money too
 * (that goes through the refund flow first).
 */
export async function giftCardOnlyTenders(
    db: Database,
    orderId: string,
    payment: { paymentStatus: string; paidAmountMinor: number },
): Promise<HeldGiftCardTender[] | null> {
    if (payment.paidAmountMinor <= 0) return null;
    if (payment.paymentStatus !== PaymentStatus.PAID && payment.paymentStatus !== PaymentStatus.PARTIAL) return null;
    // One read: the succeeded gift-card tender, and any other money in flight or taken.
    const money = await db
        .select({
            giftCardMinor: sql<number>`coalesce(sum(CASE
                WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
                 AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
                THEN ${orderPayments.amountMinor} ELSE 0 END), 0)`,
            otherRows: sql<number>`coalesce(sum(CASE
                WHEN ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
                 AND ${orderPayments.status} IN (
                     ${PaymentRecordStatus.PENDING},
                     ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED},
                     ${PaymentRecordStatus.SUCCEEDED}
                 )
                THEN 1 ELSE 0 END), 0)`,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId))
        .get();
    if (!money || Number(money.otherRows) > 0 || Number(money.giftCardMinor) !== payment.paidAmountMinor) return null;
    const tenders = await listHeldGiftCardTenders(db, orderId);
    const heldMinor = tenders.reduce((total, tender) => total + tender.amountMinor, 0);
    return heldMinor === payment.paidAmountMinor ? tenders : null;
}

/** The CAS twin of `giftCardOnlyTenders`: still exactly this gift-card money and nothing else. */
function giftCardOnlyCancellationPaymentCondition(orderId: string, paidAmountMinor: number): SQL {
    return sql`
        ${orders.paymentStatus} IN (${PaymentStatus.PAID}, ${PaymentStatus.PARTIAL})
        AND ${orders.paidAmountMinor} = ${paidAmountMinor}
        AND NOT EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
              AND ${orderPayments.status} IN (
                  ${PaymentRecordStatus.PENDING},
                  ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED},
                  ${PaymentRecordStatus.SUCCEEDED}
              )
        )
        AND ${paidAmountMinor} = (
            SELECT coalesce(sum(${orderPayments.amountMinor}), 0) FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
              AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
        )
    `;
}

/**
 * Gives a cancelled order's gift cards back in one batch: the order row
 * (nothing paid, nothing owed, refunded) moves first under its version, a
 * guard aborts the batch when it did not, then each card's `release` (keyed
 * per order and card, so a replay adds nothing) and its tender row.
 */
export async function releaseCancelledOrderGiftCards(
    db: Database,
    orderId: string,
    expected: { version: number; paidAmountMinor: number; totalAmountMinor: number },
    tenders: readonly HeldGiftCardTender[],
    actor: { type: "system" | "admin"; id: string | null } = { type: "admin", id: null },
): Promise<void> {
    if (tenders.length === 0) return;
    const release = buildGiftCardReleaseStatements(db, {
        orderId,
        tenders,
        actor,
        reason: "Order cancelled: gift card payment returned",
    });
    // The gift cards were the order's only money, and all of it goes back.
    const settled = deriveOrderPaymentState({
        totalAmountMinor: expected.totalAmountMinor,
        ledger: { receivedMinor: release.releasedMinor, returnedMinor: release.releasedMinor, withdrawnMinor: 0 },
    });
    try {
        await safeBatch(db, [
            db.update(orders).set({
                paidAmountMinor: settled.paidAmountMinor,
                balanceDueMinor: settled.balanceDueMinor,
                paymentStatus: settled.paymentStatus,
                version: expected.version + 1,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, orderId),
                eq(orders.version, expected.version),
                eq(orders.status, OrderStatus.CANCELLED),
                giftCardOnlyCancellationPaymentCondition(orderId, expected.paidAmountMinor),
            )),
            buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${orders}
                WHERE ${orders.id} = ${orderId}
                  AND ${orders.version} = ${expected.version + 1}
                  AND ${orders.status} = ${OrderStatus.CANCELLED}
                  AND ${orders.paymentStatus} = ${settled.paymentStatus}
            )`, GIFT_CARD_CANCEL_RELEASE_CONFLICT),
            ...release.statements,
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, GIFT_CARD_CANCEL_RELEASE_CONFLICT)) {
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        throw error;
    }
}

const COD_ACTION_REFUSALS: Record<OrderCodAction, string> = {
    collected: "Cash can be recorded once the order is sent with a courier.",
    failed: "A failed delivery can be recorded only while the order is with the courier.",
    returned: "Only an order that was sent can be marked returned.",
};

/**
 * `requiresShipping: false` (pickup or service): cash is taken at the
 * counter or at the service, so a confirmed order can record it.
 */
export function assertOrderCodActionAllowed(
    status: string,
    action: OrderCodAction,
    context: { requiresShipping?: boolean } = {},
): void {
    if (canProcessOrderCodAction(status, action, context)) return;
    // A second click from a tab opened before the first: say what happened, not what is allowed.
    if (action === "returned" && status === OrderStatus.RETURNED) {
        throw new AppError(409, "conflict", "This order is already marked returned.", { reason: "order_already_returned" });
    }
    throw new ValidationError(action === "collected" && context.requiresShipping === false
        ? "Confirm the order before recording the cash."
        : COD_ACTION_REFUSALS[action]);
}

/**
 * A provider-less fulfillment is operated entirely by the merchant, so a
 * merchant-confirmed delivered order is also its delivery authority. Keep
 * provider shipments untouched: their status remains owned by provider sync.
 *
 * Idempotent: COD/status retries can repair a delivered order whose manual
 * parcel still said processing.
 */
export async function markManualDeliveryEvidence(
    db: Database,
    orderId: string,
): Promise<void> {
    await safeBatch(db, [manualDeliveryEvidenceUpdate(db, orderId)] as never);
}

/** `markManualDeliveryEvidence` as a statement for the delivered status's own batch. */
export function manualDeliveryEvidenceUpdate(db: Database, orderId: string): SQLiteBatchItem {
    return db.update(deliveryShipments).set({
        status: ShipmentStatus.DELIVERED,
        rawStatus: ShipmentStatus.DELIVERED,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(deliveryShipments.orderId, orderId),
        eq(deliveryShipments.providerType, "manual"),
        sql`${deliveryShipments.providerId} IS NULL`,
        // A parcel that failed once and was delivered on the next try is delivered.
        sql`${deliveryShipments.status} NOT IN (
            ${ShipmentStatus.DELIVERED},
            ${ShipmentStatus.RETURNED},
            ${ShipmentStatus.CANCELLED},
            ${ShipmentStatus.FAILED}
        )`,
    )) as SQLiteBatchItem;
}

export async function getRecordedCodCollection(
    db: Database,
    orderId: string,
    currency: OrderCurrencySnapshot,
): Promise<{ amountMinor: number; collectedBy: string } | null> {
    const payment = await db
        .select({
            id: orderPayments.id,
            amountMinor: orderPayments.amountMinor,
            currency: orderPayments.currency,
            collectedBy: orderPayments.codCollectedBy,
        })
        .from(orderPayments)
        .where(and(
            eq(orderPayments.orderId, orderId),
            eq(orderPayments.paymentMethod, PaymentMethod.COD),
            eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
        ))
        .get();

    if (!payment) return null;
    assertOrderPaymentCurrency(payment.currency, currency, "Recorded COD payment");

    const tracking = await db
        .select({
            id: codTracking.id,
            collectedBy: codTracking.collectedBy,
        })
        .from(codTracking)
        .where(and(
            eq(codTracking.orderId, orderId),
            eq(codTracking.codStatus, CodStatus.COLLECTED),
        ))
        .get();

    if (!tracking) return null;
    const collectedBy = payment.collectedBy?.trim();
    if (!collectedBy || tracking.collectedBy?.trim() !== collectedBy) return null;
    return { amountMinor: payment.amountMinor, collectedBy };
}

async function hasRecordedCodCollection(
    db: Database,
    orderId: string,
    currency: OrderCurrencySnapshot,
): Promise<boolean> {
    return Boolean(await getRecordedCodCollection(db, orderId, currency));
}

// Statuses that warrant a customer notification email
const NOTIFICATION_STATUSES: Record<string, OrderNotificationType> = {
    pending: "order_created",
    confirmed: "order_confirmed",
    processing: "order_processing",
    shipped: "order_shipped",
    delivered: "order_delivered",
    completed: "order_completed",
    cancelled: "order_cancelled",
    returned: "order_returned",
    refunded: "order_refunded",
};

/**
 * The dashboard's and agents' status change: only changes without side
 * effects (see admin-status-policy). Shipped, delivered and returned come from
 * the fulfilment actions, which call `applyOrderStatusChange` directly.
 */
/**
 * The dashboard's and the app API's status change. `expectedVersion`, when
 * given, is the order version the caller read: a change since refuses (409)
 * and changes nothing (the write's own version CAS makes it exact).
 */
export async function updateOrderStatus(
    db: Database,
    orderId: string,
    status: string,
    data?: { trackingId?: string; expectedVersion?: number },
    record: Pick<OrderStatusChangeOptions, "event" | "notify"> = {},
): Promise<StatusUpdateResult> {
    return applyOrderStatusChange(db, orderId, status, data, { generic: true, ...record });
}

export async function applyOrderStatusChange(
    db: Database,
    orderId: string,
    status: string,
    data: { trackingId?: string; expectedVersion?: number } | undefined,
    options: OrderStatusChangeOptions,
): Promise<StatusUpdateResult> {
    const nextStatus = normalizeOrderStatus(status);
    if (!nextStatus) {
        throw new ValidationError("Unknown order status.");
    }
    for (let attempt = 1; ; attempt++) {
        try {
            return await attemptOrderStatusChange(db, orderId, nextStatus, data, options);
        } catch (error: unknown) {
            if (!(error instanceof StockMovedDuringStatusChange)) throw error;
            if (attempt >= MAX_STATUS_CHANGE_ATTEMPTS) {
                throw new ConflictError("Stock for this order changed while it was being updated. Try again.");
            }
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
    }
}

/** The status batch lost a race on stock (not on the order): prepare it again. */
class StockMovedDuringStatusChange extends Error {}

const ORDER_STATUS_CONFLICT = "order_status_conflict";
const MAX_STATUS_CHANGE_ATTEMPTS = 3;
const ORDER_CHANGED_MESSAGE = "This order changed. Reload to see the latest.";

/** What a status command writes with the change, in the same batch. */
export interface OrderStatusChangeOptions {
    generic: boolean;
    /**
     * Delivered before the cash is in: a cash on delivery parcel your own
     * rider handed over, whose cash the rider or courier remits later.
     * The order stays unpaid ("Due on delivery") until Collect cash.
     */
    codCashPending?: boolean;
    /**
     * Writes that come first in the batch and that the change depends on (a
     * cash collection, prepared for each attempt; null when already written):
     * `nextVersion` is the order's version once they ran. The money checks
     * then leave the money to them.
     */
    before?: () => Promise<{ statements: SQLiteBatchItem[]; nextVersion: number } | null>;
    /** The timeline line of the change. Without a request key its id comes from the new version. */
    event?: {
        kind?: Exclude<OrderEventKind, "placed">;
        actorId?: string | null;
        body?: string | null;
        data?: Record<string, unknown>;
        requestKey?: string;
    };
    /** The customer message of the change, by `source`; a type and key override the status's own. */
    notify?: {
        source: string;
        notificationType?: OrderNotificationType;
        dedupeKey?: string;
        data?: Record<string, unknown>;
    };
    /** Write the event and message even when the status is unchanged (what `before` wrote is the news). */
    announceUnchanged?: boolean;
}

async function attemptOrderStatusChange(
    db: Database,
    orderId: string,
    nextStatus: NonNullable<ReturnType<typeof normalizeOrderStatus>>,
    data: { trackingId?: string; expectedVersion?: number } | undefined,
    options: OrderStatusChangeOptions,
): Promise<StatusUpdateResult> {
    const existingOrder = await db.select({
        status: orders.status,
        requiresShipping: orders.requiresShipping,
        inventoryAction: orders.inventoryAction,
        version: orders.version,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        paymentTermsDays: orders.paymentTermsDays,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        // The claim's own attempt row: an expired claim with none (or a failed one) does not lock.
        shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) throw new NotFoundError("Order not found");
    if (data?.expectedVersion !== undefined && existingOrder.version !== data.expectedVersion) {
        throw new ConflictError(ORDER_CHANGED_MESSAGE);
    }
    const currentStatus = normalizeOrderStatus(existingOrder.status);
    if (!currentStatus) {
        throw new ValidationError("Order has an unknown current status.");
    }
    const changed = currentStatus !== nextStatus;
    if (options.generic && changed) {
        assertGenericAdminOrderStatusTransition(currentStatus, nextStatus);
        // A held order waits for staff review; cancelling it stays possible.
        if (nextStatus !== OrderStatus.CANCELLED) await assertOrderNotOnHold(db, orderId);
    }
    assertNoActiveShipmentClaim(existingOrder);
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    const isDeliveredOrCompleted = nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED;
    // An invoice (net terms) is delivered before it is paid; it completes once paid.
    // Only recorded terms open this: a missing value keeps the money-due guard.
    const onTerms = typeof existingOrder.paymentTermsDays === "number";
    const deliveredOnTerms = nextStatus === OrderStatus.DELIVERED && onTerms;
    const deliveredBeforeCash = nextStatus === OrderStatus.DELIVERED && (
        (options.codCashPending === true && existingOrder.paymentMethod === PaymentMethod.COD)
        // The cash is recorded in this same batch (Collect cash).
        || options.before !== undefined
    );
    if (nextStatus === OrderStatus.DELIVERED && changed) {
        // Delivered only once every line that is handed over by a real
        // action was (F7); digital and gift-card lines never block.
        await assertOrderLinesHandedOver(db, orderId, existingOrder.requiresShipping);
    }
    if (isDeliveredOrCompleted && !deliveredOnTerms && !deliveredBeforeCash) {
        const currency = resolveOrderCurrencySnapshot(existingOrder);
        // A partly refunded order was paid in full: its net paid amount is
        // below the total because money went back, not because any is owed.
        const partlyRefunded = existingOrder.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED;
        const hasMoneyDue = existingOrder.balanceDueMinor > 0
            || (!partlyRefunded && existingOrder.totalAmountMinor > existingOrder.paidAmountMinor);
        const settled = existingOrder.paymentStatus === PaymentStatus.PAID
            || existingOrder.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED;
        if (hasMoneyDue || !settled) {
            throw new ValidationError(
                existingOrder.paymentMethod === PaymentMethod.COD
                    ? "Mark the cash as collected first."
                    : onTerms
                    ? "Record the invoice payment first."
                    : existingOrder.paymentStatus === PaymentStatus.PARTIAL
                    ? "Record the rest of the payment first."
                    : "This order still has money due.",
            );
        }

        if (existingOrder.paymentMethod === PaymentMethod.COD) {
            const hasCodCollection = await hasRecordedCodCollection(db, orderId, currency);
            if (!hasCodCollection || existingOrder.paidAmountMinor <= 0) {
                throw new ValidationError("Mark the cash as collected first.");
            }
        }
    }

    // Paid only by gift cards (no gateway or cash taken): cancelling gives
    // them back. Any other money goes through the refund flow first.
    let giftCardTenders: HeldGiftCardTender[] | null = null;
    if (changed) {
        // Validate the status transition before applying any side effects
        validateTransition("order", currentStatus, nextStatus);
        if (nextStatus === OrderStatus.CANCELLED) {
            await assertNothingHandedOver(db, orderId);
            giftCardTenders = await giftCardOnlyTenders(db, orderId, existingOrder);
            if (!giftCardTenders) {
                await assertGenericCancellationPaymentSafe(db, orderId, existingOrder);
            }
        }
    }

    const before = options.before ? await options.before() : null;
    // What `before` writes was prepared from its own read: the order must be
    // the one this change validated (a return to sender in between is a conflict).
    if (before && before.nextVersion !== existingOrder.version + 1) {
        throw new ConflictError(ORDER_CHANGED_MESSAGE);
    }
    const baseVersion = before?.nextVersion ?? existingOrder.version;
    const newVersion = changed ? baseVersion + 1 : baseVersion;
    const inventory = await prepareInventoryForStatusChange(db, orderId, nextStatus);
    // The change took effect: every dependent write after the CAS is conditioned on it.
    const landed = sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${newVersion} AND ${orders.status} = ${nextStatus}
    )`;
    const statements: SQLiteBatchItem[] = [...(before?.statements ?? [])];
    const casCondition = and(
        eq(orders.id, orderId),
        eq(orders.version, baseVersion),
        eq(orders.status, existingOrder.status),
        noActiveRefundAttemptForOrderIdCondition(orderId),
        noActivePaymentSessionAttemptForOrderIdCondition(orderId),
        ...(nextStatus === OrderStatus.CANCELLED
            ? [
                giftCardTenders
                    ? giftCardOnlyCancellationPaymentCondition(orderId, existingOrder.paidAmountMinor)
                    : noUnsafeCancellationPaymentCondition(orderId),
                nothingSentCondition(orderId),
            ]
            : []),
    )!;
    // The CAS's own precondition, proven before it: when it fails the whole
    // batch aborts, so a lost CAS writes nothing even if another writer
    // reached the same version and status (the `landed` rows below are then
    // exactly this change's).
    statements.push(buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${changed
        ? casCondition
        : and(eq(orders.id, orderId), eq(orders.version, baseVersion), eq(orders.status, existingOrder.status))})`,
    ORDER_STATUS_CONFLICT));
    if (changed) {
        // The status CAS, its stock, its delivery evidence, timeline line and
        // customer message are one batch: they commit together or not at all.
        statements.push(db.update(orders).set({
            status: nextStatus,
            version: newVersion,
            updatedAt: sql`unixepoch()`,
        }).where(casCondition) as SQLiteBatchItem);
    }
    statements.push(...inventory.statements);
    if (isDeliveredOrCompleted) statements.push(manualDeliveryEvidenceUpdate(db, orderId));

    // Build notification payload if the new status warrants one
    const notificationType = options.notify?.notificationType ?? (changed ? NOTIFICATION_STATUSES[nextStatus] : undefined);
    const notification = notificationType
        ? {
            orderId,
            customerEmail: existingOrder.customerEmail ?? undefined,
            customerName: existingOrder.customerName,
            notificationType,
            dedupeKey: options.notify?.dedupeKey ?? buildOrderStatusNotificationDedupeKey({
                orderId,
                notificationType,
                previousStatus: currentStatus,
                newStatus: nextStatus,
                version: newVersion,
            }),
            previousStatus: currentStatus,
            newStatus: nextStatus,
            version: newVersion,
            ...(nextStatus === OrderStatus.SHIPPED && data?.trackingId
                ? { trackingId: data.trackingId }
                : {}),
        }
        : undefined;
    const announce = changed || options.announceUnchanged === true;
    if (announce && options.event) {
        const kind = options.event.kind ?? "status_changed";
        statements.push(buildOrderEventInsert(db, {
            // The line commits with the change, so it needs no key unless the caller replays one;
            // a time-sortable id keeps it in order with the lines written around it.
            id: options.event.requestKey ? await orderEventIdForRequest(orderId, kind, options.event.requestKey) : newOrderEventId(),
            orderId,
            kind,
            actorId: options.event.actorId ?? null,
            body: options.event.body ?? null,
            // A status line always names the move; other kinds carry their own facts.
            data: kind === "status_changed"
                ? { from: currentStatus, to: nextStatus, ...options.event.data }
                : options.event.data ?? null,
        }, landed) as SQLiteBatchItem);
    }
    const outboxIds: string[] = [];
    if (announce && options.notify && notification) {
        const outbox = buildOrderNotificationOutboxInsert(db, {
            orderId,
            notificationType: notification.notificationType,
            dedupeKey: notification.dedupeKey,
            source: options.notify.source,
            data: options.notify.data ?? (notification.trackingId ? { trackingId: notification.trackingId } : undefined),
        }, landed);
        statements.push(outbox.statement as SQLiteBatchItem);
        outboxIds.push(outbox.outboxId);
    }

    try {
        await safeBatch(db, statements as never);
    } catch (error: unknown) {
        const refusal = inventory.translateError(error);
        if (refusal) throw refusal;
        if (!isBatchGuardError(error, ORDER_STATUS_CONFLICT) && !isOrderInventoryConflictError(error)) {
            if (isCODCollectionConflictError(error)) throw new ConflictError(ORDER_CHANGED_MESSAGE);
            throw error;
        }
        // Which race: the order itself under a change or a caller's version (a
        // conflict, as the CAS always was), or only stock (prepare again).
        const [now, casHolds] = await safeBatch(db, [
            db.select({ version: orders.version }).from(orders).where(eq(orders.id, orderId)),
            db.select({ id: orders.id }).from(orders).where(casCondition),
        ] as const);
        if (!now[0]) throw new NotFoundError("Order not found");
        if (before ? now[0].version !== existingOrder.version : changed && casHolds.length === 0) {
            throw new ConflictError(ORDER_CHANGED_MESSAGE);
        }
        if (data?.expectedVersion !== undefined && now[0].version !== data.expectedVersion) {
            throw new ConflictError(ORDER_CHANGED_MESSAGE);
        }
        throw new StockMovedDuringStatusChange();
    }
    await inventory.afterCommit();

    if (nextStatus === OrderStatus.CANCELLED) {
        // After the stock is back: a gift card given back cannot be taken
        // again. When this fails, cancelling again or the stale-order sweep
        // gives them back (the unchanged-status path and its self-heal).
        const tenders = giftCardTenders ?? (changed ? null : await giftCardOnlyTenders(db, orderId, existingOrder));
        if (tenders) {
            await releaseCancelledOrderGiftCards(db, orderId, {
                version: newVersion,
                paidAmountMinor: existingOrder.paidAmountMinor,
                totalAmountMinor: existingOrder.totalAmountMinor,
            }, tenders);
        }
    }

    return {
        message: changed ? "Order status updated successfully" : "Status unchanged; inventory reconciled",
        ...(changed || options.announceUnchanged ? { notification } : {}),
        ...(outboxIds.length > 0 ? { outboxIds } : {}),
        availabilityTransitionVariantIds: inventory.availabilityTransitionVariantIds,
    };
}

/**
 * Units handed over are out of the building (with a courier, collected at the
 * counter, or a service performed): cancelling would put them back into
 * sellable stock (R2-ORD-02, Wave A F8). They must come back as a return, or
 * the fulfilment be voided, first.
 */
async function assertNothingHandedOver(db: Database, orderId: string): Promise<void> {
    const rows = await db.select({
        type: orderItems.fulfillmentType,
        handedOver: sql<number>`coalesce(sum(${orderItems.fulfilledQuantity}), 0)`,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).groupBy(orderItems.fulfillmentType).all();
    const byType = new Map<string, number>(rows.map((row) => [row.type, Number(row.handedOver) || 0]));
    const count = (type: string) => byType.get(type) ?? 0;
    const units = (quantity: number) => (quantity === 1 ? "1 item is" : `${quantity} items are`);
    if (count("ship") > 0) {
        throw new ValidationError(`${units(count("ship"))} with the courier. Mark ${count("ship") === 1 ? "it" : "them"} returned or delivered first.`);
    }
    if (count("pickup") > 0) {
        throw new ValidationError(`${count("pickup") === 1 ? "1 item was" : `${count("pickup")} items were`} picked up. Take ${count("pickup") === 1 ? "it" : "them"} back as a return first.`);
    }
    const delivered = [...byType.values()].reduce((sum, quantity) => sum + quantity, 0);
    if (delivered > 0) {
        throw new ValidationError(`${delivered === 1 ? "1 item was" : `${delivered} items were`} already delivered to the buyer.`);
    }
}

function nothingSentCondition(orderId: string) {
    return sql`NOT EXISTS (
        SELECT 1 FROM ${orderItems}
        WHERE ${orderItems.orderId} = ${orderId}
          AND ${orderItems.fulfilledQuantity} > 0
    )`;
}

/**
 * A line is handed over once the ledger covers its quantity. `ship` and
 * `pickup` lines always gate delivered;
 * `service` lines gate it when nothing ships (a courier's delivered is not
 * held back by an installation still to do); digital and gift-card lines
 * fulfil themselves after payment and never gate it.
 */
export async function assertOrderLinesHandedOver(
    db: Database,
    orderId: string,
    requiresShipping: boolean,
): Promise<void> {
    const gatingTypes = requiresShipping ? ["ship", "pickup"] : ["ship", "pickup", "service"];
    const row = await db.select({
        missing: sql<number>`coalesce(sum(${orderItems.quantity} - ${orderItems.fulfilledQuantity}), 0)`,
    }).from(orderItems).where(and(
        eq(orderItems.orderId, orderId),
        inArray(orderItems.fulfillmentType, gatingTypes as ["ship", "pickup", "service"]),
        sql`${orderItems.fulfilledQuantity} < ${orderItems.quantity}`,
    )).get();
    const missing = Number(row?.missing ?? 0);
    if (missing > 0) {
        throw new ValidationError(missing === 1
            ? "1 item hasn't been handed over yet."
            : `${missing} items haven't been handed over yet.`);
    }
}

export interface BulkOrderActionResult {
    orderId: string;
    success: boolean;
    error?: string;
}

/** Orders whose confirm statements share one batch (three statements each). */
const BULK_CONFIRM_BATCH_ORDERS = 30;
const OUTER_ORDER_ID = sql.raw('"orders"."id"');

/**
 * Confirms each new order in the selection (the phone-confirmation queue).
 * Orders past that stage are reported as skipped, never changed. With a
 * request key, running the same selection again (double click, retry) reports
 * the orders it already confirmed as done instead of failed.
 *
 * Each order's status CAS, its timeline line and its customer message
 * (`outboxId`, for the caller's sender) commit in one batch, so a death or a
 * cut-off after the commit can lose neither, and a replay finds them all.
 * The line and the message are written only when the CAS's own precondition
 * holds, so a lost CAS writes neither. One read covers the whole selection;
 * the writes go in batches of BULK_CONFIRM_BATCH_ORDERS orders. An order
 * whose stock must be reserved again goes through the status kernel after
 * those batches, at most `maxStockRepairs` of them; the rest come back
 * `deferred` for the caller's next request.
 */
export async function bulkConfirmOrders(
    db: Database,
    orderIds: readonly string[],
    options: { requestKey?: string; actorId?: string | null; source?: string; maxStockRepairs?: number } = {},
): Promise<Array<BulkOrderActionResult & { outboxId?: string; deferred?: true }>> {
    const ids = [...new Set(orderIds)];
    const eventKey = options.requestKey ? `bulk-confirm:${options.requestKey}` : null;
    const source = options.source ?? "orders-bulk-confirm";
    const eventIds = new Map<string, string>();
    for (const orderId of ids) {
        eventIds.set(orderId, await orderEventIdForRequest(orderId, "status_changed", eventKey ?? `bulk-confirm:${orderId}`));
    }
    const rows: Array<{
        id: string;
        status: string;
        version: number;
        inventoryAction: string;
        shipmentClaimId: string | null;
        shipmentClaimExpiresAt: number | null;
        onHold: number;
        refundActive: number;
        paymentSetupActive: number;
    }> = [];
    const replayed = new Set<string>();
    for (const slice of chunkForD1(ids)) {
        const [orderRows, eventRows] = await safeBatch(db, [
            db.select({
                id: orders.id,
                status: orders.status,
                version: orders.version,
                inventoryAction: orders.inventoryAction,
                shipmentClaimId: orders.shipmentClaimId,
                shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
                // The claim's own attempt row: an expired claim with none (or a failed one) does not lock.
                shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
                onHold: sql<number>`NOT (${noOpenOrderHoldCondition(OUTER_ORDER_ID)})`,
                refundActive: sql<number>`NOT (${noActiveRefundAttemptForOrderColumnCondition(OUTER_ORDER_ID)})`,
                paymentSetupActive: sql<number>`${activePaymentSessionAttemptExistsCondition(OUTER_ORDER_ID)}`,
            }).from(orders).where(inJsonArray(orders.id, slice)),
            db.select({ id: orderEvents.id }).from(orderEvents)
                .where(inJsonArray(orderEvents.id, eventKey ? slice.map((orderId) => eventIds.get(orderId)!) : [])),
        ] as const);
        rows.push(...(orderRows as typeof rows));
        const done = new Set((eventRows as Array<{ id: string }>).map((row) => row.id));
        for (const orderId of slice) if (done.has(eventIds.get(orderId)!)) replayed.add(orderId);
    }
    const byId = new Map(rows.map((row) => [row.id, row]));

    const results = new Map<string, BulkOrderActionResult & { outboxId?: string; deferred?: true }>();
    const stockRepairs: Array<{ orderId: string; status: string; version: number }> = [];
    const fail = (orderId: string, error: string) => results.set(orderId, { orderId, success: false, error });
    const pending: Array<{ orderId: string; statements: SQLiteBatchItem[]; outboxId: string }> = [];
    for (const orderId of ids) {
        const order = byId.get(orderId);
        if (!order) { fail(orderId, "Order not found"); continue; }
        // The confirm with this key already committed, with its line and message.
        if (replayed.has(orderId)) { results.set(orderId, { orderId, success: true }); continue; }
        if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PROCESSING) {
            fail(orderId, "Only new orders can be confirmed.");
            continue;
        }
        if (hasActiveShipmentClaim(order)) { fail(orderId, SHIPMENT_CLAIM_CONFLICT_MESSAGE); continue; }
        if (Number(order.refundActive)) { fail(orderId, ORDER_REFUND_MUTATION_BLOCKED_MESSAGE); continue; }
        if (Number(order.paymentSetupActive)) { fail(orderId, ACTIVE_PAYMENT_SESSION_SETUP_MESSAGE); continue; }
        if (Number(order.onHold)) { fail(orderId, "This order is on hold for review. Release the hold first."); continue; }
        if (order.inventoryAction === "restored") {
            // Its stock must be reserved again: the status kernel does that in
            // the confirm's batch, after the cheap batches below.
            stockRepairs.push({ orderId, status: order.status, version: order.version });
            continue;
        }
        const version = order.version + 1;
        const confirmable = and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
            eq(orders.status, order.status),
            eq(orders.inventoryAction, order.inventoryAction),
            noActiveShipmentClaimCondition(),
            noActiveRefundAttemptForOrderIdCondition(orderId),
            noActivePaymentSessionAttemptForOrderIdCondition(orderId),
            noOpenOrderHoldCondition(orderId),
        )!;
        // The CAS's own precondition, so a lost CAS (another writer reaching
        // the same version and status) writes no line and no message. The
        // rows go just before the CAS, which then applies in the same transaction.
        const claimable = sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${confirmable})`;
        const notificationType = NOTIFICATION_STATUSES[OrderStatus.CONFIRMED]!;
        const outbox = buildOrderNotificationOutboxInsert(db, {
            orderId,
            notificationType,
            dedupeKey: buildOrderStatusNotificationDedupeKey({
                orderId,
                notificationType,
                previousStatus: order.status,
                newStatus: OrderStatus.CONFIRMED,
                version,
            }),
            source,
        }, claimable);
        pending.push({
            orderId,
            outboxId: outbox.outboxId,
            statements: [
                buildOrderEventInsert(db, {
                    id: eventKey ? eventIds.get(orderId)! : newOrderEventId(),
                    orderId,
                    kind: "status_changed",
                    actorId: options.actorId ?? null,
                    data: { from: order.status, to: OrderStatus.CONFIRMED },
                }, claimable) as SQLiteBatchItem,
                outbox.statement as SQLiteBatchItem,
                db.update(orders).set({
                    status: OrderStatus.CONFIRMED,
                    version,
                    updatedAt: sql`unixepoch()`,
                }).where(confirmable).returning({ id: orders.id }) as SQLiteBatchItem,
            ],
        });
    }

    for (let offset = 0; offset < pending.length; offset += BULK_CONFIRM_BATCH_ORDERS) {
        const slice = pending.slice(offset, offset + BULK_CONFIRM_BATCH_ORDERS);
        try {
            const written = await safeBatch(db, slice.flatMap((entry) => entry.statements) as never) as unknown[];
            slice.forEach((entry, index) => {
                const claimed = written[index * 3 + 2] as Array<{ id: string }> | undefined;
                if ((claimed?.length ?? 0) > 0) {
                    results.set(entry.orderId, { orderId: entry.orderId, success: true, outboxId: entry.outboxId });
                } else {
                    fail(entry.orderId, ORDER_CHANGED_MESSAGE);
                }
            });
        } catch (error: unknown) {
            console.error("[orders.bulk-confirm] a confirm batch failed", error instanceof Error ? error.message : "unknown");
            for (const entry of slice) fail(entry.orderId, "Couldn't confirm this order. Try again.");
        }
    }
    const maxStockRepairs = options.maxStockRepairs ?? Number.POSITIVE_INFINITY;
    for (const [index, repair] of stockRepairs.entries()) {
        if (index >= maxStockRepairs) {
            results.set(repair.orderId, { orderId: repair.orderId, success: false, deferred: true });
            continue;
        }
        try {
            const update = await applyOrderStatusChange(db, repair.orderId, OrderStatus.CONFIRMED, { expectedVersion: repair.version }, {
                generic: true,
                event: { actorId: options.actorId ?? null, requestKey: eventKey ?? undefined, data: { from: repair.status, to: OrderStatus.CONFIRMED } },
                notify: { source },
            });
            results.set(repair.orderId, { orderId: repair.orderId, success: true, outboxId: update.outboxIds?.[0] });
        } catch (error: unknown) {
            fail(repair.orderId, error instanceof Error ? error.message : "Couldn't confirm this order.");
        }
    }
    return ids.map((orderId) => results.get(orderId)!);
}
