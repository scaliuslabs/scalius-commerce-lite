// The order status kernel: validated status changes, inventory reconciliation, COD gates and cancel guards. Fulfilment actions call it.
import type { Database } from "@scalius/database/client";
import { hasOrderEvent, recordOrderEvent } from "../timeline";
import {
    orders,
    orderItems,
    codTracking,
    deliveryShipments,
    CodStatus,
    OrderStatus,
    ItemFulfillmentStatus,
    PaymentMethod,
    PaymentRecordStatus,
    PaymentStatus,
    ShipmentStatus,
    orderPayments,
} from "@scalius/database/schema";
import { applyInventoryForStatusChangeWithImpact } from "../../inventory/inventory-transitions";
import {
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "../../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../../payments/payment-session-attempts";
import { sql, eq, and, inArray, type SQL } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import {
    canProcessOrderCodAction,
    normalizeOrderStatus,
    type OrderCodAction,
} from "@scalius/shared/order-state";
import {
    assertOrderPaymentCurrency,
    resolveOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "../../payments/order-currency";
import { validateTransition } from "./state-machine";
import type { StatusUpdateResult } from "../types";
import type { OrderNotificationType } from "../../notifications/notification-types";
import { buildOrderStatusNotificationDedupeKey } from "../../notifications/order-notification-outbox";
import { assertNoActiveShipmentClaim } from "../shipment-claim";
import { rollbackOrderStatusIfInventoryUnchanged } from "./claim";
import { assertGenericAdminOrderStatusTransition } from "./policy";

export async function reconcileInventoryForStatus(
    db: Database,
    orderId: string,
    status: string,
): Promise<string[]> {
    const impact = await applyInventoryForStatusChangeWithImpact(db, orderId, status);
    await db.update(orders).set({ inventoryAction: impact.inventoryAction }).where(eq(orders.id, orderId));
    return impact.availabilityTransitionVariantIds;
}

const CANCELLATION_UNSAFE_PAYMENT_RECORD_STATUSES = [
    PaymentRecordStatus.PENDING,
    PaymentRecordStatus.CONFIRMED,
    PaymentRecordStatus.SUCCEEDED,
] as const;

const CANCELLATION_REQUIRES_REFUND_MESSAGE =
    "This order has been paid. Refund the payment first, then cancel.";
const CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION_MESSAGE =
    "A payment for this order is still being processed. Check the payment before cancelling.";

function noUnsafeCancellationPaymentCondition(orderId: string): SQL {
    return sql`
        ${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})
        AND ${orders.paidAmountMinor} = 0
        AND NOT EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} IN (
                  ${PaymentRecordStatus.PENDING},
                  ${PaymentRecordStatus.CONFIRMED},
                  ${PaymentRecordStatus.SUCCEEDED}
              )
        )
    `;
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
            inArray(orderPayments.status, [...CANCELLATION_UNSAFE_PAYMENT_RECORD_STATUSES]),
        ))
        .get();
    if (unsafePayment) {
        throw new ValidationError(CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION_MESSAGE);
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
    throw new ValidationError(action === "collected" && context.requiresShipping === false
        ? "Confirm the order before recording the cash."
        : COD_ACTION_REFUSALS[action]);
}

/**
 * A provider-less fulfillment is operated entirely by the merchant, so a
 * merchant-confirmed delivered order is also its delivery authority. Keep
 * provider shipments untouched: their status remains owned by provider sync.
 *
 * The batch is intentionally idempotent. COD/status retries can repair legacy
 * rows that reached delivered order state while their manual shipment still
 * said processing and their line items still said shipped.
 */
export async function markManualDeliveryEvidence(
    db: Database,
    orderId: string,
): Promise<void> {
    const writes = [
        db.update(orderItems).set({
            fulfillmentStatus: ItemFulfillmentStatus.DELIVERED,
        }).where(and(
            eq(orderItems.orderId, orderId),
            eq(orderItems.fulfillmentStatus, ItemFulfillmentStatus.SHIPPED),
        )),
        db.update(deliveryShipments).set({
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
        )),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(writes as any);
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
export async function updateOrderStatus(db: Database, orderId: string, status: string, data?: { trackingId?: string }): Promise<StatusUpdateResult> {
    return applyOrderStatusChange(db, orderId, status, data, { generic: true });
}

export async function applyOrderStatusChange(
    db: Database,
    orderId: string,
    status: string,
    data: { trackingId?: string } | undefined,
    options: { generic: boolean },
): Promise<StatusUpdateResult> {
    const nextStatus = normalizeOrderStatus(status);
    if (!nextStatus) {
        throw new ValidationError("Unknown order status.");
    }

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
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) throw new NotFoundError("Order not found");
    const currentStatus = normalizeOrderStatus(existingOrder.status);
    if (!currentStatus) {
        throw new ValidationError("Order has an unknown current status.");
    }
    if (options.generic && currentStatus !== nextStatus) {
        assertGenericAdminOrderStatusTransition(currentStatus, nextStatus);
    }
    assertNoActiveShipmentClaim(existingOrder);
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    const isDeliveredOrCompleted = nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED;
    if (nextStatus === OrderStatus.DELIVERED && currentStatus !== nextStatus) {
        // Delivered only once every line that is handed over by a real
        // action was (F7); digital and gift-card lines never block.
        await assertOrderLinesHandedOver(db, orderId, existingOrder.requiresShipping);
    }
    if (isDeliveredOrCompleted) {
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
    if (currentStatus === nextStatus) {
        const availabilityTransitionVariantIds = await reconcileInventoryForStatus(
            db,
            orderId,
            nextStatus,
        );
        if (nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED) {
            await markManualDeliveryEvidence(db, orderId);
        }
        return {
            message: "Status unchanged; inventory reconciled",
            availabilityTransitionVariantIds,
        };
    }

    // Validate the status transition before applying any side effects
    validateTransition("order", currentStatus, nextStatus);

    if (nextStatus === OrderStatus.CANCELLED) {
        await assertNothingHandedOver(db, orderId);
        await assertGenericCancellationPaymentSafe(db, orderId, existingOrder);
    }

    // Optimistic locking: CAS update FIRST — only proceed with side effects
    // if we win the version check. This prevents the race condition where two
    // concurrent callers (e.g. admin + webhook) both apply inventory before
    // either detects the conflict.
    const result = await db.update(orders).set({
        status: nextStatus,
        version: existingOrder.version + 1,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, existingOrder.version),
        noActiveRefundAttemptForOrderIdCondition(orderId),
        noActivePaymentSessionAttemptForOrderIdCondition(orderId),
        ...(nextStatus === OrderStatus.CANCELLED
            ? [noUnsafeCancellationPaymentCondition(orderId), nothingSentCondition(orderId)]
            : []),
    )).returning({ id: orders.id });

    if (result.length === 0) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }

    // CAS succeeded. If inventory reconciliation fails before the order's
    // inventoryAction changes, roll back the buyer-visible status so operators
    // do not see a completed transition with stale stock counters.
    let availabilityTransitionVariantIds: string[];
    try {
        availabilityTransitionVariantIds = await reconcileInventoryForStatus(
            db,
            orderId,
            nextStatus,
        );
    } catch (error: unknown) {
        await rollbackOrderStatusIfInventoryUnchanged(db, {
            orderId,
            previousStatus: currentStatus,
            claimedStatus: nextStatus,
            claimedVersion: existingOrder.version + 1,
            previousInventoryAction: existingOrder.inventoryAction as string,
        });
        throw error;
    }
    if (nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED) {
        await markManualDeliveryEvidence(db, orderId);
    }

    // Build notification payload if the new status warrants one
    const notificationType = NOTIFICATION_STATUSES[nextStatus];
    const notification = notificationType
        ? {
            orderId,
            customerEmail: existingOrder.customerEmail ?? undefined,
            customerName: existingOrder.customerName,
            notificationType,
            dedupeKey: buildOrderStatusNotificationDedupeKey({
                orderId,
                notificationType,
                previousStatus: currentStatus,
                newStatus: nextStatus,
                version: existingOrder.version + 1,
            }),
            previousStatus: currentStatus,
            newStatus: nextStatus,
            version: existingOrder.version + 1,
            ...(nextStatus === OrderStatus.SHIPPED && data?.trackingId
                ? { trackingId: data.trackingId }
                : {}),
        }
        : undefined;

    return {
        message: "Order status updated successfully",
        notification,
        availabilityTransitionVariantIds,
    };
}

/**
 * Units handed over are out of the building (with a courier, collected at the
 * counter, or a service performed): cancelling would put them back into
 * sellable stock (R2-ORD-02, Wave A F8). They must come back as a return, or
 * the fulfilment be voided, first. Lines the previous API sent count until
 * the contract migration drops `shipped_quantity`.
 */
async function assertNothingHandedOver(db: Database, orderId: string): Promise<void> {
    const rows = await db.select({
        type: orderItems.fulfillmentType,
        handedOver: sql<number>`coalesce(sum(CASE WHEN ${orderItems.fulfilledQuantity} > ${orderItems.shippedQuantity} THEN ${orderItems.fulfilledQuantity} ELSE ${orderItems.shippedQuantity} END), 0)`,
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
          AND (${orderItems.fulfilledQuantity} > 0 OR ${orderItems.shippedQuantity} > 0)
    )`;
}

/**
 * A line is handed over once the ledger covers its quantity (or the previous
 * API marked it shipped). `ship` and `pickup` lines always gate delivered;
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
        sql`${orderItems.fulfillmentStatus} NOT IN (${ItemFulfillmentStatus.SHIPPED}, ${ItemFulfillmentStatus.DELIVERED})`,
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

/**
 * Confirms each new order in the selection (the phone-confirmation queue).
 * Orders past that stage are reported as skipped, never changed. With a
 * request key, running the same selection again (double click, retry) reports
 * the orders it already confirmed as done instead of failed.
 */
export async function bulkConfirmOrders(
    db: Database,
    orderIds: readonly string[],
    options: { requestKey?: string; actorId?: string | null } = {},
) {
    const results: Array<BulkOrderActionResult & { update?: StatusUpdateResult }> = [];
    const eventKey = options.requestKey ? `bulk-confirm:${options.requestKey}` : null;
    for (const orderId of orderIds) {
        try {
            const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
            if (!order) throw new NotFoundError("Order not found");
            if (eventKey && await hasOrderEvent(db, orderId, "status_changed", eventKey)) {
                results.push({ orderId, success: true });
                continue;
            }
            if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PROCESSING) {
                results.push({ orderId, success: false, error: "Only new orders can be confirmed." });
                continue;
            }
            const update = await updateOrderStatus(db, orderId, OrderStatus.CONFIRMED);
            await recordOrderEvent(db, {
                orderId,
                kind: "status_changed",
                actorId: options.actorId ?? null,
                requestKey: eventKey,
                data: { from: order.status, to: OrderStatus.CONFIRMED },
            });
            results.push({ orderId, success: true, update });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : "Couldn't confirm this order." });
        }
    }
    return results;
}
