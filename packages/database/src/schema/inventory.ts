// src/db/schema/inventory.ts
// Inventory tracking tables: inventoryMovements, productLowStockAlerts.

import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { products, productVariants } from "./products";
import { UNIX_NOW } from "./shared";
import { AlertStatus } from "./enums";

/**
 * Audit log for all stock movements.
 * type values: reserved | deducted | released | adjusted | preorder_reserved | preorder_deducted
 * quantity: Positive = added, negative = removed
 */
export const inventoryMovements = sqliteTable("inventory_movements", {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    // Checkout reserves inventory before the order row is committed. Keep this
    // nullable/non-enforced so reservation movements can be durable claims for
    // queued order ingestion and later reconciliation.
    orderId: text("order_id"),
    type: text("type").notNull(),
    quantity: integer("quantity").notNull(),
    previousStock: integer("previous_stock").notNull(),
    newStock: integer("new_stock").notNull(),
    notes: text("notes"),
    createdBy: text("created_by"),
    // Ledger v2 fields are nullable for legacy rows. Every new production
    // counter mutation writes a complete version edge and all counter deltas.
    ledgerVersion: integer("ledger_version").notNull().default(1),
    pool: text("pool"),
    reservationGeneration: integer("reservation_generation"),
    stockVersionBefore: integer("stock_version_before"),
    stockVersionAfter: integer("stock_version_after"),
    stockDelta: integer("stock_delta"),
    previousReservedStock: integer("previous_reserved_stock"),
    newReservedStock: integer("new_reserved_stock"),
    reservedStockDelta: integer("reserved_stock_delta"),
    previousPreorderStock: integer("previous_preorder_stock"),
    newPreorderStock: integer("new_preorder_stock"),
    preorderStockDelta: integer("preorder_stock_delta"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("inventory_movements_variant_idx").on(table.variantId),
    index("inventory_movements_order_idx").on(table.orderId),
    index("inventory_movements_created_at_idx").on(table.createdAt),
    index("inventory_movements_type_created_at_idx").on(
        table.type,
        table.createdAt,
    ),
    index("inventory_movements_generation_idx").on(
        table.orderId,
        table.variantId,
        table.pool,
        table.reservationGeneration,
    ),
    uniqueIndex("inventory_movements_variant_version_uidx").on(
        table.variantId,
        table.stockVersionAfter,
    ),
]);

/**
 * Durable replay ledger for merchant-originated stock writes. Rows are inserted
 * only in the same D1 batch that commits the matching movement/counter edge;
 * there is intentionally no standalone pending state to reconcile.
 */
export const inventoryOperations = sqliteTable("inventory_operations", {
    operationKey: text("operation_key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    operationType: text("operation_type", {
        enum: ["manual_adjustment", "scanner_adjustment", "stocktake"],
    }).notNull(),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    movementId: text("movement_id")
        .references(() => inventoryMovements.id, { onDelete: "restrict" }),
    resultPayload: text("result_payload").notNull(),
    stockVersionBefore: integer("stock_version_before").notNull(),
    stockVersionAfter: integer("stock_version_after").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("inventory_operations_variant_created_idx").on(
        table.variantId,
        table.createdAt,
    ),
    index("inventory_operations_movement_idx").on(table.movementId),
]);

/**
 * Checkout reservation authority split into independent capacity lanes.
 *
 * A checkout transaction mutates only the lane recorded in its immutable
 * order edge. The sum of finite lane capacities is reconciled to the owning
 * variant pool before coordinated checkout is enabled. D1 serializes lane
 * commits; concurrent-writer providers may safely commit disjoint lanes in
 * parallel without sharing a hot reservation counter.
 */
export const inventoryReservationLanes = sqliteTable("inventory_reservation_lanes", {
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "cascade" }),
    pool: text("pool", {
        enum: ["regular", "preorder", "backorder"],
    }).notNull(),
    lane: integer("lane").notNull(),
    /** Null capacity is reserved for an explicitly unlimited backorder pool. */
    capacity: integer("capacity"),
    reservedQuantity: integer("reserved_quantity").notNull().default(0),
    version: integer("version").notNull().default(0),
    /** Product-variant stock CAS version from the last capacity reconciliation. */
    sourceStockVersion: integer("source_stock_version").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({
        name: "inventory_reservation_lanes_pk",
        columns: [table.variantId, table.pool, table.lane],
    }),
    check(
        "inventory_reservation_lanes_pool_check",
        sql`${table.pool} IN ('regular', 'preorder', 'backorder')`,
    ),
    check(
        "inventory_reservation_lanes_lane_check",
        sql`${table.lane} BETWEEN 0 AND 31`,
    ),
    check(
        "inventory_reservation_lanes_reserved_check",
        sql`${table.reservedQuantity} >= 0`,
    ),
    check(
        "inventory_reservation_lanes_capacity_check",
        sql`${table.capacity} IS NULL OR (${table.capacity} >= 0 AND ${table.reservedQuantity} <= ${table.capacity})`,
    ),
    check(
        "inventory_reservation_lanes_finite_pool_check",
        sql`${table.pool} = 'backorder' OR ${table.capacity} IS NOT NULL`,
    ),
    index("inventory_reservation_lanes_pool_idx").on(table.pool, table.variantId),
]);

/**
 * Immutable terminal edges for coordinated checkout reservations.
 *
 * The original reservation edge is embedded in the immutable order aggregate;
 * this table proves exactly how that lane reservation was consumed. One
 * aggregate edge can terminate only once, either by release or stock
 * deduction. Physical stock deductions additionally write ledger-v2 in
 * `inventory_movements` in the same transaction.
 */
export const checkoutInventoryLaneMovements = sqliteTable("checkout_inventory_lane_movements", {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    pool: text("pool", { enum: ["regular"] }).notNull(),
    lane: integer("lane").notNull(),
    operation: text("operation", { enum: ["released", "deducted"] }).notNull(),
    quantity: integer("quantity").notNull(),
    laneCapacityBefore: integer("lane_capacity_before").notNull(),
    laneReservedBefore: integer("lane_reserved_before").notNull(),
    laneReservedAfter: integer("lane_reserved_after").notNull(),
    laneVersionBefore: integer("lane_version_before").notNull(),
    laneVersionAfter: integer("lane_version_after").notNull(),
    sourceStockVersionBefore: integer("source_stock_version_before").notNull(),
    sourceStockVersionAfter: integer("source_stock_version_after").notNull(),
    stockBefore: integer("stock_before").notNull(),
    stockAfter: integer("stock_after").notNull(),
    legacyReservedStockBefore: integer("legacy_reserved_stock_before").notNull(),
    legacyReservedStockAfter: integer("legacy_reserved_stock_after").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("checkout_inventory_lane_movements_edge_uidx").on(
        table.orderId,
        table.variantId,
        table.pool,
        table.lane,
    ),
    index("checkout_inventory_lane_movements_variant_idx").on(table.variantId, table.createdAt),
    index("checkout_inventory_lane_movements_order_idx").on(table.orderId),
    check(
        "checkout_inventory_lane_movements_shape_check",
        sql`${table.pool} = 'regular'
            AND ${table.lane} BETWEEN 0 AND 31
            AND ${table.operation} IN ('released', 'deducted')
            AND ${table.quantity} > 0
            AND ${table.laneCapacityBefore} >= 0
            AND ${table.laneReservedBefore} >= ${table.quantity}
            AND ${table.laneReservedAfter} = ${table.laneReservedBefore} - ${table.quantity}
            AND ${table.laneVersionBefore} >= 0
            AND ${table.laneVersionAfter} = ${table.laneVersionBefore} + 1
            AND ${table.sourceStockVersionBefore} >= 1
            AND ${table.sourceStockVersionAfter} = ${table.sourceStockVersionBefore}
                + CASE WHEN ${table.operation} = 'deducted' THEN 1 ELSE 0 END
            AND ${table.stockBefore} >= 0
            AND ${table.stockAfter} = ${table.stockBefore}
                - CASE WHEN ${table.operation} = 'deducted' THEN ${table.quantity} ELSE 0 END
            AND ${table.legacyReservedStockBefore} >= 0
            AND ${table.legacyReservedStockAfter} = ${table.legacyReservedStockBefore}`,
    ),
]);

export const productLowStockAlerts = sqliteTable("product_low_stock_alerts", {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
        .notNull()
        .unique()
        .references(() => productVariants.id, { onDelete: "cascade" }),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    currentQty: integer("current_qty").notNull(),
    threshold: integer("threshold").notNull(),
    /** Valid: active | acknowledged | resolved (see AlertStatus enum) */
    alertStatus: text("alert_status").notNull().default(AlertStatus.ACTIVE),
    alertSentAt: integer("alert_sent_at", { mode: "timestamp" }),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("pls_alerts_product_idx").on(table.productId),
    index("pls_alerts_status_idx").on(table.alertStatus),
]);

export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type InventoryOperation = InferSelectModel<typeof inventoryOperations>;
export type InventoryReservationLane = InferSelectModel<typeof inventoryReservationLanes>;
export type ProductLowStockAlert = InferSelectModel<typeof productLowStockAlerts>;
