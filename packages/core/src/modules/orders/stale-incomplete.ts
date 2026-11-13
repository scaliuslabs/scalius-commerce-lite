import { and, asc, eq, getTableColumns, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    abandonedCheckouts,
    orderPayments,
    paymentPlans,
    orders,
    OrderStatus,
    PaymentPlanStatus,
    PaymentRecordStatus,
    PaymentStatus,
} from "@scalius/database/schema";
import { prepareInventoryForStatusChange } from "../inventory";
import { isShipmentClaimHeld, isShipmentClaimLeaseLive, noActiveShipmentClaimCondition, validateTransition } from "../order-kernel";
import {
    deriveOrderPaymentState,
    isOnlinePaymentMethod,
    onlinePaymentMethodCondition,
    openProviderSessionCondition,
    paymentHoldLiveCondition,
    requestSessionCancelStatement,
} from "../payments";
import {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardReleaseStatements,
    listHeldGiftCardTenders,
} from "../gift-cards";
import { giftCardOnlyTenders, releaseCancelledOrderGiftCards } from "./status/lifecycle";
import { qualifiedColumn } from "../../utils/qualified-column";

export const DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT = 25;
export const MAX_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT = 100;
const STALE_GIFT_CARD_RELEASE_CONFLICT = "stale_gift_card_release_conflict";
const STALE_ORDER_CLAIM_CONFLICT = "stale_order_claim_conflict";
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


// A gift-card tender is not a gateway claim: it is the hold this cleanup
// releases. Any other pending or succeeded row keeps the order for payment
// recovery.
const noActivePaymentClaimCondition = sql`NOT EXISTS (
    SELECT 1 FROM ${orderPayments}
    WHERE ${orderPayments.orderId} = ${orders.id}
      AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.AUTHORIZED}, ${PaymentRecordStatus.SUCCEEDED})
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

/** The swept order's own id, qualified: a bare column would bind to the attempt's row inside a subquery. */
const sweptOrderId = qualifiedColumn(orders.id);

export interface StaleIncompleteOrderCleanupOptions {
    limit?: number;
    afterOrderId?: string;
    afterGiftCardOrderId?: string;
    /** The sweep's clock (epoch seconds); defaults to now. */
    nowSeconds?: number;
}

export interface StaleIncompleteOrderCleanupResult {
    found: number;
    limit: number;
    hasMore: boolean;
    archived: number;
    failed: number;
    archivedOrderIds: string[];
    /** Orders whose hold ended with provider sessions still open: those sessions are being closed first. */
    cancellingSessionOrderIds: string[];
    errors: Array<{ orderId: string; error: string }>;
    /** Cancelled orders whose leftover gift-card holds this run gave back (self-heal). */
    releasedGiftCardHoldOrderIds?: string[];
    lastOrderId?: string | null;
    lastGiftCardOrderId?: string | null;
}

function normalizeCleanupLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT;
    if (!Number.isFinite(limit)) return DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT;
    return Math.max(1, Math.min(MAX_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT, Math.floor(limit)));
}

/**
 * A batch failed: does the claim's precondition still hold? When it does not,
 * the order moved (a payment, another sweep) and is left alone; when it does,
 * the failure was something else (stock, an error) and counts as one.
 */
async function claimStillHolds(db: Database, claimable: SQL): Promise<boolean> {
    return Boolean(await db.select({ id: orders.id }).from(orders).where(claimable).get());
}

/**
 * Cancel and archive stale online-checkout orders that never became payable.
 *
 * This intentionally handles only `incomplete` orders that took no gateway
 * money and have no active gateway claim: unpaid/failed ones, and ones whose
 * only payment is a gift-card tender (the gateway never took the rest). The
 * archive batch gives those gift cards back exactly once (G4). Orders with
 * gateway money are left alone for payment recovery/reconciliation flows.
 *
 * The hold counts from the buyer's last payment attempt, not from the order
 * (`paymentHoldLiveCondition`): `cutoffTimestamp` is the hold's length before
 * now. An order whose hold ended with provider sessions still open is not
 * cancelled yet: its batch turns those sessions into cancel commands under
 * the same claim, the drain closes them at the provider, and a later run
 * cancels and archives the order (session-lifecycle.ts).
 */
export async function archiveStaleIncompleteOrders(
    db: Database,
    cutoffTimestamp: number,
    options: StaleIncompleteOrderCleanupOptions = {},
): Promise<StaleIncompleteOrderCleanupResult> {
    const limit = normalizeCleanupLimit(options.limit);
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const holdEnded = sql`NOT ${paymentHoldLiveCondition(sweptOrderId, qualifiedColumn(orders.createdAt), cutoffTimestamp, nowSeconds)}`;
    const result: StaleIncompleteOrderCleanupResult = {
        found: 0,
        limit,
        hasMore: false,
        archived: 0,
        failed: 0,
        archivedOrderIds: [],
        cancellingSessionOrderIds: [],
        errors: [],
        releasedGiftCardHoldOrderIds: [],
    };

    // The status index is the only one this read may use: the unary `+` keeps
    // `deleted_at`, `created_at` and the cursor's `id` off every other index
    // (deleted_at and created_at lead several, the id is the primary key),
    // whose range would walk every live order the store ever took.
    const candidates = await db.select({
        ...getTableColumns(orders),
        // Provider sessions the buyer could still pay: closed before the order is let go.
        hasOpenSession: sql<number>`CASE WHEN ${openProviderSessionCondition(sweptOrderId)} THEN 1 ELSE 0 END`.mapWith(Number),
    }).from(orders).where(
        and(
            eq(orders.status, OrderStatus.INCOMPLETE),
            options.afterOrderId ? sql`+${orders.id} > ${options.afterOrderId}` : undefined,
            onlinePaymentMethodCondition(orders.paymentMethod),
            inArray(orders.paymentStatus, STALE_INCOMPLETE_PAYMENT_STATUSES),
            onlyGiftCardMoneyCondition,
            sql`+${orders.createdAt} <= ${cutoffTimestamp}`,
            sql`+${orders.deletedAt} IS NULL`,
            noActiveShipmentClaimCondition(),
            noActivePaymentClaimCondition,
            holdEnded,
        ),
    ).orderBy(asc(orders.id)).limit(limit + 1);

    const incompleteOrders = candidates.slice(0, limit);
    result.found = incompleteOrders.length;
    result.lastOrderId = incompleteOrders.at(-1)?.id ?? null;
    result.hasMore = candidates.length > limit;

    for (const { hasOpenSession, ...order } of incompleteOrders) {
        try {
            const paymentStatus = order.paymentStatus as RecoverableStalePaymentStatus;
            if (!STALE_INCOMPLETE_PAYMENT_STATUSES.includes(paymentStatus)) {
                continue;
            }

            const paymentMethod = order.paymentMethod;
            if (!isOnlinePaymentMethod(paymentMethod)) {
                continue;
            }

            // The read's SQL guard vetted an expired claim's attempt; a running or
            // held claim on a row a stale plan returned still locks.
            if (isShipmentClaimLeaseLive(order) || isShipmentClaimHeld(order)) {
                continue;
            }

            const stillOrdered = and(
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
                holdEnded,
            )!;
            if (hasOpenSession) {
                // The hold ended with sessions the buyer could still pay: close
                // them first (durable commands, under this claim); the order
                // keeps its stock until a later run finds them closed.
                const authority = sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${stillOrdered})`;
                await safeBatch(db, [
                    buildBatchGuard(db, authority, STALE_ORDER_CLAIM_CONFLICT),
                    requestSessionCancelStatement(db, order.id, authority),
                ] as never).catch(async (error: unknown) => {
                    // The buyer came back (or a payment landed) since the read: leave it.
                    if (isBatchGuardError(error, STALE_ORDER_CLAIM_CONFLICT) && !(await claimStillHolds(db, stillOrdered))) return;
                    throw error;
                });
                result.cancellingSessionOrderIds.push(order.id);
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

            validateTransition("order", order.status, OrderStatus.CANCELLED);
            const claimedVersion = order.version + 1;
            const finalizedVersion = claimedVersion + 1;
            // Every gift card goes back: the order's money as its ledger will read after the release.
            const released = release.releasedMinor > 0
                ? deriveOrderPaymentState({
                    totalAmountMinor: order.totalAmountMinor,
                    ledger: { receivedMinor: release.releasedMinor, returnedMinor: release.releasedMinor },
                })
                : null;
            const finalPaymentStatus = released?.paymentStatus ?? paymentStatus;
            // The stock this abandoned checkout holds goes back in the same
            // batch as its cancel: a death between them would leave a
            // cancelled order holding stock that no sweep selects again.
            const inventory = order.inventoryAction === "reserved" || order.inventoryAction === "deducted"
                ? await prepareInventoryForStatusChange(db, order.id, OrderStatus.CANCELLED)
                : null;

            // Every session it handed out is closed (or never existed).
            const claimable = and(stillOrdered, sql`NOT ${openProviderSessionCondition(sweptOrderId)}`)!;
            try {
                await safeBatch(db, [
                    // The claim's own precondition first: a lost claim writes nothing.
                    buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${claimable})`, STALE_ORDER_CLAIM_CONFLICT),
                    db.update(orders)
                        .set({
                            status: OrderStatus.CANCELLED,
                            version: claimedVersion,
                            updatedAt: sql`unixepoch()`,
                        })
                        .where(claimable),
                    ...(inventory?.statements ?? []),
                    db.update(orders)
                        .set({
                            deletedAt: sql`unixepoch()`,
                            inventoryAction: "restored",
                            ...(released
                                ? {
                                    paidAmountMinor: released.paidAmountMinor,
                                    balanceDueMinor: released.balanceDueMinor,
                                    paymentStatus: released.paymentStatus,
                                }
                                : {}),
                            version: finalizedVersion,
                            updatedAt: sql`unixepoch()`,
                        })
                        .where(and(
                            eq(orders.id, order.id),
                            eq(orders.version, claimedVersion),
                            eq(orders.status, OrderStatus.CANCELLED),
                        )),
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
                    db.insert(abandonedCheckouts).values({
                        id: `ab_ch_sys_${order.id}`,
                        checkoutId: order.id,
                        customerPhone: order.customerPhone,
                        checkoutData: JSON.stringify(order),
                        createdAt: order.createdAt || new Date(),
                        updatedAt: order.updatedAt || new Date(),
                    }).onConflictDoNothing(),
                ] as never);
            } catch (error: unknown) {
                // The order moved since the read (another sweep, a payment): leave it.
                if (isBatchGuardError(error, STALE_ORDER_CLAIM_CONFLICT) && !(await claimStillHolds(db, claimable))) {
                    continue;
                }
                throw inventory?.translateError(error) ?? error;
            }
            await inventory?.afterCommit();

            result.archived++;
            result.archivedOrderIds.push(order.id);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.failed++;
            result.errors.push({ orderId: order.id, error: message });
            console.error(`Failed to archive stale incomplete order ${order.id}:`, error);
        }
    }

    await releaseLeftoverCancelledGiftCardHolds(db, limit, result, options.afterGiftCardOrderId);
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
    afterOrderId?: string,
): Promise<void> {
    const held = await db
        .select({
            id: orders.id,
            version: orders.version,
            paymentStatus: orders.paymentStatus,
            paidAmountMinor: orders.paidAmountMinor,
            totalAmountMinor: orders.totalAmountMinor,
        })
        .from(orderPayments)
        .innerJoin(orders, eq(orders.id, orderPayments.orderId))
        .where(and(
            eq(orderPayments.paymentMethod, GIFT_CARD_PAYMENT_METHOD),
            afterOrderId ? gt(orders.id, afterOrderId) : undefined,
            sql`${orderPayments.providerRef} IS NOT NULL`,
            eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
            eq(orders.status, OrderStatus.CANCELLED),
            inArray(orders.paymentStatus, [PaymentStatus.PAID, PaymentStatus.PARTIAL]),
            sql`${orders.paidAmountMinor} > 0`,
            // Settled for a while: never race a cleanup or a cancel still in flight.
            sql`${orders.updatedAt} <= unixepoch() - ${LEFTOVER_HOLD_GRACE_SECONDS}`,
        ))
        .groupBy(orders.id)
        .orderBy(asc(orders.id))
        .limit(limit);
    result.lastGiftCardOrderId = held.at(-1)?.id ?? null;

    for (const order of held) {
        try {
            const tenders = await giftCardOnlyTenders(db, order.id, order);
            // Other money on the order: the refund flow owns it.
            if (!tenders) continue;
            await releaseCancelledOrderGiftCards(db, order.id, {
                version: order.version,
                paidAmountMinor: order.paidAmountMinor,
                totalAmountMinor: order.totalAmountMinor,
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
