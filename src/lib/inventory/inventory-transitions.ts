// src/lib/inventory/inventory-transitions.ts
// Centralized, idempotent inventory adjustment logic for order status changes.
//
// This module is the SINGLE SOURCE OF TRUTH for how inventory reacts to
// order status transitions. Every endpoint that changes order status must
// call applyInventoryForStatusChange() instead of manually adjusting stock.

import { eq, sql } from "drizzle-orm";
import { orders, orderItems, productVariants, InventoryPool } from "@/db/schema";
import type { Database } from "@/db";
import { releaseMultiple } from "./release";
import { deductMultiple } from "./deduct";
import { recordMovement } from "./movements";
import { checkAndAlertLowStock } from "./alerts";

// The set of order statuses that mean "this order is dead / returned"
const STOCK_RESTORE_STATUSES = new Set(["cancelled", "returned", "refunded"]);

// The set of order statuses that mean "this order is confirmed / active" 
// (Triggers permanent stock deduction from reservations)
const STOCK_DEDUCT_STATUSES = new Set([
    "pending",
    "processing",
    "confirmed",
    "shipped",
    "delivered",
    "completed"
]);

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
            // Restore physical stock (stock++)
            await restoreOrderStock(db, orderId);
            await updateInventoryAction(db, orderId, "restored");
            return "restored";
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
 * Restore physical stock for all items in an order.
 * Used when a paid/shipped order is cancelled or returned.
 */
async function restoreOrderStock(
    db: Database,
    orderId: string,
): Promise<void> {
    const items = await db
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .all();

    for (const item of items) {
        if (item.variantId) {
            // Read current stock for movement logging
            const variant = await db
                .select({ stock: productVariants.stock })
                .from(productVariants)
                .where(eq(productVariants.id, item.variantId))
                .get();

            const previousStock = variant?.stock ?? 0;
            const newStock = previousStock + item.quantity;

            await db
                .update(productVariants)
                .set({
                    stock: sql`${productVariants.stock} + ${item.quantity}`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(productVariants.id, item.variantId));

            await recordMovement(db, {
                variantId: item.variantId,
                orderId,
                type: "restored",
                quantity: item.quantity,
                previousStock,
                newStock,
                notes: `Stock restored — order ${orderId} cancelled/returned`,
            });
        }
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
