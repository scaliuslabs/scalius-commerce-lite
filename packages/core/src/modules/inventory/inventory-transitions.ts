// src/lib/inventory/inventory-transitions.ts
// Centralized, idempotent inventory adjustment logic for order status changes.
//
// This module is the SINGLE SOURCE OF TRUTH for how inventory reacts to
// order status transitions. Every endpoint that changes order status must
// call applyInventoryForStatusChange() instead of manually adjusting stock.

import { and, eq, inArray, sql } from "drizzle-orm";
import { inventoryMovements, orders, orderItems, InventoryPool, productVariants } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { reserveStockBatch, type ReservationBatchItem } from "./reserve";
import { checkAndAlertLowStock } from "./alerts";
import type { ReservationEntry, StockOperationResult } from "./types";

// The set of order statuses that mean "this order is dead / returned"
const STOCK_RESTORE_STATUSES = new Set(["cancelled", "returned", "refunded"]);

// Stock is permanently deducted when the order ships. A delivered webhook can
// arrive before the local order was marked shipped, so delivered also deducts
// reserved stock when needed.
// Pre-ship statuses (pending, processing, confirmed) keep stock as "reserved".
const STOCK_DEDUCT_STATUSES = new Set(["shipped", "delivered"]);
const STOCK_RESERVABLE_STATUSES = new Set(["incomplete", "pending", "processing", "confirmed"]);
const MAX_TRANSITION_RETRIES = 3;
const BASE_TRANSITION_BACKOFF_MS = 50;

export function isStockRestoreStatus(status: string): boolean {
    return STOCK_RESTORE_STATUSES.has(status);
}

export function isStockDeductStatus(status: string): boolean {
    return STOCK_DEDUCT_STATUSES.has(status);
}

export function isStockReservableStatus(status: string): boolean {
    return STOCK_RESERVABLE_STATUSES.has(status);
}

/**
 * Inventory action values tracked on each order:
 *
 *   "none"     — No inventory action yet (e.g. incomplete checkout)
 *   "reserved" — reservedStock was incremented (storefront checkout placed)
 *   "deducted" — stock was decremented & reservation released (payment confirmed / admin order)
 *   "restored" — stock was added back (order cancelled or returned after deduction)
 */
export type InventoryAction = "none" | "reserved" | "deducted" | "restored";
type InventoryPoolName = "regular" | "preorder" | "backorder";
type InventoryTransitionOperation = "deduct" | "release" | "reserve" | "restore";
type StrictMovementOperation = Exclude<InventoryTransitionOperation, "reserve">;

interface InventoryTransitionResult {
    success: boolean;
    results: StockOperationResult[];
    error?: string;
}

type InventoryTransitionOrder = {
    id: string;
    status: string;
    inventoryAction: string;
    inventoryPool: string;
    version: number;
};

type InventoryVariantState = {
    id: string;
    stock: number;
    reservedStock: number;
    preorderStock: number;
    stockVersion: number;
};

type InventoryTransitionMovementClaim = {
    id: string;
    variantId: string;
    orderId: string;
    type: "deducted" | "preorder_deducted" | "released" | "restored";
    quantity: number;
    previousStock: number;
    newStock: number;
    notes: string;
};

/**
 * Build inventory SQL statements for a status change WITHOUT executing them.
 * Used by callers that need to include inventory in a larger db.batch().
 *
 * The CAS-based stock operations (deductOrderStock / releaseOrderReservations)
 * still execute internally — they have their own multi-row update logic.
 * What we batch with callers is only the inventoryAction flag update on the order.
 * If any stock operation fails, this throws before returning statements so the
 * order cannot be marked as if the inventory transition succeeded.
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
            version: orders.version,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get() as InventoryTransitionOrder | undefined;

    if (!order) return { statements: [], newAction: "none" };

    const currentAction = order.inventoryAction as InventoryAction;
    const needsRestore = STOCK_RESTORE_STATUSES.has(newStatus);
    const needsDeduct = STOCK_DEDUCT_STATUSES.has(newStatus);

    if (needsRestore && currentAction === "reserved") {
        await releaseOrderReservations(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "restored")],
            newAction: "restored",
        };
    }

    if (needsRestore && currentAction === "deducted") {
        await restoreDeductedOrderStock(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "restored")],
            newAction: "restored",
        };
    }

    if (needsDeduct && currentAction === "reserved") {
        await deductOrderStock(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "deducted")],
            newAction: "deducted",
        };
    }

    // Re-reservation: when an admin reactivates a cancelled order (restored → pending/confirmed),
    // inventory was already released during cancellation. We need to re-reserve stock so that the
    // order items are accounted for again. This mirrors the initial storefront checkout reservation.
    const needsReReserve = isStockReservableStatus(newStatus) && currentAction === "restored";
    if (needsReReserve) {
        await reserveOrderItems(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "reserved")],
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
        const results = await safeBatch(db, statements as never) as { id: string }[][];
        const missedActionUpdate = results.some((result) => !result || result.length === 0);
        if (missedActionUpdate) {
            const current = await db
                .select({ inventoryAction: orders.inventoryAction })
                .from(orders)
                .where(eq(orders.id, orderId))
                .get();
            if (current?.inventoryAction !== newAction) {
                throw new ValidationError(
                    `Inventory action update conflicted for order ${orderId}`,
                    { orderId, expectedInventoryAction: newAction, actualInventoryAction: current?.inventoryAction },
                );
            }
        }
    }
    return newAction;
}

/**
 * Deduct physical stock permanently for all items in an order.
 * Used when an order transitions from reserved to confirmed/active.
 */
function buildInventoryActionUpdate(
    db: Database,
    order: InventoryTransitionOrder,
    inventoryAction: InventoryAction,
) {
    return db.update(orders)
        .set({ inventoryAction, updatedAt: sql`unixepoch()` })
        .where(
            and(
                eq(orders.id, order.id),
                eq(orders.inventoryAction, order.inventoryAction),
            ),
        )
        .returning({ id: orders.id });
}

async function deductOrderStock(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<void> {
    const entries = await getOrderInventoryEntries(db, order.id, order.inventoryPool);

    if (entries.length > 0) {
        await applyStrictInventoryTransitionMovements(db, order, "deduct", entries);
    }
}

/**
 * Release reservations for all items in an order.
 * Used when a storefront order is cancelled before payment.
 */
async function releaseOrderReservations(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<void> {
    const entries = await getOrderInventoryEntries(db, order.id, order.inventoryPool);

    if (entries.length > 0) {
        await applyStrictInventoryTransitionMovements(db, order, "release", entries);
    }
}

/**
 * Re-reserve stock for all items in an order.
 * Used when an admin reactivates a cancelled order (cancelled → pending/confirmed).
 * Stock was released on cancellation; this re-reserves it.
 */
async function reserveOrderItems(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<void> {
    const entries = await getOrderInventoryEntries(db, order.id, order.inventoryPool);

    if (entries.length > 0) {
        const batchItems = await buildTransitionReservationBatchItems(db, order, entries);
        const result = await reserveStockBatch(db, batchItems, normalizeInventoryPool(order.inventoryPool));
        assertInventoryTransitionSucceeded(order.id, "reserve", result);
    }
}

/**
 * Restore deducted stock for all items in an order.
 * Used when a shipped/delivered order is cancelled or returned.
 * Physical stock was permanently decremented at ship time — this adds it back.
 */
async function restoreDeductedOrderStock(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<void> {
    const entries = await getOrderInventoryEntries(db, order.id, order.inventoryPool);

    if (entries.length > 0) {
        await applyStrictInventoryTransitionMovements(db, order, "restore", entries);
    }
}

async function applyStrictInventoryTransitionMovements(
    db: Database,
    order: InventoryTransitionOrder,
    operation: StrictMovementOperation,
    entries: ReservationEntry[],
): Promise<void> {
    const pool = normalizeInventoryPool(order.inventoryPool);
    const mergedEntries = mergeTransitionEntriesByVariant(entries, pool);
    if (mergedEntries.length === 0) return;

    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt++) {
        const variants = await loadTransitionVariantStates(db, order.id, operation, mergedEntries);
        const movementClaims = await buildTransitionMovementClaims(db, order, operation, mergedEntries, variants, pool);
        const movementQueries = movementClaims.map((claim) =>
            buildTransitionMovementInsert(db, claim, variants.get(claim.variantId)!),
        );
        const updateQueries = mergedEntries.map((entry) =>
            buildTransitionVariantUpdate(db, operation, entry, variants.get(entry.variantId)!, pool),
        );

        let batchResults: { id: string }[][];
        try {
            batchResults = await safeBatch(db, [...movementQueries, ...updateQueries] as never) as { id: string }[][];
        } catch (err: unknown) {
            const duplicateResolved = await resolveDuplicateTransitionMovements(
                db,
                order.id,
                operation,
                movementClaims,
                mergedEntries,
                err,
            );
            if (duplicateResolved) {
                await checkLowStockForTransitionEntries(db, mergedEntries);
                return;
            }

            console.error(`[inventory/transition] ${operation} batch execution failed for order ${order.id}:`, err);
            throwInventoryTransitionError(order.id, operation, {
                success: false,
                results: mergedEntries.map((entry) => ({
                    success: false,
                    variantId: entry.variantId,
                    previousStock: 0,
                    newStock: 0,
                    error: "Batch execution failed",
                })),
                error: "Batch execution failed",
            });
        }

        const failedMovementIndices: number[] = [];
        const insertedMovementIds: string[] = [];
        for (let i = 0; i < movementClaims.length; i++) {
            const batchResult = batchResults[i];
            if (!batchResult || batchResult.length === 0) {
                failedMovementIndices.push(i);
            } else {
                insertedMovementIds.push(movementClaims[i]!.id);
            }
        }

        const failedUpdateIndices: number[] = [];
        for (let i = 0; i < updateQueries.length; i++) {
            const batchResult = batchResults[movementQueries.length + i];
            if (!batchResult || batchResult.length === 0) {
                failedUpdateIndices.push(i);
            }
        }

        if (failedMovementIndices.length > 0 || failedUpdateIndices.length > 0) {
            const rollbackQueries = mergedEntries
                .filter((_, i) => !failedUpdateIndices.includes(i))
                .map((entry) => buildTransitionVariantRollback(db, operation, entry, pool));
            const movementRollbackQueries = insertedMovementIds.map((id) =>
                db.delete(inventoryMovements).where(eq(inventoryMovements.id, id)),
            );

            if (rollbackQueries.length > 0 || movementRollbackQueries.length > 0) {
                try {
                    await safeBatch(db, [...movementRollbackQueries, ...rollbackQueries] as never);
                } catch (rollbackErr: unknown) {
                    console.error(`[inventory/transition] ${operation} rollback failed for order ${order.id}:`, rollbackErr);
                }
            }

            if (attempt < MAX_TRANSITION_RETRIES - 1) {
                const backoff = BASE_TRANSITION_BACKOFF_MS * Math.pow(2, attempt);
                await new Promise((resolve) => setTimeout(resolve, backoff));
                continue;
            }

            throwInventoryTransitionError(order.id, operation, {
                success: false,
                results: mergedEntries.map((entry, i) => {
                    const movementFailed = failedMovementIndices.some(
                        (movementIndex) => movementClaims[movementIndex]?.variantId === entry.variantId,
                    );
                    const updateFailed = failedUpdateIndices.includes(i);
                    return {
                        success: !movementFailed && !updateFailed,
                        variantId: entry.variantId,
                        previousStock: 0,
                        newStock: 0,
                        error: updateFailed
                            ? `CAS conflict for variant ${entry.variantId}`
                            : movementFailed
                                ? `Inventory ${operation} claim conflict for variant ${entry.variantId}`
                                : undefined,
                    };
                }),
                error: `Failed to ${operation} stock after ${MAX_TRANSITION_RETRIES} retries due to concurrent modifications`,
            });
        }

        await checkLowStockForTransitionEntries(db, mergedEntries);
        return;
    }
}

async function buildTransitionReservationBatchItems(
    db: Database,
    order: InventoryTransitionOrder,
    entries: ReservationEntry[],
): Promise<ReservationBatchItem[]> {
    const pool = normalizeInventoryPool(order.inventoryPool);
    const mergedEntries = mergeTransitionEntriesByVariant(entries, pool);
    return Promise.all(mergedEntries.map(async (entry) => ({
        variantId: entry.variantId,
        quantity: entry.quantity,
        orderId: order.id,
        movementId: await createTransitionMovementId({
            orderId: order.id,
            variantId: entry.variantId,
            operation: "reserve",
            pool,
            generation: await loadTransitionMovementGeneration(db, order.id, entry.variantId, "reserve"),
        }),
    })));
}

function mergeTransitionEntriesByVariant(
    entries: ReservationEntry[],
    pool: InventoryPoolName,
): ReservationEntry[] {
    const merged = new Map<string, ReservationEntry>();
    for (const entry of entries) {
        const existing = merged.get(entry.variantId);
        if (existing) {
            existing.quantity += entry.quantity;
        } else {
            merged.set(entry.variantId, {
                variantId: entry.variantId,
                quantity: entry.quantity,
                pool,
            });
        }
    }
    return Array.from(merged.values());
}

async function loadTransitionVariantStates(
    db: Database,
    orderId: string,
    operation: InventoryTransitionOperation,
    entries: ReservationEntry[],
): Promise<Map<string, InventoryVariantState>> {
    const variants = new Map<string, InventoryVariantState>();

    for (const entry of entries) {
        const variant = await db
            .select({
                id: productVariants.id,
                stock: productVariants.stock,
                reservedStock: productVariants.reservedStock,
                preorderStock: productVariants.preorderStock,
                stockVersion: productVariants.stockVersion,
            })
            .from(productVariants)
            .where(eq(productVariants.id, entry.variantId))
            .get();

        if (!variant) {
            throwInventoryTransitionError(orderId, operation, {
                success: false,
                results: [{
                    success: false,
                    variantId: entry.variantId,
                    previousStock: 0,
                    newStock: 0,
                    error: `Variant ${entry.variantId} not found`,
                }],
                error: `Missing variant: ${entry.variantId}`,
            });
        }

        variants.set(entry.variantId, variant);
    }

    return variants;
}

async function buildTransitionMovementClaims(
    db: Database,
    order: InventoryTransitionOrder,
    operation: InventoryTransitionOperation,
    entries: ReservationEntry[],
    variants: Map<string, InventoryVariantState>,
    pool: InventoryPoolName,
): Promise<InventoryTransitionMovementClaim[]> {
    return Promise.all(entries.map(async (entry) => {
        const variant = variants.get(entry.variantId)!;
        const { previousStock, newStock } = getTransitionStockSnapshot(operation, entry.quantity, variant, pool);
        return {
            id: await createTransitionMovementId({
                orderId: order.id,
                variantId: entry.variantId,
                operation,
                pool,
                generation: await loadTransitionMovementGeneration(db, order.id, entry.variantId, operation),
            }),
            variantId: entry.variantId,
            orderId: order.id,
            type: getTransitionMovementType(operation, pool),
            quantity: operation === "release" ? -entry.quantity : entry.quantity,
            previousStock,
            newStock,
            notes: getTransitionMovementNotes(order.id, operation, entry.quantity),
        };
    }));
}

function buildTransitionMovementInsert(
    db: Database,
    claim: InventoryTransitionMovementClaim,
    variant: InventoryVariantState,
) {
    return db
        .insert(inventoryMovements)
        .select(sql`
            SELECT
                ${claim.id},
                ${claim.variantId},
                ${claim.orderId},
                ${claim.type},
                ${claim.quantity},
                ${claim.previousStock},
                ${claim.newStock},
                ${claim.notes},
                NULL,
                unixepoch()
            FROM ${productVariants}
            WHERE ${productVariants.id} = ${claim.variantId}
              AND ${productVariants.stockVersion} = ${variant.stockVersion}
        `)
        .returning({ id: inventoryMovements.id });
}

function buildTransitionVariantUpdate(
    db: Database,
    operation: StrictMovementOperation,
    entry: ReservationEntry,
    variant: InventoryVariantState,
    pool: InventoryPoolName,
) {
    return db
        .update(productVariants)
        .set(getTransitionVariantUpdateSet(operation, entry.quantity, pool))
        .where(
            and(
                eq(productVariants.id, entry.variantId),
                eq(productVariants.stockVersion, variant.stockVersion),
            ),
        )
        .returning({ id: productVariants.id });
}

function buildTransitionVariantRollback(
    db: Database,
    operation: StrictMovementOperation,
    entry: ReservationEntry,
    pool: InventoryPoolName,
) {
    return db
        .update(productVariants)
        .set(getTransitionVariantRollbackSet(operation, entry.quantity, pool))
        .where(eq(productVariants.id, entry.variantId));
}

function getTransitionVariantUpdateSet(
    operation: StrictMovementOperation,
    quantity: number,
    pool: InventoryPoolName,
) {
    const versionBump = {
        stockVersion: sql`${productVariants.stockVersion} + 1`,
        updatedAt: sql`unixepoch()`,
    };

    if (operation === "deduct") {
        return pool === "regular"
            ? {
                stock: sql`MAX(0, ${productVariants.stock} - ${quantity})`,
                reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
                ...versionBump,
            }
            : {
                reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
                ...versionBump,
            };
    }

    if (operation === "release") {
        return {
            reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
            ...(pool === "preorder"
                ? { preorderStock: sql`${productVariants.preorderStock} + ${quantity}` }
                : {}),
            ...versionBump,
        };
    }

    return pool === "regular"
        ? {
            stock: sql`${productVariants.stock} + ${quantity}`,
            ...versionBump,
        }
        : pool === "preorder"
            ? {
                preorderStock: sql`${productVariants.preorderStock} + ${quantity}`,
                ...versionBump,
            }
            : versionBump;
}

function getTransitionVariantRollbackSet(
    operation: StrictMovementOperation,
    quantity: number,
    pool: InventoryPoolName,
) {
    const versionBump = {
        stockVersion: sql`${productVariants.stockVersion} + 1`,
        updatedAt: sql`unixepoch()`,
    };

    if (operation === "deduct") {
        return pool === "regular"
            ? {
                stock: sql`${productVariants.stock} + ${quantity}`,
                reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
                ...versionBump,
            }
            : {
                reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
                ...versionBump,
            };
    }

    if (operation === "release") {
        return {
            reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
            ...(pool === "preorder"
                ? { preorderStock: sql`MAX(0, ${productVariants.preorderStock} - ${quantity})` }
                : {}),
            ...versionBump,
        };
    }

    return pool === "regular"
        ? {
            stock: sql`MAX(0, ${productVariants.stock} - ${quantity})`,
            ...versionBump,
        }
        : pool === "preorder"
            ? {
                preorderStock: sql`MAX(0, ${productVariants.preorderStock} - ${quantity})`,
                ...versionBump,
            }
            : versionBump;
}

function getTransitionStockSnapshot(
    operation: InventoryTransitionOperation,
    quantity: number,
    variant: InventoryVariantState,
    pool: InventoryPoolName,
): { previousStock: number; newStock: number } {
    const previousStock = pool === "preorder" ? variant.preorderStock : variant.stock;

    if (operation === "deduct") {
        return {
            previousStock,
            newStock: pool === "regular" ? Math.max(0, variant.stock - quantity) : previousStock,
        };
    }

    if (operation === "release") {
        return {
            previousStock,
            newStock: pool === "preorder" ? variant.preorderStock + quantity : previousStock,
        };
    }

    if (operation === "restore") {
        return {
            previousStock,
            newStock: pool === "regular" || pool === "preorder" ? previousStock + quantity : previousStock,
        };
    }

    return { previousStock, newStock: previousStock };
}

function getTransitionMovementType(
    operation: InventoryTransitionOperation,
    pool: InventoryPoolName,
): InventoryTransitionMovementClaim["type"] {
    if (operation === "deduct") return pool === "preorder" ? "preorder_deducted" : "deducted";
    if (operation === "release") return "released";
    return "restored";
}

function getTransitionMovementNotes(
    orderId: string,
    operation: InventoryTransitionOperation,
    quantity: number,
): string {
    if (operation === "deduct") {
        return `Stock deducted on order status transition for order ${orderId}`;
    }
    if (operation === "release") {
        return `Released ${quantity} reserved units on order status transition for order ${orderId}`;
    }
    if (operation === "restore") {
        return `Restored ${quantity} deducted units on order status transition for order ${orderId}`;
    }
    return `Reserved ${quantity} units on order status transition for order ${orderId}`;
}

async function createTransitionMovementId(input: {
    orderId: string;
    variantId: string;
    operation: InventoryTransitionOperation;
    pool: InventoryPoolName;
    generation: number;
}): Promise<string> {
    const payload = [
        "order-inventory-transition:v1",
        input.orderId,
        input.variantId,
        input.operation,
        input.pool,
        String(input.generation),
    ].join("\0");
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(payload),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    return `transition:${hex}`;
}

async function loadTransitionMovementGeneration(
    db: Database,
    orderId: string,
    variantId: string,
    operation: InventoryTransitionOperation,
): Promise<number> {
    const result = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(inventoryMovements)
        .where(
            and(
                eq(inventoryMovements.orderId, orderId),
                eq(inventoryMovements.variantId, variantId),
                inArray(inventoryMovements.type, getTransitionGenerationTypes(operation)),
            ),
        )
        .get();

    return result?.count ?? 0;
}

function getTransitionGenerationTypes(operation: InventoryTransitionOperation): string[] {
    if (operation === "release") return ["reserved", "preorder_reserved"];
    if (operation === "restore") return ["deducted", "preorder_deducted"];
    return ["released", "restored"];
}

function isDuplicateTransitionMovementClaimError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
        message.includes("transition:") ||
        (message.includes("UNIQUE constraint failed") &&
            message.includes("inventory_movements"))
    );
}

async function resolveDuplicateTransitionMovements(
    db: Database,
    orderId: string,
    operation: StrictMovementOperation,
    movementClaims: InventoryTransitionMovementClaim[],
    entries: ReservationEntry[],
    err: unknown,
): Promise<boolean> {
    if (!isDuplicateTransitionMovementClaimError(err)) return false;

    const existingRows = await db
        .select({
            id: inventoryMovements.id,
            variantId: inventoryMovements.variantId,
            orderId: inventoryMovements.orderId,
            type: inventoryMovements.type,
            quantity: inventoryMovements.quantity,
        })
        .from(inventoryMovements)
        .where(inArray(inventoryMovements.id, movementClaims.map((claim) => claim.id)))
        .all();
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const mismatched = movementClaims.find((claim) => {
        const row = existingById.get(claim.id);
        return !row ||
            row.variantId !== claim.variantId ||
            row.orderId !== claim.orderId ||
            row.type !== claim.type ||
            row.quantity !== claim.quantity;
    });

    if (mismatched) {
        throwInventoryTransitionError(orderId, operation, {
            success: false,
            results: entries.map((entry) => ({
                success: false,
                variantId: entry.variantId,
                previousStock: 0,
                newStock: 0,
                error: "Inventory transition claim mismatch requires manual inventory reconciliation",
            })),
            error: "Inventory transition claim mismatch requires manual inventory reconciliation",
        });
    }

    return true;
}

async function checkLowStockForTransitionEntries(
    db: Database,
    entries: ReservationEntry[],
): Promise<void> {
    await Promise.all(entries.map((entry) => checkAndAlertLowStock(db, entry.variantId)));
}

async function getOrderInventoryEntries(
    db: Database,
    orderId: string,
    inventoryPool: string,
): Promise<ReservationEntry[]> {
    const items = await db
        .select({
            variantId: orderItems.variantId,
            quantity: orderItems.quantity,
            inventoryTracked: orderItems.inventoryTracked,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .all();

    const pool = normalizeInventoryPool(inventoryPool);

    return items
        .filter((i) => i.variantId !== null && i.inventoryTracked)
        .map((i) => ({
            variantId: i.variantId as string,
            quantity: i.quantity,
            pool,
        }));
}

function normalizeInventoryPool(inventoryPool: string): InventoryPoolName {
    return (inventoryPool ?? InventoryPool.REGULAR) as InventoryPoolName;
}

function assertInventoryTransitionSucceeded(
    orderId: string,
    operation: InventoryTransitionOperation,
    result: InventoryTransitionResult,
): void {
    if (result.success) return;
    throwInventoryTransitionError(orderId, operation, result);
}

function throwInventoryTransitionError(
    orderId: string,
    operation: InventoryTransitionOperation,
    result: InventoryTransitionResult,
): never {
    const failedResults = result.results.filter((entry) => !entry.success);
    const failedVariants = failedResults.map((entry) => ({
        variantId: entry.variantId,
        error: entry.error ?? "Inventory operation failed",
    }));
    const reason = result.error ?? failedVariants[0]?.error ?? "Inventory operation failed";

    throw new ValidationError(
        `Inventory ${operation} failed for order ${orderId}: ${reason}`,
        {
            orderId,
            operation,
            failedVariants,
        },
    );
}
