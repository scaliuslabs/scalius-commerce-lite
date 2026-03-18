// src/lib/inventory/inventory-transitions.ts
// Centralized, idempotent inventory adjustment logic for order status changes.
//
// This module is the SINGLE SOURCE OF TRUTH for how inventory reacts to
// order status transitions. Every endpoint that changes order status must
// call applyInventoryForStatusChange() instead of manually adjusting stock.

import { eq, sql } from "drizzle-orm";
import { orders, orderItems, InventoryPool } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { releaseMultiple } from "./release";
import { deductMultiple } from "./deduct";
import { reserveMultiple } from "./reserve";
import { checkAndAlertLowStock } from "./alerts";

// The set of order statuses that mean "this order is dead / returned"
const STOCK_RESTORE_STATUSES = new Set(["cancelled", "returned", "refunded"]);

// Stock is only permanently deducted when the order ships.
// Pre-ship statuses (pending, processing, confirmed) keep stock as "reserved".
const STOCK_DEDUCT_STATUSES = new Set(["shipped"]);

/**
 * Inventory action values tracked on each order:
 *
 *   "none"     — No inventory action yet (e.g. incomplete checkout)
 *   "reserved" — reservedStock was incremented (storefront checkout placed)
 *   "deducted" — stock was decremented & reservation released (payment confirmed / admin order)
 *   "restored" — stock was added back (order cancelled or returned after deduction)
 */
export type InventoryAction = "none" | "reserved" | "deducted" | "restored";

/**
 * Build inventory SQL statements for a status change WITHOUT executing them.
 * Used by callers that need to include inventory in a larger db.batch().
 *
 * The CAS-based stock operations (deductOrderStock / releaseOrderReservations)
 * still execute internally — they have their own multi-row update logic.
 * What we batch with callers is only the inventoryAction flag update on the order.
 *
 * Returns empty statements array if no inventory action is needed.
 */
export async function buildInventoryStatements(
    db: Database,
    orderId: string,
    newStatus: string,
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch statements require any[] return type
): Promise<{ statements: any[]; newAction: InventoryAction }> {
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();

    if (!order) return { statements: [], newAction: "none" };

    const currentAction = order.inventoryAction as InventoryAction;
    const needsRestore = STOCK_RESTORE_STATUSES.has(newStatus);
    const needsDeduct = STOCK_DEDUCT_STATUSES.has(newStatus);

    if (needsRestore && currentAction === "reserved") {
        // Release reservations — uses its own DB calls (CAS-based)
        await releaseOrderReservations(db, orderId, order.inventoryPool);
        return {
            statements: [
                db.update(orders)
                    .set({ inventoryAction: "restored", updatedAt: sql`unixepoch()` })
                    .where(eq(orders.id, orderId)),
            ],
            newAction: "restored",
        };
    }

    if (needsDeduct && currentAction === "reserved") {
        // Permanently deduct stock — uses its own DB calls (CAS-based)
        await deductOrderStock(db, orderId, order.inventoryPool);
        return {
            statements: [
                db.update(orders)
                    .set({ inventoryAction: "deducted", updatedAt: sql`unixepoch()` })
                    .where(eq(orders.id, orderId)),
            ],
            newAction: "deducted",
        };
    }

    // Re-reservation: when an admin reactivates a cancelled order (restored → pending/confirmed),
    // inventory was already released during cancellation. We need to re-reserve stock so that the
    // order items are accounted for again. This mirrors the initial storefront checkout reservation.
    const needsReReserve = !needsRestore && !needsDeduct && currentAction === "restored";
    if (needsReReserve) {
        await reserveOrderItems(db, orderId, order.inventoryPool);
        return {
            statements: [
                db.update(orders)
                    .set({ inventoryAction: "reserved", updatedAt: sql`unixepoch()` })
                    .where(eq(orders.id, orderId)),
            ],
            newAction: "reserved",
        };
    }

    return { statements: [], newAction: currentAction };
}

/**
 * Apply the correct inventory adjustment when an order's status changes.
 *
 * This function is IDEMPOTENT: calling it multiple times with the same
 * transition will only adjust inventory once, because it reads the current
 * `inventoryAction` from the order and only acts if a transition is valid.
 *
 * Returns the new inventoryAction value (or the same one if no-op).
 */
export async function applyInventoryForStatusChange(
    db: Database,
    orderId: string,
    newStatus: string,
): Promise<InventoryAction> {
    const { statements, newAction } = await buildInventoryStatements(db, orderId, newStatus);
    if (statements.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        await db.batch(statements as any);
    }
    return newAction;
}

/**
 * Deduct physical stock permanently for all items in an order.
 * Used when an order transitions from reserved to confirmed/active.
 */
async function deductOrderStock(
    db: Database,
    orderId: string,
    inventoryPool: string,
): Promise<void> {
    const items = await db
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .all();

    const pool = (inventoryPool ?? InventoryPool.REGULAR) as
        | "regular"
        | "preorder"
        | "backorder";

    const entries = items
        .filter((i) => i.variantId !== null)
        .map((i) => ({
            variantId: i.variantId as string,
            quantity: i.quantity,
            pool,
        }));

    if (entries.length > 0) {
        const deductResult = await deductMultiple(db, entries, orderId);
        if (!deductResult.success) {
            console.error(
                `[inventory-transitions] Failed to deduct stock for order ${orderId}: ${deductResult.error}`
            );
        } else {
            // Check low-stock alerts for each deducted variant
            for (const entry of entries) {
                await checkAndAlertLowStock(db, entry.variantId);
            }
        }
    }
}

/**
 * Release reservations for all items in an order.
 * Used when a storefront order is cancelled before payment.
 */
async function releaseOrderReservations(
    db: Database,
    orderId: string,
    inventoryPool: string,
): Promise<void> {
    const items = await db
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .all();

    const pool = (inventoryPool ?? InventoryPool.REGULAR) as
        | "regular"
        | "preorder"
        | "backorder";

    const entries = items
        .filter((i) => i.variantId !== null)
        .map((i) => ({
            variantId: i.variantId as string,
            quantity: i.quantity,
            pool,
        }));

    if (entries.length > 0) {
        await releaseMultiple(db, entries, orderId);
    }
}

/**
 * Re-reserve stock for all items in an order.
 * Used when an admin reactivates a cancelled order (cancelled → pending/confirmed).
 * Stock was released on cancellation; this re-reserves it.
 */
async function reserveOrderItems(
    db: Database,
    orderId: string,
    inventoryPool: string,
): Promise<void> {
    const items = await db
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .all();

    const pool = (inventoryPool ?? InventoryPool.REGULAR) as
        | "regular"
        | "preorder"
        | "backorder";

    const entries = items
        .filter((i) => i.variantId !== null)
        .map((i) => ({
            variantId: i.variantId as string,
            quantity: i.quantity,
            pool,
        }));

    if (entries.length > 0) {
        const result = await reserveMultiple(db, entries, orderId);
        if (!result.success) {
            console.error(
                `[inventory-transitions] Failed to re-reserve stock for order ${orderId}: ${result.error}`
            );
        }
    }
}
