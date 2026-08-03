import {
    and,
    eq,
    inArray,
    sql,
    type SQL,
} from "drizzle-orm";

import {
    buildBatchGuard,
    isBatchGuardError,
    isTursoConflictError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    checkoutInventoryLaneMovements,
    inventoryMovements,
    inventoryReservationLanes,
    orders,
    productVariants,
} from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";

export const CHECKOUT_LANE_INVENTORY_AUTHORITY = "checkout_lane_v1" as const;

const CHECKOUT_LANE_TRANSITION_ATTEMPTS = 3;
const CHECKOUT_LANE_COUNT = 2;

export type CheckoutLaneTerminalOperation = "released" | "deducted";

export interface CheckoutLaneTransitionOrder {
    id: string;
    status: string;
    inventoryAction: string;
    inventoryPool: string;
    inventoryAuthority: "legacy_counter" | "checkout_lane_v1";
    checkoutAggregateVersion: number | null;
    checkoutInventoryEdges: string | null;
}

export interface CheckoutLaneInventoryEdge {
    variantId: string;
    pool: "regular";
    lane: number;
    quantity: number;
    capacity: number;
    reservedBefore: number;
    reservedAfter: number;
    laneVersionBefore: number;
    laneVersionAfter: number;
    sourceStockVersion: number;
}

export interface CheckoutLaneTerminalResult {
    action: "restored" | "deducted";
    variantIds: string[];
}

interface CheckoutLaneRow {
    variantId: string;
    pool: string;
    lane: number;
    capacity: number | null;
    reservedQuantity: number;
    version: number;
    sourceStockVersion: number;
}

interface CheckoutVariantRow {
    id: string;
    stock: number;
    reservedStock: number;
    preorderStock: number;
    stockVersion: number;
}

interface PreparedTerminalEdge {
    edge: CheckoutLaneInventoryEdge;
    lane: CheckoutLaneRow & { capacity: number };
    variant: CheckoutVariantRow;
    laneMovementId: string;
    stockMovementId: string | null;
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
    return Number.isSafeInteger(value) && (value as number) >= minimum;
}

/** Parse the immutable v1 reservation boundary without trusting JSON casts. */
export function parseCheckoutLaneInventoryEdges(
    serialized: string | null,
): CheckoutLaneInventoryEdge[] {
    let value: unknown;
    try {
        value = serialized == null ? null : JSON.parse(serialized);
    } catch {
        throw new ValidationError("Checkout inventory authority contains invalid reservation edges.");
    }
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
        throw new ValidationError("Checkout inventory authority contains an invalid reservation edge set.");
    }

    const keys = new Set<string>();
    const variantIds = new Set<string>();
    return value.map((candidate, index) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new ValidationError(`Checkout inventory edge ${index + 1} is invalid.`);
        }
        const edge = candidate as Record<string, unknown>;
        if (
            typeof edge.variantId !== "string"
            || !edge.variantId.trim()
            || edge.variantId.length > 180
            || edge.pool !== "regular"
            || !isSafeIntegerAtLeast(edge.lane, 0)
            || edge.lane >= CHECKOUT_LANE_COUNT
            || !isSafeIntegerAtLeast(edge.quantity, 1)
            || !isSafeIntegerAtLeast(edge.capacity, 0)
            || !isSafeIntegerAtLeast(edge.reservedBefore, 0)
            || !isSafeIntegerAtLeast(edge.reservedAfter, 0)
            || edge.reservedAfter !== edge.reservedBefore + edge.quantity
            || edge.reservedAfter > edge.capacity
            || !isSafeIntegerAtLeast(edge.laneVersionBefore, 0)
            || !isSafeIntegerAtLeast(edge.laneVersionAfter, 1)
            || edge.laneVersionAfter !== edge.laneVersionBefore + 1
            || !isSafeIntegerAtLeast(edge.sourceStockVersion, 1)
        ) {
            throw new ValidationError(`Checkout inventory edge ${index + 1} is malformed.`);
        }

        const key = `${edge.variantId}\0${edge.pool}\0${edge.lane}`;
        if (keys.has(key) || variantIds.has(edge.variantId)) {
            throw new ValidationError("Checkout inventory authority contains duplicate variant edges.");
        }
        keys.add(key);
        variantIds.add(edge.variantId);
        return edge as unknown as CheckoutLaneInventoryEdge;
    });
}

function laneKey(variantId: string, pool: string, lane: number): string {
    return `${variantId}\0${pool}\0${lane}`;
}

async function deterministicMovementId(
    namespace: string,
    orderId: string,
    edge: CheckoutLaneInventoryEdge,
): Promise<string> {
    const bytes = new TextEncoder().encode([
        namespace,
        orderId,
        edge.variantId,
        edge.pool,
        String(edge.lane),
    ].join("\0"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${namespace}:${hex}`;
}

async function prepareTerminalEdges(
    db: Database,
    order: CheckoutLaneTransitionOrder,
    operation: CheckoutLaneTerminalOperation,
): Promise<PreparedTerminalEdge[]> {
    const edges = parseCheckoutLaneInventoryEdges(order.checkoutInventoryEdges);
    const variantIds = edges.map((edge) => edge.variantId);
    const [laneResults, variantResults, existingMovementResults] = await safeBatch(db, [
        db.select({
            variantId: inventoryReservationLanes.variantId,
            pool: inventoryReservationLanes.pool,
            lane: inventoryReservationLanes.lane,
            capacity: inventoryReservationLanes.capacity,
            reservedQuantity: inventoryReservationLanes.reservedQuantity,
            version: inventoryReservationLanes.version,
            sourceStockVersion: inventoryReservationLanes.sourceStockVersion,
        })
            .from(inventoryReservationLanes)
            .where(and(
                inArray(inventoryReservationLanes.variantId, variantIds),
                eq(inventoryReservationLanes.pool, "regular"),
                inArray(inventoryReservationLanes.lane, [0, 1]),
            )),
        db.select({
            id: productVariants.id,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            preorderStock: productVariants.preorderStock,
            stockVersion: productVariants.stockVersion,
        })
            .from(productVariants)
            .where(inArray(productVariants.id, variantIds)),
        db.select({ id: checkoutInventoryLaneMovements.id })
            .from(checkoutInventoryLaneMovements)
            .where(eq(checkoutInventoryLaneMovements.orderId, order.id)),
    ] as const) as unknown as [CheckoutLaneRow[], CheckoutVariantRow[], Array<{ id: string }>];

    if (existingMovementResults.length > 0) {
        throw new ValidationError(
            `Checkout inventory for order ${order.id} has a terminal edge but remains lane-reserved.`,
        );
    }

    const lanes = new Map(laneResults.map((lane) => [
        laneKey(lane.variantId, lane.pool, lane.lane),
        lane,
    ]));
    const variants = new Map(variantResults.map((variant) => [variant.id, variant]));

    for (const variantId of variantIds) {
        const variant = variants.get(variantId);
        const lane0 = lanes.get(laneKey(variantId, "regular", 0));
        const lane1 = lanes.get(laneKey(variantId, "regular", 1));
        if (!variant || !lane0 || !lane1 || lane0.capacity == null || lane1.capacity == null) {
            throw new ValidationError(`Checkout inventory authority is missing for variant ${variantId}.`);
        }
        if (
            lane0.sourceStockVersion !== variant.stockVersion
            || lane1.sourceStockVersion !== variant.stockVersion
        ) {
            throw new ValidationError(`Checkout inventory capacity is stale for variant ${variantId}.`);
        }
        const totalReserved = lane0.reservedQuantity + lane1.reservedQuantity;
        const totalCapacity = lane0.capacity + lane1.capacity;
        const expectedCapacity = Math.max(
            totalReserved,
            Math.max(0, variant.stock - variant.reservedStock),
        );
        if (totalCapacity !== expectedCapacity) {
            throw new ValidationError(`Checkout inventory capacity is inconsistent for variant ${variantId}.`);
        }
    }

    return Promise.all(edges.map(async (edge) => {
        const lane = lanes.get(laneKey(edge.variantId, edge.pool, edge.lane));
        const variant = variants.get(edge.variantId);
        if (!lane || lane.capacity == null || !variant) {
            throw new ValidationError(`Checkout inventory authority is missing for variant ${edge.variantId}.`);
        }
        if (lane.reservedQuantity < edge.quantity) {
            throw new ValidationError(`Checkout reservation is incomplete for variant ${edge.variantId}.`);
        }
        if (operation === "deducted" && variant.stock < edge.quantity) {
            throw new ValidationError(`Physical stock is insufficient for variant ${edge.variantId}.`);
        }
        return {
            edge,
            lane: lane as CheckoutLaneRow & { capacity: number },
            variant,
            laneMovementId: await deterministicMovementId(
                "checkout_lane_terminal_v1",
                order.id,
                edge,
            ),
            stockMovementId: operation === "deducted"
                ? await deterministicMovementId("checkout_lane_stock_v1", order.id, edge)
                : null,
        };
    }));
}

function terminalPostcondition(
    db: Database,
    order: CheckoutLaneTransitionOrder,
    expectedStatus: string,
    operation: CheckoutLaneTerminalOperation,
    prepared: readonly PreparedTerminalEdge[],
): ReturnType<typeof buildBatchGuard> {
    const targetAction = operation === "deducted" ? "deducted" : "restored";
    const conditions: SQL[] = [sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${order.id}
          AND ${orders.status} = ${expectedStatus}
          AND ${orders.inventoryAction} = ${targetAction}
          AND ${orders.inventoryAuthority} = ${CHECKOUT_LANE_INVENTORY_AUTHORITY}
          AND ${orders.checkoutAggregateVersion} = 1
    )`];

    for (const item of prepared) {
        const { edge, lane, variant } = item;
        const expectedSourceVersion = variant.stockVersion + (operation === "deducted" ? 1 : 0);
        conditions.push(sql`EXISTS (
            SELECT 1 FROM ${checkoutInventoryLaneMovements}
            WHERE ${checkoutInventoryLaneMovements.id} = ${item.laneMovementId}
              AND ${checkoutInventoryLaneMovements.orderId} = ${order.id}
              AND ${checkoutInventoryLaneMovements.variantId} = ${edge.variantId}
              AND ${checkoutInventoryLaneMovements.operation} = ${operation}
              AND ${checkoutInventoryLaneMovements.quantity} = ${edge.quantity}
        )`);
        conditions.push(sql`EXISTS (
            SELECT 1 FROM ${inventoryReservationLanes}
            WHERE ${inventoryReservationLanes.variantId} = ${edge.variantId}
              AND ${inventoryReservationLanes.pool} = ${edge.pool}
              AND ${inventoryReservationLanes.lane} = ${edge.lane}
              AND ${inventoryReservationLanes.reservedQuantity} = ${lane.reservedQuantity - edge.quantity}
              AND ${inventoryReservationLanes.version} = ${lane.version + 1}
              AND ${inventoryReservationLanes.sourceStockVersion} = ${expectedSourceVersion}
        )`);
        if (operation === "deducted") {
            conditions.push(sql`EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.id} = ${edge.variantId}
                  AND ${productVariants.stock} = ${variant.stock - edge.quantity}
                  AND ${productVariants.reservedStock} = ${variant.reservedStock}
                  AND ${productVariants.preorderStock} = ${variant.preorderStock}
                  AND ${productVariants.stockVersion} = ${variant.stockVersion + 1}
            )`);
            conditions.push(sql`EXISTS (
                SELECT 1 FROM ${inventoryMovements}
                WHERE ${inventoryMovements.id} = ${item.stockMovementId}
                  AND ${inventoryMovements.orderId} = ${order.id}
                  AND ${inventoryMovements.variantId} = ${edge.variantId}
                  AND ${inventoryMovements.type} = 'deducted'
                  AND ${inventoryMovements.quantity} = ${edge.quantity}
                  AND ${inventoryMovements.stockVersionBefore} = ${variant.stockVersion}
                  AND ${inventoryMovements.stockVersionAfter} = ${variant.stockVersion + 1}
            )`);
        }
    }

    const predicate = sql.join(
        conditions.map((condition) => sql`(${condition})`),
        sql` AND `,
    );
    return buildBatchGuard(
        db,
        predicate,
        "CHECKOUT_LANE_TRANSITION_POSTCONDITION_FAILED",
    );
}

function buildTerminalStatements(
    db: Database,
    order: CheckoutLaneTransitionOrder,
    expectedStatus: string,
    operation: CheckoutLaneTerminalOperation,
    prepared: readonly PreparedTerminalEdge[],
) {
    const statements = [];

    for (const item of prepared) {
        const { edge, lane, variant } = item;
        statements.push(db.insert(checkoutInventoryLaneMovements).values({
            id: item.laneMovementId,
            orderId: order.id,
            variantId: edge.variantId,
            pool: "regular",
            lane: edge.lane,
            operation,
            quantity: edge.quantity,
            laneCapacityBefore: lane.capacity,
            laneReservedBefore: lane.reservedQuantity,
            laneReservedAfter: lane.reservedQuantity - edge.quantity,
            laneVersionBefore: lane.version,
            laneVersionAfter: lane.version + 1,
            sourceStockVersionBefore: variant.stockVersion,
            sourceStockVersionAfter: variant.stockVersion + (operation === "deducted" ? 1 : 0),
            stockBefore: variant.stock,
            stockAfter: variant.stock - (operation === "deducted" ? edge.quantity : 0),
            legacyReservedStockBefore: variant.reservedStock,
            legacyReservedStockAfter: variant.reservedStock,
        }).returning({ id: checkoutInventoryLaneMovements.id }));

        if (operation === "deducted") {
            statements.push(db.insert(inventoryMovements).values({
                id: item.stockMovementId!,
                variantId: edge.variantId,
                orderId: order.id,
                type: "deducted",
                quantity: edge.quantity,
                previousStock: variant.stock,
                newStock: variant.stock - edge.quantity,
                notes: `Stock deducted from checkout lane on shipment for order ${order.id}`,
                ledgerVersion: 2,
                pool: "regular",
                reservationGeneration: 1,
                stockVersionBefore: variant.stockVersion,
                stockVersionAfter: variant.stockVersion + 1,
                stockDelta: -edge.quantity,
                previousReservedStock: variant.reservedStock,
                newReservedStock: variant.reservedStock,
                reservedStockDelta: 0,
                previousPreorderStock: variant.preorderStock,
                newPreorderStock: variant.preorderStock,
                preorderStockDelta: 0,
            }).returning({ id: inventoryMovements.id }));
        }

        statements.push(db.update(inventoryReservationLanes).set({
            reservedQuantity: sql`${inventoryReservationLanes.reservedQuantity} - ${edge.quantity}`,
            version: sql`${inventoryReservationLanes.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(inventoryReservationLanes.variantId, edge.variantId),
            eq(inventoryReservationLanes.pool, edge.pool),
            eq(inventoryReservationLanes.lane, edge.lane),
            eq(inventoryReservationLanes.capacity, lane.capacity),
            eq(inventoryReservationLanes.reservedQuantity, lane.reservedQuantity),
            eq(inventoryReservationLanes.version, lane.version),
            eq(inventoryReservationLanes.sourceStockVersion, lane.sourceStockVersion),
        )).returning({ variantId: inventoryReservationLanes.variantId }));

        if (operation === "deducted") {
            statements.push(db.update(productVariants).set({
                stock: sql`${productVariants.stock} - ${edge.quantity}`,
                stockVersion: sql`${productVariants.stockVersion} + 1`,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(productVariants.id, edge.variantId),
                eq(productVariants.stock, variant.stock),
                eq(productVariants.reservedStock, variant.reservedStock),
                eq(productVariants.preorderStock, variant.preorderStock),
                eq(productVariants.stockVersion, variant.stockVersion),
                sql`${productVariants.stock} >= ${edge.quantity}`,
            )).returning({ id: productVariants.id }));
        }
    }

    statements.push(db.update(orders).set({
        inventoryAction: operation === "deducted" ? "deducted" : "restored",
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, order.id),
        eq(orders.status, expectedStatus),
        eq(orders.inventoryAction, "reserved"),
        eq(orders.inventoryAuthority, CHECKOUT_LANE_INVENTORY_AUTHORITY),
        eq(orders.checkoutAggregateVersion, 1),
    )).returning({ id: orders.id }));
    statements.push(terminalPostcondition(db, order, expectedStatus, operation, prepared));
    return statements;
}

function isRetriableLaneTransitionError(error: unknown): boolean {
    if (isTursoConflictError(error)) return true;
    const message = error instanceof Error ? error.message : String(error);
    return isBatchGuardError(
        error,
        "CHECKOUT_LANE_TRANSITION_POSTCONDITION_FAILED",
    ) || /(?:CHECKOUT_LANE_TRANSITION|checkout_inventory_lane_movements.*UNIQUE|inventory_movements.*UNIQUE)/i.test(message);
}

async function readConvergedAction(
    db: Database,
    orderId: string,
): Promise<{ status: string; inventoryAction: string; inventoryAuthority: string } | null> {
    return await db.select({
        status: orders.status,
        inventoryAction: orders.inventoryAction,
        inventoryAuthority: orders.inventoryAuthority,
    }).from(orders).where(eq(orders.id, orderId)).get() ?? null;
}

/**
 * Consume every exact reservation edge and advance the order action in one
 * atomic provider transaction. A response lost after commit converges by the
 * order action; a competing transition either reaches the same state or fails
 * closed without a partial lane/stock mutation.
 */
export async function terminateCheckoutLaneReservations(
    db: Database,
    order: CheckoutLaneTransitionOrder,
    expectedStatus: string,
    operation: CheckoutLaneTerminalOperation,
): Promise<CheckoutLaneTerminalResult> {
    if (
        order.checkoutAggregateVersion !== 1
        || order.inventoryAuthority !== CHECKOUT_LANE_INVENTORY_AUTHORITY
        || order.inventoryAction !== "reserved"
        || order.inventoryPool !== "regular"
        || order.status !== expectedStatus
    ) {
        throw new ValidationError(`Order ${order.id} does not own an active checkout-lane reservation.`);
    }

    const targetAction = operation === "deducted" ? "deducted" : "restored";
    for (let attempt = 0; attempt < CHECKOUT_LANE_TRANSITION_ATTEMPTS; attempt += 1) {
        try {
            const prepared = await prepareTerminalEdges(db, order, operation);
            await safeBatch(db, buildTerminalStatements(
                db,
                order,
                expectedStatus,
                operation,
                prepared,
            ) as never);
            return {
                action: targetAction,
                variantIds: prepared.map((item) => item.edge.variantId),
            };
        } catch (error) {
            const converged = await readConvergedAction(db, order.id);
            if (
                converged?.status === expectedStatus
                && converged.inventoryAction === targetAction
                && converged.inventoryAuthority === CHECKOUT_LANE_INVENTORY_AUTHORITY
            ) {
                return {
                    action: targetAction,
                    variantIds: parseCheckoutLaneInventoryEdges(order.checkoutInventoryEdges)
                        .map((edge) => edge.variantId),
                };
            }
            if (!isRetriableLaneTransitionError(error) || attempt + 1 >= CHECKOUT_LANE_TRANSITION_ATTEMPTS) {
                break;
            }
        }
    }

    throw new ValidationError(
        `Checkout inventory transition could not be proven for order ${order.id}.`,
        { orderId: order.id, operation },
    );
}
