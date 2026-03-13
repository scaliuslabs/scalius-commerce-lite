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
    // 1. Read current order state
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

    if (!order) return "none";

    const currentAction = order.inventoryAction as InventoryAction;
    const needsRestore = STOCK_RESTORE_STATUSES.has(newStatus);
    const needsDeduct = STOCK_DEDUCT_STATUSES.has(newStatus);

    // 2. Determine the correct transition
    if (needsRestore) {
        // Transitioning to a "dead" status → restore inventory if applicable
        if (currentAction === "reserved") {
            // Release reservations (reservedStock--)
            await releaseOrderReservations(db, orderId, order.inventoryPool);
            await updateInventoryAction(db, orderId, "restored");
            return "restored";
        }

        if (currentAction === "deducted") {
            // Stock was already permanently deducted (order was shipped).
            // Do NOT auto-restore — admin must manually adjust inventory
            // after physically confirming stock is returned to warehouse.
            return "deducted";
        }

        // currentAction is "none" or "restored" → no-op (nothing to undo)
        return currentAction;
    }

    if (needsDeduct) {
        // Transitioning to an active/confirmed status
        if (currentAction === "reserved") {
            // Permanently deduct stock using the reservations
            await deductOrderStock(db, orderId, order.inventoryPool);
            await updateInventoryAction(db, orderId, "deducted");
            return "deducted";
        }
    }

    // Transitioning AWAY from a "dead" status back to an active one
    // (e.g. cancelled → pending). We do NOT re-deduct stock here.
    // The admin must explicitly manage stock if they reactivate an order.
    // This prevents accidental double-deductions.
    return currentAction;
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
 * Update the inventoryAction field on an order.
 */
async function updateInventoryAction(
    db: Database,
    orderId: string,
    action: InventoryAction,
): Promise<void> {
    await db
        .update(orders)
        .set({
            inventoryAction: action,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, orderId));
}
