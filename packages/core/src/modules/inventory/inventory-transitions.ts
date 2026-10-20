// src/lib/inventory/inventory-transitions.ts
// Centralized, idempotent inventory adjustment logic for order status changes.
//
// This module is the SINGLE SOURCE OF TRUTH for how inventory reacts to
// order status transitions. Every endpoint that changes order status must
// call applyInventoryForStatusChange() instead of manually adjusting stock.

import { catalogBuyerStateRefreshStatementsForSkus, effectiveLowStockThresholdSql } from "../products";
import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { inventoryMovements, orders, orderItems, orderReturns, InventoryPool, productVariants } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { reserveStockBatch, type ReservationBatchItem } from "./reserve";
import { checkAndAlertLowStock } from "./alerts";
import type { ReservationEntry, StockOperationResult } from "./types";
import { validatePositiveQuantity } from "./validation";
import {
    buildInventoryLedgerV2Edge,
    getActiveReservationGeneration,
    getReservationGenerationBalances,
    type InventoryLedgerV2EdgeFields,
    type InventoryLedgerV2Event,
  ledgerVersionKeyRead,
} from "./ledger-v2";
import { mapWithBoundedConcurrency } from "../../utils/bounded-concurrency";
import { resolveTrackedBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import {
    assertInventoryLocationCovers,
    inventoryLocationErrorFrom,
    isInventoryLevelShortfallError,
    isInventoryLocationRequiredError,
    resolveActiveInventoryLocation,
    resolveOrderFulfillmentLocation,
    selectActiveInventoryLocationIds,
    type InventoryLocationRef,
} from "./locations";

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
const INVENTORY_DB_CONCURRENCY = 4;

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
export type ClaimedInventoryEntryOperation = Extract<StrictMovementOperation, "deduct" | "restore">;

export interface InventoryStatusTransitionImpact {
    inventoryAction: InventoryAction;
    availabilityTransitionVariantIds: string[];
}

export interface ClaimedInventoryEntryBatchInput {
    orderId: string;
    operation: ClaimedInventoryEntryOperation;
    entries: ReservationEntry[];
    /** Stable logical-operation key. Replaying the same key and payload is a no-op. */
    claimKey: string;
    pool: InventoryPoolName;
    /** Operator responsible for this explicit inventory mutation. */
    createdBy?: string | null;
    /**
     * Restore only: the active location the units go back to (a return
     * receipt's restock location). Omitted, units return to the location
     * they were deducted from.
     */
    locationId?: string | null;
}

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
    /** Where the order's stock leaves from; null = the default location. */
    fulfillmentLocationId: string | null;
};

type InventoryVariantState = {
    id: string;
    stock: number;
    reservedStock: number;
    preorderStock: number;
    stockVersion: number;
    trackInventory: boolean;
    lowStockThreshold: number | null;
    allowPreorder: boolean;
    allowBackorder: boolean;
    backorderLimit: number;
};

export interface ClaimedInventoryEntryBatchImpact {
    movementIds: string[];
    availabilityTransitionVariantIds: string[];
    /** The location each SKU's units moved at (null for releases). */
    locationIdByVariant: Record<string, string | null>;
}

type StrictInventoryTransitionResult = ClaimedInventoryEntryBatchImpact;

type InventoryTransitionMovementClaim = {
    id: string;
    variantId: string;
    orderId: string;
    type: "deducted" | "preorder_deducted" | "released" | "restored";
    quantity: number;
    notes: string;
    createdBy: string | null;
    /** Deducts and restores name where units moved; releases move none. */
    locationId: string | null;
} & InventoryLedgerV2EdgeFields;

function buyerCapacity(
    state: InventoryVariantState,
    pool: InventoryPoolName,
): number {
    if (!state.trackInventory) return Number.POSITIVE_INFINITY;
    if (pool === "preorder") {
        return state.allowPreorder ? Math.max(0, state.preorderStock) : 0;
    }
    if (pool === "backorder") {
        if (!state.allowBackorder) return 0;
        return state.backorderLimit > 0
            ? Math.max(0, state.backorderLimit - state.reservedStock)
            : Number.POSITIVE_INFINITY;
    }
    return Math.max(0, state.stock - state.reservedStock);
}

function hasBuyerCapacityTransition(
    before: InventoryVariantState,
    after: InventoryVariantState,
    pool: InventoryPoolName,
): boolean {
    const beforeCapacity = buyerCapacity(before, pool);
    const afterCapacity = buyerCapacity(after, pool);
    if (!Number.isFinite(beforeCapacity) && !Number.isFinite(afterCapacity)) return false;
    if (pool !== "regular") return (beforeCapacity > 0) !== (afterCapacity > 0);
    return resolveTrackedBuyerAvailabilityBand(beforeCapacity, before.lowStockThreshold)
        !== resolveTrackedBuyerAvailabilityBand(afterCapacity, after.lowStockThreshold);
}

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
async function hasOpenOrderReturn(db: Database, orderId: string): Promise<boolean> {
    const row = await db.select({ id: orderReturns.id }).from(orderReturns).where(and(
        eq(orderReturns.orderId, orderId),
        sql`${orderReturns.status} NOT IN ('cancelled', 'rejected')`,
    )).get();
    return Boolean(row);
}

export async function buildInventoryStatements(
    db: Database,
    orderId: string,
    newStatus: string,
): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch statements require any[] return type
    statements: any[];
    newAction: InventoryAction;
    availabilityTransitionVariantIds: string[];
}> {
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            version: orders.version,
            fulfillmentLocationId: orders.fulfillmentLocationId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get() as InventoryTransitionOrder | undefined;

    if (!order) return {
        statements: [],
        newAction: "none",
        availabilityTransitionVariantIds: [],
    };

    const currentAction = order.inventoryAction as InventoryAction;
    const needsRestore = STOCK_RESTORE_STATUSES.has(newStatus);
    const needsDeduct = STOCK_DEDUCT_STATUSES.has(newStatus);

    if (needsRestore && currentAction === "reserved") {
        const availabilityTransitionVariantIds = await releaseOrderReservations(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "restored")],
            newAction: "restored",
            availabilityTransitionVariantIds,
        };
    }

    if (needsRestore && currentAction === "deducted") {
        // A return record owns the stock of what came back: its receipt
        // restocks good units and writes off damaged ones. Restoring the whole
        // order here as well would count returned units twice.
        if (newStatus === "returned" && await hasOpenOrderReturn(db, orderId)) {
            return { statements: [], newAction: currentAction, availabilityTransitionVariantIds: [] };
        }
        const availabilityTransitionVariantIds = await restoreDeductedOrderStock(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "restored")],
            newAction: "restored",
            availabilityTransitionVariantIds,
        };
    }

    if (needsDeduct && currentAction === "reserved") {
        const availabilityTransitionVariantIds = await deductOrderStock(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "deducted")],
            newAction: "deducted",
            availabilityTransitionVariantIds,
        };
    }

    // Recovery re-reservation: if repaired data or an interrupted compensating workflow leaves an
    // active order with restored inventory, reserve its items again. Public order transitions never
    // leave the terminal cancelled state; this path repairs inventory projection only.
    const needsReReserve = isStockReservableStatus(newStatus) && currentAction === "restored";
    if (needsReReserve) {
        const availabilityTransitionVariantIds = await reserveOrderItems(db, order);
        return {
            statements: [buildInventoryActionUpdate(db, order, "reserved")],
            newAction: "reserved",
            availabilityTransitionVariantIds,
        };
    }

    return {
        statements: [],
        newAction: currentAction,
        availabilityTransitionVariantIds: [],
    };
}

/**
 * Before anything physically leaves for an order (the last parcel, a courier
 * booking, the last pickup): if that will deduct its reserved regular stock,
 * refuse now when the order's fulfilment location lacks the units, so nothing
 * is recorded and the merchant can move stock or change the order's location.
 * The deduct itself re-checks (and the level CHECK aborts) on a race.
 */
export async function assertOrderStockCoverable(db: Database, orderId: string): Promise<void> {
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            version: orders.version,
            fulfillmentLocationId: orders.fulfillmentLocationId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get() as InventoryTransitionOrder | undefined;
    if (!order || order.inventoryAction !== "reserved") return;
    if (normalizeInventoryPool(order.inventoryPool) !== "regular") return;
    const entries = mergeTransitionEntriesByVariant(await getOrderInventoryEntries(db, order), "regular");
    if (entries.length === 0) return;
    const location = await resolveOrderFulfillmentLocation(db, order.fulfillmentLocationId);
    await assertInventoryLocationCovers(db, location, entries);
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
    const impact = await applyInventoryForStatusChangeWithImpact(db, orderId, newStatus);
    return impact.inventoryAction;
}

export async function applyInventoryForStatusChangeWithImpact(
    db: Database,
    orderId: string,
    newStatus: string,
): Promise<InventoryStatusTransitionImpact> {
    const {
        statements,
        newAction,
        availabilityTransitionVariantIds,
    } = await buildInventoryStatements(db, orderId, newStatus);
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
    return {
        inventoryAction: newAction,
        availabilityTransitionVariantIds,
    };
}

/**
 * Apply an explicit order-item inventory delta with a deterministic movement
 * claim and a stockVersion CAS update in the same D1 batch. Callers derive
 * `claimKey` from the immutable logical attempt; replaying the same
 * key/order/variant/operation/pool tuple is idempotent, and a different
 * quantity for that tuple fails closed.
 */
export async function applyClaimedInventoryEntryBatchWithImpact(
    db: Database,
    input: ClaimedInventoryEntryBatchInput,
): Promise<ClaimedInventoryEntryBatchImpact> {
    if (!input.orderId.trim()) {
        throw new ValidationError("Inventory claim requires an order id.");
    }
    if (!input.claimKey.trim()) {
        throw new ValidationError("Inventory claim requires a stable claim key.");
    }
    for (const entry of input.entries) validatePositiveQuantity(entry.quantity);

    const entries = mergeTransitionEntriesByVariant(input.entries, input.pool);
    if (entries.length === 0) {
        return { movementIds: [], availabilityTransitionVariantIds: [], locationIdByVariant: {} };
    }
    if (input.locationId && input.operation !== "restore") {
        throw new ValidationError("Only a restore can name the location units return to.");
    }

    const order = await db.select({ fulfillmentLocationId: orders.fulfillmentLocationId })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .get();
    const result = await applyStrictInventoryTransitionMovements(
        db,
        {
            id: input.orderId,
            status: "",
            inventoryAction: "",
            inventoryPool: input.pool,
            version: 0,
            fulfillmentLocationId: order?.fulfillmentLocationId ?? null,
        },
        input.operation,
        entries,
        input.claimKey,
        input.createdBy ?? null,
        input.locationId ?? null,
    );
    return result;
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
        .set({
            inventoryAction,
            updatedAt: sql`unixepoch()`,
        })
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
): Promise<string[]> {
    const entries = await getOrderInventoryEntries(db, order);

    if (entries.length > 0) {
        const result = await applyStrictInventoryTransitionMovements(
            db,
            order,
            "deduct",
            entries,
        );
        return result.availabilityTransitionVariantIds;
    }
    return [];
}

/**
 * Release reservations for all items in an order.
 * Used when a storefront order is cancelled before payment.
 */
async function releaseOrderReservations(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<string[]> {
    const entries = await getOrderInventoryEntries(db, order);

    if (entries.length > 0) {
        const result = await applyStrictInventoryTransitionMovements(
            db,
            order,
            "release",
            entries,
        );
        return result.availabilityTransitionVariantIds;
    }
    return [];
}

/**
 * Re-reserve stock for all items in an order.
 * Used to repair an active order whose inventory projection was previously restored.
 * Stock was released on cancellation; this re-reserves it.
 */
async function reserveOrderItems(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<string[]> {
    const entries = await getOrderInventoryEntries(db, order);

    if (entries.length > 0) {
        const batchItems = await buildTransitionReservationBatchItems(db, order, entries);
        const result = await reserveStockBatch(db, batchItems, normalizeInventoryPool(order.inventoryPool));
        assertInventoryTransitionSucceeded(order.id, "reserve", result);
        // Reactivation is an administrative edge case. The reservation helper
        // does not expose its pre-commit capacity bands, so conservatively
        // invalidate the affected SKUs rather than risk stale availability.
        return [...new Set(entries.map((entry) => entry.variantId))];
    }
    return [];
}

/**
 * Restore deducted stock for all items in an order.
 * Used when a shipped/delivered order is cancelled or returned.
 * Physical stock was permanently decremented at ship time — this adds it back.
 */
async function restoreDeductedOrderStock(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<string[]> {
    const entries = await getOrderInventoryEntries(db, order);

    if (entries.length > 0) {
        const result = await applyStrictInventoryTransitionMovements(
            db,
            order,
            "restore",
            entries,
        );
        return result.availabilityTransitionVariantIds;
    }
    return [];
}

async function applyStrictInventoryTransitionMovements(
    db: Database,
    order: InventoryTransitionOrder,
    operation: StrictMovementOperation,
    entries: ReservationEntry[],
    claimKey?: string,
    createdBy: string | null = null,
    restockLocationId: string | null = null,
): Promise<StrictInventoryTransitionResult> {
    const pool = normalizeInventoryPool(order.inventoryPool);
    const mergedEntries = mergeTransitionEntriesByVariant(entries, pool);
    if (mergedEntries.length === 0) {
        return { movementIds: [], availabilityTransitionVariantIds: [], locationIdByVariant: {} };
    }

    // Deducts leave from the order's location; a regular deduct takes
    // physical units there, so a shortfall is refused before writing anything.
    const deductLocation = operation === "deduct"
        ? await resolveOrderFulfillmentLocation(db, order.fulfillmentLocationId)
        : null;
    const restockLocation = operation === "restore" && restockLocationId
        ? await resolveActiveInventoryLocation(db, restockLocationId)
        : null;

    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt++) {
        const variants = await loadTransitionVariantStates(db, order.id, operation, mergedEntries);
        const availabilityTransitionVariantIds = mergedEntries
            .filter((entry) => {
                const before = variants.get(entry.variantId)!;
                const counterAfter = getTransitionCounterStateAfter(
                    operation,
                    entry.quantity,
                    before,
                    pool,
                );
                const after = { ...before, ...counterAfter };
                return hasBuyerCapacityTransition(before, after, pool);
            })
            .map((entry) => entry.variantId);
        const movementClaims = await buildTransitionMovementClaims(
            db,
            order,
            operation,
            mergedEntries,
            variants,
            pool,
            claimKey,
            createdBy,
            deductLocation ?? restockLocation,
        );
        if (attempt === 0 && deductLocation && pool === "regular") {
            // A replayed claim already took its units: check only the new ones.
            const claimed = await selectExistingMovementIds(db, movementClaims.map((claim) => claim.id));
            await assertInventoryLocationCovers(
                db,
                deductLocation,
                mergedEntries.filter((_entry, index) => !claimed.has(movementClaims[index]!.id)),
            );
        }
        const movementQueries = movementClaims.map((claim, index) =>
            buildTransitionMovementInsert(
                db,
                claim,
                variants.get(claim.variantId)!,
                operation,
                mergedEntries[index]!.quantity,
                pool,
            ),
        );
        const updateQueries = mergedEntries.map((entry) =>
            buildTransitionVariantUpdate(db, operation, entry, variants.get(entry.variantId)!, pool),
        );

        let batchResults: { id: string }[][];
        try {
            batchResults = await safeBatch(db, [
                ...movementQueries,
                ...updateQueries,
                // Buyer state reads the counters this batch just wrote.
                ...catalogBuyerStateRefreshStatementsForSkus(db, mergedEntries.map((entry) => entry.variantId)),
            ] as never) as { id: string }[][];
        } catch (err: unknown) {
            // The whole batch rolled back: a location lacked the units (the
            // level CHECK) or a movement named no active location.
            if (isInventoryLevelShortfallError(err) || isInventoryLocationRequiredError(err)) {
                throw inventoryLocationErrorFrom(err, deductLocation?.name);
            }
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
                return {
                    movementIds: movementClaims.map((claim) => claim.id),
                    // The committed pre-state is no longer reconstructable.
                    // A conservative purge is rare and keeps replay truthful.
                    availabilityTransitionVariantIds: mergedEntries
                        .map((entry) => entry.variantId),
                    locationIdByVariant: await committedMovementLocations(db, movementClaims),
                };
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
            const rollbackQueries: Array<{ query: unknown; description: string }> = [];
            for (let i = 0; i < mergedEntries.length; i++) {
                const entry = mergedEntries[i]!;
                const claim = movementClaims[i]!;
                const variant = variants.get(entry.variantId)!;
                const movementInserted = insertedMovementIds.includes(claim.id);
                const counterUpdated = !failedUpdateIndices.includes(i);

                if (counterUpdated) {
                    rollbackQueries.push({
                        query: buildTransitionVariantRollback(db, operation, entry, pool, variant),
                        description: `counter rollback for ${entry.variantId}`,
                    });
                    if (movementInserted) {
                        rollbackQueries.push({
                            query: buildTransitionMovementRollbackAfterCounter(db, claim.id, entry.variantId, variant),
                            description: `movement rollback for ${entry.variantId}`,
                        });
                    }
                } else if (movementInserted) {
                    rollbackQueries.push({
                        query: db.delete(inventoryMovements)
                            .where(eq(inventoryMovements.id, claim.id))
                            .returning({ id: inventoryMovements.id }),
                        description: `unapplied movement rollback for ${entry.variantId}`,
                    });
                }
            }

            if (rollbackQueries.length > 0) {
                try {
                    const rollbackResults = await safeBatch(
                        db,
                        [
                            ...rollbackQueries.map((entry) => entry.query),
                            ...catalogBuyerStateRefreshStatementsForSkus(db, mergedEntries.map((entry) => entry.variantId)),
                        ] as never,
                    ) as { id: string }[][];
                    const missedRollback = rollbackResults
                        .slice(0, rollbackQueries.length)
                        .findIndex((result) => !result || result.length === 0);
                    if (missedRollback >= 0) {
                        throw new Error(`Unproven ${rollbackQueries[missedRollback]!.description}`);
                    }
                } catch (rollbackErr: unknown) {
                    console.error(`[inventory/transition] ${operation} rollback failed for order ${order.id}:`, rollbackErr);
                    throwInventoryTransitionError(order.id, operation, {
                        success: false,
                        results: mergedEntries.map((entry) => ({
                            success: false,
                            variantId: entry.variantId,
                            previousStock: 0,
                            newStock: 0,
                            error: "Inventory rollback could not be proven; manual reconciliation is required",
                        })),
                        error: "Inventory rollback could not be proven; manual reconciliation is required",
                    });
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
        return {
            movementIds: movementClaims.map((claim) => claim.id),
            availabilityTransitionVariantIds,
            locationIdByVariant: Object.fromEntries(
                movementClaims.map((claim) => [claim.variantId, claim.locationId]),
            ),
        };
    }

    throw new ValidationError(
        `Inventory ${operation} exhausted its bounded retries for order ${order.id}`,
    );
}

async function buildTransitionReservationBatchItems(
    db: Database,
    order: InventoryTransitionOrder,
    entries: ReservationEntry[],
): Promise<ReservationBatchItem[]> {
    const pool = normalizeInventoryPool(order.inventoryPool);
    const mergedEntries = mergeTransitionEntriesByVariant(entries, pool);
    return mapWithBoundedConcurrency(mergedEntries, INVENTORY_DB_CONCURRENCY, async (entry) => ({
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
    }));
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
                trackInventory: productVariants.trackInventory,
                lowStockThreshold: effectiveLowStockThresholdSql(),
                allowPreorder: productVariants.allowPreorder,
                allowBackorder: productVariants.allowBackorder,
                backorderLimit: productVariants.backorderLimit,
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
    operation: StrictMovementOperation,
    entries: ReservationEntry[],
    variants: Map<string, InventoryVariantState>,
    pool: InventoryPoolName,
    claimKey?: string,
    createdBy: string | null = null,
    namedLocation: InventoryLocationRef | null = null,
): Promise<InventoryTransitionMovementClaim[]> {
    const claims: InventoryTransitionMovementClaim[] = [];
    const contexts = new Map<string, TransitionLedgerContext>();
    for (const entry of entries) {
        contexts.set(entry.variantId, await loadTransitionLedgerContext(
            db,
            order.id,
            entry.variantId,
            pool,
            operation,
        ));
    }
    const locationIdByVariant = await resolveTransitionLocations(
        db,
        order,
        operation,
        contexts,
        namedLocation,
    );
    for (const entry of entries) {
        const variant = variants.get(entry.variantId)!;
        const { reservationGeneration } = contexts.get(entry.variantId)!;
        const edge = buildInventoryLedgerV2Edge({
            pool,
            reservationGeneration,
            before: {
                stock: variant.stock,
                reservedStock: variant.reservedStock,
                preorderStock: variant.preorderStock,
                stockVersion: variant.stockVersion,
            },
            after: getTransitionCounterStateAfter(operation, entry.quantity, variant, pool),
        });
        claims.push({
            id: await createTransitionMovementId({
                orderId: order.id,
                variantId: entry.variantId,
                operation,
                pool,
                generation: await loadTransitionMovementGeneration(db, order.id, entry.variantId, operation),
                claimKey,
            }),
            variantId: entry.variantId,
            orderId: order.id,
            type: getTransitionMovementType(operation, pool),
            quantity: operation === "release" ? -entry.quantity : entry.quantity,
            notes: getTransitionMovementNotes(order.id, operation, entry.quantity),
            createdBy,
            locationId: locationIdByVariant.get(entry.variantId) ?? null,
            ...edge,
        });
    }
    return claims;
}

/**
 * Where each SKU's units move: a deduct leaves from the order's location; a
 * restore goes to the named location, else back to where its generation was
 * deducted from (the order's location when that one is archived or unknown);
 * a release moves no units.
 */
async function resolveTransitionLocations(
    db: Database,
    order: InventoryTransitionOrder,
    operation: StrictMovementOperation,
    contexts: ReadonlyMap<string, TransitionLedgerContext>,
    namedLocation: InventoryLocationRef | null,
): Promise<Map<string, string | null>> {
    const locations = new Map<string, string | null>();
    if (operation === "release") {
        for (const variantId of contexts.keys()) locations.set(variantId, null);
        return locations;
    }
    if (namedLocation) {
        for (const variantId of contexts.keys()) locations.set(variantId, namedLocation.id);
        return locations;
    }
    if (operation === "deduct") {
        const location = await resolveOrderFulfillmentLocation(db, order.fulfillmentLocationId);
        for (const variantId of contexts.keys()) locations.set(variantId, location.id);
        return locations;
    }
    const deducted = [...contexts.values()].flatMap((context) =>
        context.deductLocationId ? [context.deductLocationId] : []);
    const active = await selectActiveInventoryLocationIds(db, deducted);
    let fallback: string | null = null;
    for (const [variantId, context] of contexts) {
        if (context.deductLocationId && active.has(context.deductLocationId)) {
            locations.set(variantId, context.deductLocationId);
            continue;
        }
        fallback ??= await resolveRestoreFallbackLocation(db, order.fulfillmentLocationId);
        locations.set(variantId, fallback);
    }
    return locations;
}

/** The order's location when it is still active, else the default. */
async function resolveRestoreFallbackLocation(
    db: Database,
    fulfillmentLocationId: string | null,
): Promise<string> {
    if (fulfillmentLocationId) {
        const active = await selectActiveInventoryLocationIds(db, [fulfillmentLocationId]);
        if (active.has(fulfillmentLocationId)) return fulfillmentLocationId;
    }
    return (await resolveActiveInventoryLocation(db, null)).id;
}

async function selectExistingMovementIds(db: Database, ids: readonly string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    // D1 binds at most 100 parameters per statement.
    for (let index = 0; index < ids.length; index += 90) {
        const rows = await db.select({ id: inventoryMovements.id })
            .from(inventoryMovements)
            .where(inArray(inventoryMovements.id, ids.slice(index, index + 90)))
            .all();
        for (const row of rows) existing.add(row.id);
    }
    return existing;
}

async function committedMovementLocations(
    db: Database,
    claims: readonly InventoryTransitionMovementClaim[],
): Promise<Record<string, string | null>> {
    const locations: Record<string, string | null> = {};
    for (let index = 0; index < claims.length; index += 90) {
        const rows = await db.select({
            variantId: inventoryMovements.variantId,
            locationId: inventoryMovements.locationId,
        }).from(inventoryMovements)
            .where(inArray(inventoryMovements.id, claims.slice(index, index + 90).map((claim) => claim.id)))
            .all();
        for (const row of rows) locations[row.variantId] = row.locationId;
    }
    return locations;
}

function buildTransitionMovementInsert(
    db: Database,
    claim: InventoryTransitionMovementClaim,
    variant: InventoryVariantState,
    operation: StrictMovementOperation,
    quantity: number,
    pool: InventoryPoolName,
) {
    const counterGuards = getTransitionCounterGuards(operation, quantity, pool);
    const counterGuardSql = counterGuards.length > 0
        ? sql` AND ${sql.join(counterGuards, sql` AND `)}`
        : sql``;
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
                ${claim.createdBy},
                ${claim.ledgerVersion},
                ${claim.pool},
                ${claim.reservationGeneration},
                ${claim.stockVersionBefore},
                ${claim.stockVersionAfter},
                ${claim.stockDelta},
                ${claim.previousReservedStock},
                ${claim.newReservedStock},
                ${claim.reservedStockDelta},
                ${claim.previousPreorderStock},
                ${claim.newPreorderStock},
                ${claim.preorderStockDelta},
                unixepoch(),
                ${claim.locationId}
            FROM ${productVariants}
            WHERE ${productVariants.id} = ${claim.variantId}
              AND ${productVariants.stockVersion} = ${variant.stockVersion}
              ${counterGuardSql}
              ${ledgerVersionKeyRead(claim.stockVersionAfter)}
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
    const counterGuards = getTransitionCounterGuards(operation, entry.quantity, pool);
    return db
        .update(productVariants)
        .set(getTransitionVariantUpdateSet(operation, entry.quantity, pool))
        .where(
            and(
                eq(productVariants.id, entry.variantId),
                eq(productVariants.stockVersion, variant.stockVersion),
                ...counterGuards,
            ),
        )
        .returning({ id: productVariants.id });
}

function getTransitionCounterGuards(
    operation: StrictMovementOperation,
    quantity: number,
    pool: InventoryPoolName,
): SQL[] {
    if (operation === "restore") return [];

    const guards: SQL[] = [gte(productVariants.reservedStock, quantity)];
    if (operation === "deduct" && pool === "regular") {
        guards.push(gte(productVariants.stock, quantity));
    }
    return guards;
}

function buildTransitionVariantRollback(
    db: Database,
    operation: StrictMovementOperation,
    entry: ReservationEntry,
    pool: InventoryPoolName,
    variant: InventoryVariantState,
) {
    return db
        .update(productVariants)
        .set(getTransitionVariantRollbackSet(operation, entry.quantity, pool))
        .where(and(
            eq(productVariants.id, entry.variantId),
            eq(productVariants.stockVersion, variant.stockVersion + 1),
        ))
        .returning({ id: productVariants.id });
}

function buildTransitionMovementRollbackAfterCounter(
    db: Database,
    movementId: string,
    variantId: string,
    variant: InventoryVariantState,
) {
    return db
        .delete(inventoryMovements)
        .where(and(
            eq(inventoryMovements.id, movementId),
            sql`EXISTS (
                SELECT 1
                FROM ${productVariants}
                WHERE ${productVariants.id} = ${variantId}
                  AND ${productVariants.stockVersion} = ${variant.stockVersion + 2}
            )`,
        ))
        .returning({ id: inventoryMovements.id });
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

function getTransitionCounterStateAfter(
    operation: InventoryTransitionOperation,
    quantity: number,
    variant: InventoryVariantState,
    pool: InventoryPoolName,
): InventoryVariantState {
    if (operation === "deduct") {
        return pool === "regular"
            ? {
                ...variant,
                stock: variant.stock - quantity,
                reservedStock: variant.reservedStock - quantity,
                stockVersion: variant.stockVersion + 1,
            }
            : {
                ...variant,
                reservedStock: variant.reservedStock - quantity,
                stockVersion: variant.stockVersion + 1,
            };
    }

    if (operation === "release") {
        return {
            ...variant,
            reservedStock: variant.reservedStock - quantity,
            preorderStock: pool === "preorder"
                ? variant.preorderStock + quantity
                : variant.preorderStock,
            stockVersion: variant.stockVersion + 1,
        };
    }

    if (operation === "restore") {
        if (pool === "regular") {
            return { ...variant, stock: variant.stock + quantity, stockVersion: variant.stockVersion + 1 };
        }
        if (pool === "preorder") {
            return {
                ...variant,
                preorderStock: variant.preorderStock + quantity,
                stockVersion: variant.stockVersion + 1,
            };
        }
        return { ...variant, stockVersion: variant.stockVersion + 1 };
    }

    return { ...variant, stockVersion: variant.stockVersion + 1 };
}

type TransitionLedgerContext = {
    reservationGeneration: number;
    /** Restore only: where the restored generation's units were deducted from. */
    deductLocationId: string | null;
};

async function loadTransitionLedgerContext(
    db: Database,
    orderId: string,
    variantId: string,
    pool: InventoryPoolName,
    operation: StrictMovementOperation,
): Promise<TransitionLedgerContext> {
    const rows = await db
        .select({
            id: inventoryMovements.id,
            variantId: inventoryMovements.variantId,
            orderId: inventoryMovements.orderId,
            type: inventoryMovements.type,
            ledgerVersion: inventoryMovements.ledgerVersion,
            pool: inventoryMovements.pool,
            reservationGeneration: inventoryMovements.reservationGeneration,
            stockVersionBefore: inventoryMovements.stockVersionBefore,
            stockVersionAfter: inventoryMovements.stockVersionAfter,
            previousStock: inventoryMovements.previousStock,
            newStock: inventoryMovements.newStock,
            stockDelta: inventoryMovements.stockDelta,
            previousReservedStock: inventoryMovements.previousReservedStock,
            newReservedStock: inventoryMovements.newReservedStock,
            reservedStockDelta: inventoryMovements.reservedStockDelta,
            previousPreorderStock: inventoryMovements.previousPreorderStock,
            newPreorderStock: inventoryMovements.newPreorderStock,
            preorderStockDelta: inventoryMovements.preorderStockDelta,
            locationId: inventoryMovements.locationId,
        })
        .from(inventoryMovements)
        .where(and(
            eq(inventoryMovements.orderId, orderId),
            eq(inventoryMovements.variantId, variantId),
            eq(inventoryMovements.ledgerVersion, 2),
            eq(inventoryMovements.pool, pool),
        ))
        .all();

    const v2Rows = rows.filter((row) => row.ledgerVersion === 2);
    if (v2Rows.length > 0) {
        const events = v2Rows as Array<InventoryLedgerV2Event & { locationId: string | null }>;
        if (operation === "restore") {
            const deducts = events.filter((event) =>
                event.reservationGeneration != null &&
                (
                    event.type === "deducted"
                    || event.type === "preorder_deducted"
                ));
            const restoredGeneration = deducts
                .reduce((maximum, event) => Math.max(maximum, event.reservationGeneration ?? 0), 0);
            if (restoredGeneration > 0) {
                // The latest deduct of that generation names where its units left from.
                const deduct = deducts
                    .filter((event) => event.reservationGeneration === restoredGeneration)
                    .reduce<(typeof deducts)[number] | null>((latest, event) =>
                        !latest || (event.stockVersionAfter ?? 0) > (latest.stockVersionAfter ?? 0) ? event : latest, null);
                return {
                    reservationGeneration: restoredGeneration,
                    deductLocationId: deduct?.locationId ?? null,
                };
            }
        }

        const balances = getReservationGenerationBalances(events, { orderId, variantId, pool });
        return {
            reservationGeneration: getActiveReservationGeneration(balances)
                ?? balances.at(-1)?.generation
                ?? 1,
            deductLocationId: null,
        };
    }

    return { reservationGeneration: 1, deductLocationId: null };
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
    claimKey?: string;
}): Promise<string> {
    const namespace = input.claimKey
        ? ["order-inventory-entry:v1", input.claimKey]
        : ["order-inventory-transition:v1"];
    const payload = [
        ...namespace,
        input.orderId,
        input.variantId,
        input.operation,
        input.pool,
        // Explicit claims are already uniquely namespaced by their stable key.
        // Omitting the observed movement count keeps them replay-stable after
        // the first successful write. Status-driven transitions still need a
        // generation so a later legitimate lifecycle cycle gets a new edge.
        ...(input.claimKey ? [] : [String(input.generation)]),
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
    await mapWithBoundedConcurrency(
        entries,
        INVENTORY_DB_CONCURRENCY,
        async (entry) => {
            try {
                await checkAndAlertLowStock(db, entry.variantId);
            } catch (error: unknown) {
                // Inventory and its ledger edge already committed atomically.
                // Alert projection failure must not report that mutation as
                // failed and provoke an unsafe commerce retry.
                console.error(
                    `[inventory/transition] Low-stock alert refresh failed for variant ${entry.variantId}:`,
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    );
}

async function getOrderInventoryEntries(
    db: Database,
    order: InventoryTransitionOrder,
): Promise<ReservationEntry[]> {
    const items = await db
        .select({
            variantId: orderItems.variantId,
            quantity: orderItems.quantity,
            inventoryTracked: orderItems.inventoryTracked,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id))
        .all();

    const pool = normalizeInventoryPool(order.inventoryPool);
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
