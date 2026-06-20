import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import {
    abandonedCheckouts,
    orderPayments,
    paymentPlans,
    paymentSessionAttempts,
    orders,
    OrderStatus,
    PaymentMethod,
    PaymentPlanStatus,
    PaymentRecordStatus,
    PaymentStatus,
} from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "../inventory";
import { hasActiveShipmentClaim, noActiveShipmentClaimCondition } from "./shipment-claim";

export const DEFAULT_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT = 25;
export const MAX_STALE_INCOMPLETE_ORDER_CLEANUP_LIMIT = 100;

type RecoverableStalePaymentStatus =
    | typeof PaymentStatus.UNPAID
    | typeof PaymentStatus.FAILED;

const STALE_INCOMPLETE_PAYMENT_STATUSES: RecoverableStalePaymentStatus[] = [
    PaymentStatus.UNPAID,
    PaymentStatus.FAILED,
];

type HostedPaymentMethod =
    | typeof PaymentMethod.STRIPE
    | typeof PaymentMethod.SSLCOMMERZ
    | typeof PaymentMethod.POLAR;

const HOSTED_PAYMENT_METHODS: HostedPaymentMethod[] = [
    PaymentMethod.STRIPE,
    PaymentMethod.SSLCOMMERZ,
    PaymentMethod.POLAR,
];

const noActivePaymentClaimCondition = sql`NOT EXISTS (
    SELECT 1 FROM ${orderPayments}
    WHERE ${orderPayments.orderId} = ${orders.id}
      AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.SUCCEEDED})
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
 * This intentionally handles only unpaid/failed `incomplete` orders with no
 * active local payment claim. Paid/partial orders and currently processing
 * gateway attempts are left alone for payment recovery/reconciliation flows.
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
    };

    const candidates = await db.select().from(orders).where(
        and(
            eq(orders.status, OrderStatus.INCOMPLETE),
            inArray(orders.paymentMethod, HOSTED_PAYMENT_METHODS),
            inArray(orders.paymentStatus, STALE_INCOMPLETE_PAYMENT_STATUSES),
            sql`${orders.paidAmount} <= 0`,
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

            const paymentMethod = order.paymentMethod as HostedPaymentMethod;
            if (!HOSTED_PAYMENT_METHODS.includes(paymentMethod)) {
                continue;
            }

            if (hasActiveShipmentClaim(order)) {
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
                    sql`${orders.paidAmount} <= 0`,
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

            const finalizedVersion = claimedVersion + 1;
            const [finalized] = await safeBatch(db, [
                db.update(orders)
                    .set({
                        deletedAt: sql`unixepoch()`,
                        inventoryAction: "restored",
                        version: sql`${orders.version} + 1`,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(and(
                        eq(orders.id, order.id),
                        eq(orders.version, claimedVersion),
                        eq(orders.status, OrderStatus.CANCELLED),
                        eq(orders.paymentMethod, paymentMethod),
                        eq(orders.paymentStatus, paymentStatus),
                        isNull(orders.deletedAt),
                        noActivePaymentClaimCondition,
                    ))
                    .returning({ id: orders.id }),
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
                              AND ${orders.paymentStatus} = ${paymentStatus}
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

    return result;
}
