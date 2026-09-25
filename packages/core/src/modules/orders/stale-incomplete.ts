import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import {
    abandonedCheckouts,
    orderPayments,
    paymentPlans,
    paymentSessionAttempts,
    orders,
    OrderStatus,
    PaymentPlanStatus,
    PaymentRecordStatus,
    PaymentStatus,
} from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "../inventory";
import { hasActiveShipmentClaim, noActiveShipmentClaimCondition } from "./shipment-claim";
import { isOnlinePaymentMethod, listPaymentGateways } from "../payments/gateways/registry";
import {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardReleaseStatements,
    listHeldGiftCardTenders,
} from "../gift-cards";
import { giftCardOnlyTenders, releaseCancelledOrderGiftCards } from "./status/lifecycle";

export const DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT = 25;
export const MAX_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT = 100;
const STALE_GIFT_CARD_RELEASE_CONFLICT = "STALE_GIFT_CARD_RELEASE_CONFLICT";
/** How long a cancelled order must sit untouched before its leftover gift-card holds are released. */
const LEFTOVER_HOLD_GRACE_SECONDS = 600;

type RecoverableStalePaymentStatus =
    | typeof PaymentStatus.UNPAID
    | typeof PaymentStatus.FAILED
    /** Gift cards paid part and the gateway never took the rest (Wave B §4.3). */
    | typeof PaymentStatus.PARTIAL;

const STALE_INCOMPLETE_PAYMENT_STATUSES: RecoverableStalePaymentStatus[] = [
    PaymentStatus.UNPAID,
    PaymentStatus.FAILED,
    PaymentStatus.PARTIAL,
];

const HOSTED_PAYMENT_METHODS = listPaymentGateways().map((gateway) => gateway.id);

// A gift-card tender is not a gateway claim: it is the hold this cleanup
// releases. Any other pending or succeeded row keeps the order for payment
// recovery.
const noActivePaymentClaimCondition = sql`NOT EXISTS (
    SELECT 1 FROM ${orderPayments}
    WHERE ${orderPayments.orderId} = ${orders.id}
      AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.SUCCEEDED})
      AND ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
)`;

/**
 * Nothing was paid, or only gift cards were: the paid amount is exactly the
 * held gift-card tender (an unpaid or failed order has none).
 */
const onlyGiftCardMoneyCondition = sql`(
    (${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED}) AND ${orders.paidAmountMinor} <= 0)
    OR (
        ${orders.paymentStatus} = ${PaymentStatus.PARTIAL}
        AND ${orders.paidAmountMinor} > 0
        AND ${orders.paidAmountMinor} = (
            SELECT coalesce(sum(${orderPayments.amountMinor}), 0) FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orders.id}
              AND ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
              AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
        )
    )
)`;

const noActivePaymentSessionClaimCondition = sql`NOT EXISTS (
    SELECT 1 FROM ${paymentSessionAttempts}
    WHERE ${paymentSessionAttempts.orderId} = ${orders.id}
      AND ${paymentSessionAttempts.status} = 'processing'
      AND (
        ${paymentSessionAttempts.claimExpiresAt} IS NULL
        OR ${paymentSessionAttempts.claimExpiresAt} > unixepoch()
      )
)`;

export interface StaleIncompleteOrderCleanupOptions {
    limit?: number;
}

export interface StaleIncompleteOrderCleanupResult {
    found: number;
    limit: number;
    hasMore: boolean;
    archived: number;
    failed: number;
    archivedOrderIds: string[];
    errors: Array<{ orderId: string; error: string }>;
    /** Cancelled orders whose leftover gift-card holds this run gave back (self-heal). */
    releasedGiftCardHoldOrderIds?: string[];
}

function normalizeCleanupLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT;
    if (!Number.isFinite(limit)) return DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT;
    return Math.max(1, Math.min(MAX_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT, Math.floor(limit)));
}

async function rollbackStaleIncompleteCleanupClaim(
    db: Database,
    orderId: string,
    claimedVersion: number,
    paymentStatus: RecoverableStalePaymentStatus,
): Promise<void> {
    await db.update(orders)
        .set({
            status: OrderStatus.INCOMPLETE,
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, orderId),
            eq(orders.version, claimedVersion),
            eq(orders.status, OrderStatus.CANCELLED),
            eq(orders.paymentStatus, paymentStatus),
            isNull(orders.deletedAt),
        ));
}

/**
 * Cancel and archive stale online-checkout orders that never became payable.
 *
 * This intentionally handles only `incomplete` orders that took no gateway
 * money and have no active gateway claim: unpaid/failed ones, and ones whose
 * only payment is a gift-card tender (the gateway never took the rest). The
 * archive batch gives those gift cards back exactly once (G4). Orders with
 * gateway money and currently processing gateway attempts are left alone for
 * payment recovery/reconciliation flows.
 */
export async function archiveStaleIncompleteOrders(
    db: Database,
    cutoffTimestamp: number,
    options: StaleIncompleteOrderCleanupOptions = {},
): Promise<StaleIncompleteOrderCleanupResult> {
    const limit = normalizeCleanupLimit(options.limit);
    const result: StaleIncompleteOrderCleanupResult = {
        found: 0,
        limit,
        hasMore: false,
        archived: 0,
        failed: 0,
        archivedOrderIds: [],
        errors: [],
        releasedGiftCardHoldOrderIds: [],
    };

    const candidates = await db.select().from(orders).where(
        and(
            eq(orders.status, OrderStatus.INCOMPLETE),
            inArray(orders.paymentMethod, HOSTED_PAYMENT_METHODS),
            inArray(orders.paymentStatus, STALE_INCOMPLETE_PAYMENT_STATUSES),
            onlyGiftCardMoneyCondition,
            sql`${orders.createdAt} <= ${cutoffTimestamp}`,
            isNull(orders.deletedAt),
            noActiveShipmentClaimCondition(),
            noActivePaymentClaimCondition,
            noActivePaymentSessionClaimCondition,
        ),
    ).limit(limit + 1);

    const incompleteOrders = candidates.slice(0, limit);
    result.found = incompleteOrders.length;
    result.hasMore = candidates.length > limit;

    for (const order of incompleteOrders) {
        try {
            const paymentStatus = order.paymentStatus as RecoverableStalePaymentStatus;
            if (!STALE_INCOMPLETE_PAYMENT_STATUSES.includes(paymentStatus)) {
                continue;
            }

            const paymentMethod = order.paymentMethod;
            if (!isOnlinePaymentMethod(paymentMethod)) {
                continue;
            }

            if (hasActiveShipmentClaim(order)) {
                continue;
            }

            // The gift cards this abandoned order holds go back in the archive
            // batch itself, after the order row moves (G4): release keys make a
            // replay a no-op, and a moved order aborts the whole batch.
            const heldTenders = order.paidAmountMinor > 0
                ? await listHeldGiftCardTenders(db, order.id)
                : [];
            const release = buildGiftCardReleaseStatements(db, {
                orderId: order.id,
                tenders: heldTenders,
                reason: "Checkout abandoned: gift card hold released",
            });
            if (release.releasedMinor !== order.paidAmountMinor) {
                // Money that is not all held gift-card tender: payment recovery owns it.
                continue;
            }

            const claimedVersion = order.version + 1;
            const claim = await db.update(orders)
                .set({
                    status: OrderStatus.CANCELLED,
                    version: claimedVersion,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(orders.id, order.id),
                    eq(orders.version, order.version),
                    eq(orders.status, OrderStatus.INCOMPLETE),
                    eq(orders.paymentMethod, paymentMethod),
                    eq(orders.paymentStatus, paymentStatus),
                    eq(orders.paidAmountMinor, order.paidAmountMinor),
                    onlyGiftCardMoneyCondition,
                    isNull(orders.deletedAt),
                    sql`${orders.createdAt} <= ${cutoffTimestamp}`,
                    noActiveShipmentClaimCondition(),
                    noActivePaymentClaimCondition,
                    noActivePaymentSessionClaimCondition,
                ))
                .returning({ id: orders.id });

            if (claim.length === 0) {
                continue;
            }

            if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
                try {
                    await applyInventoryForStatusChange(db, order.id, OrderStatus.CANCELLED);
                } catch (error) {
                    await rollbackStaleIncompleteCleanupClaim(db, order.id, claimedVersion, paymentStatus);
                    throw error;
                }
            }

            const finalPaymentStatus = release.releasedMinor > 0 ? PaymentStatus.REFUNDED : paymentStatus;

            const finalizedVersion = claimedVersion + 1;
            const [finalized] = await safeBatch(db, [
                db.update(orders)
                    .set({
                        deletedAt: sql`unixepoch()`,
                        inventoryAction: "restored",
                        ...(release.releasedMinor > 0
                            ? {
                                // Every gift card went back: nothing paid, nothing owed.
                                paidAmountMinor: 0,
                                balanceDueMinor: 0,
                                paymentStatus: finalPaymentStatus,
                            }
                            : {}),
                        version: sql`${orders.version} + 1`,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(and(
                        eq(orders.id, order.id),
                        eq(orders.version, claimedVersion),
                        eq(orders.status, OrderStatus.CANCELLED),
                        eq(orders.paymentMethod, paymentMethod),
                        eq(orders.paymentStatus, paymentStatus),
                        eq(orders.paidAmountMinor, order.paidAmountMinor),
                        isNull(orders.deletedAt),
                        noActivePaymentClaimCondition,
                    ))
                    .returning({ id: orders.id }),
                ...(release.statements.length > 0
                    ? [
                        buildBatchGuard(db, sql`EXISTS (
                            SELECT 1 FROM ${orders}
                            WHERE ${orders.id} = ${order.id}
                              AND ${orders.version} = ${finalizedVersion}
                              AND ${orders.status} = ${OrderStatus.CANCELLED}
                              AND ${orders.deletedAt} IS NOT NULL
                        )`, STALE_GIFT_CARD_RELEASE_CONFLICT),
                        ...release.statements,
                    ]
                    : []),
                db.update(paymentPlans)
                    .set({
                        status: PaymentPlanStatus.CANCELLED,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(and(
                        eq(paymentPlans.orderId, order.id),
                        eq(paymentPlans.status, PaymentPlanStatus.PENDING),
                        sql`EXISTS (
                            SELECT 1 FROM ${orders}
                            WHERE ${orders.id} = ${order.id}
                              AND ${orders.status} = ${OrderStatus.CANCELLED}
                              AND ${orders.version} = ${finalizedVersion}
                              AND ${orders.paymentMethod} = ${paymentMethod}
                              AND ${orders.paymentStatus} = ${finalPaymentStatus}
                              AND ${orders.deletedAt} IS NOT NULL
                        )`,
                    )),
            ] as never) as unknown[];

            const finalizedRows = finalized as Array<{ id: string }> | undefined;
            if ((finalizedRows?.length ?? 0) === 0) {
                throw new Error("Stale order cleanup changed concurrently before final archive");
            }

            await db.insert(abandonedCheckouts).values({
                id: `ab_ch_sys_${order.id}`,
                checkoutId: order.id,
                customerPhone: order.customerPhone,
                checkoutData: JSON.stringify(order),
                createdAt: order.createdAt || new Date(),
                updatedAt: order.updatedAt || new Date(),
            }).onConflictDoNothing();

            result.archived++;
            result.archivedOrderIds.push(order.id);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.failed++;
            result.errors.push({ orderId: order.id, error: message });
            console.error(`Failed to archive stale incomplete order ${order.id}:`, error);
        }
    }

    await releaseLeftoverCancelledGiftCardHolds(db, limit, result);
    return result;
}

/**
 * Self-heal (G4): a cancelled order that still holds gift cards (its archive
 * batch failed after the claim, or a staff cancel's release never landed)
 * gets them back, exactly once (release keys), at most `limit` per run. The
 * read starts from gift-card tender rows (the `payment_method` prefix of
 * `order_payments_provider_ref_unique`) and joins orders by key; released
 * orders are `refunded` and drop out.
 */
async function releaseLeftoverCancelledGiftCardHolds(
    db: Database,
    limit: number,
    result: StaleIncompleteOrderCleanupResult,
): Promise<void> {
    const held = await db
        .select({
            id: orders.id,
            version: orders.version,
            paymentStatus: orders.paymentStatus,
            paidAmountMinor: orders.paidAmountMinor,
        })
        .from(orderPayments)
        .innerJoin(orders, eq(orders.id, orderPayments.orderId))
        .where(and(
            eq(orderPayments.paymentMethod, GIFT_CARD_PAYMENT_METHOD),
            sql`${orderPayments.providerRef} IS NOT NULL`,
            eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
            eq(orders.status, OrderStatus.CANCELLED),
            inArray(orders.paymentStatus, [PaymentStatus.PAID, PaymentStatus.PARTIAL]),
            sql`${orders.paidAmountMinor} > 0`,
            // Settled for a while: never race a cleanup or a cancel still in flight.
            sql`${orders.updatedAt} <= unixepoch() - ${LEFTOVER_HOLD_GRACE_SECONDS}`,
        ))
        .groupBy(orders.id)
        .limit(limit);

    for (const order of held) {
        try {
            const tenders = await giftCardOnlyTenders(db, order.id, order);
            // Other money on the order: the refund flow owns it.
            if (!tenders) continue;
            await releaseCancelledOrderGiftCards(db, order.id, {
                version: order.version,
                paidAmountMinor: order.paidAmountMinor,
            }, tenders, { type: "system", id: null });
            result.releasedGiftCardHoldOrderIds?.push(order.id);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.failed++;
            result.errors.push({ orderId: order.id, error: message });
            console.error(`Failed to release gift-card holds of cancelled order ${order.id}:`, error);
        }
    }
}
