// Archiving and restoring orders (orders are never hard-deleted).
import { safeBatch, type Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { sql, eq, inArray, isNotNull, isNull, and } from "drizzle-orm";
import type { ArchiveOrdersInput } from "../validation";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { assertNoActiveShipmentClaim } from "../shipment-claim";
import {
    assertNoActiveRefundAttemptsForOrders,
    noActiveRefundAttemptForOrderIdCondition,
} from "../../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttemptsForOrders,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../../payments/payment-session-attempts";
import { assertNoActiveReturnReceipt } from "../returns/returns";
import { ARCHIVABLE_ORDER_STATUSES, getOrderArchiveStatusBlockedReason } from "../archive-policy";
import type { SQLiteBatchItem } from "./shared";

export async function restoreOrder(db: Database, id: string, expectedVersion: number) {
    const order = await db
        .select({
            id: orders.id,
            archivedAt: orders.archivedAt,
            deletedAt: orders.deletedAt,
            version: orders.version,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    if (order.deletedAt) throw new ValidationError("This legacy-deleted order cannot be restored from the archive.");
    if (!order.archivedAt) throw new ValidationError("Order is not archived");
    if (order.version !== expectedVersion) {
        throw new ConflictError("Order was modified by another request. Reload and try again.");
    }

    const restored = await db
        .update(orders)
        .set({
            archivedAt: null,
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, id),
            eq(orders.version, expectedVersion),
            isNull(orders.deletedAt),
            isNotNull(orders.archivedAt),
        ))
        .returning({ id: orders.id });

    if (restored.length === 0) {
        throw new ConflictError("Order was modified by another request. Reload and try again.");
    }
}

/**
 * Removes completed commerce records from the default admin list without
 * changing their lifecycle or destroying evidence. Archive/restore never
 * touches payment, fulfillment, returns, refunds, inventory, or order items.
 */
export async function archiveOrders(
    db: Database,
    requestedOrders: ArchiveOrdersInput["orders"],
) {
    if (requestedOrders.length === 0 || requestedOrders.length > 90) {
        throw new ValidationError("Archive between 1 and 90 orders at a time.");
    }

    const requestById = new Map<string, number>();
    for (const request of requestedOrders) {
        if (requestById.has(request.id)) {
            throw new ValidationError("Each order can appear only once.");
        }
        requestById.set(request.id, request.expectedVersion);
    }

    const requestedIds = [...requestById.keys()];
    const affectedOrders = await db
        .select({
            id: orders.id,
            status: orders.status,
            version: orders.version,
            archivedAt: orders.archivedAt,
            deletedAt: orders.deletedAt,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(inArray(orders.id, requestedIds));

    if (affectedOrders.length !== requestedIds.length) {
        throw new NotFoundError("One or more orders no longer exist. Reload and try again.");
    }

    for (const order of affectedOrders) {
        if (order.deletedAt) {
            throw new ValidationError("A legacy-deleted order cannot be archived.");
        }
        if (order.archivedAt) {
            throw new ValidationError("One or more orders are already archived. Reload and try again.");
        }
        if (order.version !== requestById.get(order.id)) {
            throw new ConflictError("One or more orders changed. Reload and review them before archiving.");
        }
        const statusReason = getOrderArchiveStatusBlockedReason(order.status);
        if (statusReason) throw new ValidationError(statusReason, { orderId: order.id });
        assertNoActiveShipmentClaim(order);
        await assertNoActiveReturnReceipt(db, order.id);
    }

    await assertNoActiveRefundAttemptsForOrders(db, requestedIds);
    await assertNoActivePaymentSessionAttemptsForOrders(db, requestedIds);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const statements = requestedOrders.map(({ id, expectedVersion }) =>
        db
            .update(orders)
            .set({
                archivedAt: sql`unixepoch()`,
                version: sql`${orders.version} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(orders.id, id),
                eq(orders.version, expectedVersion),
                isNull(orders.deletedAt),
                isNull(orders.archivedAt),
                inArray(orders.status, [...ARCHIVABLE_ORDER_STATUSES]),
                sql`(${orders.shipmentClaimId} IS NULL OR ${orders.shipmentClaimExpiresAt} IS NULL OR ${orders.shipmentClaimExpiresAt} <= ${nowSeconds})`,
                noActiveRefundAttemptForOrderIdCondition(id),
                noActivePaymentSessionAttemptForOrderIdCondition(id),
            ))
            .returning({ id: orders.id }),
    );
    const results = await safeBatch(db, statements as SQLiteBatchItem[]) as { id: string }[][];
    if (results.some((result) => !result || result.length === 0)) {
        throw new ConflictError("One or more orders changed. Reload and try again.");
    }
}
