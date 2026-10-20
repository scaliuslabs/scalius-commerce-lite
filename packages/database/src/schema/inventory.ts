// src/db/schema/inventory.ts
// Inventory tracking tables: inventoryLocations, inventoryLevels,
// inventoryMovements, inventoryOperations, productLowStockAlerts.

import { sqliteTable, text, integer, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { products, productVariants } from "./products";
import { UNIX_NOW } from "./shared";
import { AlertStatus } from "./enums";

export const INVENTORY_LOCATION_KINDS = ["warehouse", "store", "other"] as const;
export type InventoryLocationKind = (typeof INVENTORY_LOCATION_KINDS)[number];
export const INVENTORY_LOCATION_STATUSES = ["active", "archived"] as const;
export type InventoryLocationStatus = (typeof INVENTORY_LOCATION_STATUSES)[number];
/** Created by migration 0102; the store's default location until the merchant picks another. */
export const DEFAULT_INVENTORY_LOCATION_ID = "loc_default";

/**
 * Where physical stock is held. Exactly one active location is the default
 * (partial unique index plus the default-is-active check): stock that moves
 * without an explicit location moves there. Locations are archived, never
 * deleted, so movements and orders keep pointing at them.
 */
export const inventoryLocations = sqliteTable("inventory_locations", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Short merchant code; unique by `lower(trim(code))`. */
    code: text("code").notNull(),
    kind: text("kind", { enum: INVENTORY_LOCATION_KINDS }).notNull().default("warehouse"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postalCode: text("postal_code"),
    countryCode: text("country_code").notNull().default("BD"),
    phone: text("phone"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: INVENTORY_LOCATION_STATUSES }).notNull().default("active"),
    position: integer("position").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("inventory_locations_code_unique").on(sql`lower(trim(${table.code}))`),
    uniqueIndex("inventory_locations_default_unique")
        .on(table.isDefault)
        .where(sql`${table.isDefault} = 1`),
    index("inventory_locations_status_position_idx").on(table.status, table.position),
    check("inventory_locations_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
    check("inventory_locations_code_length", sql`length(trim(${table.code})) BETWEEN 1 AND 24`),
    check("inventory_locations_kind_check", sql`${table.kind} IN ('warehouse', 'store', 'other')`),
    check("inventory_locations_status_check", sql`${table.status} IN ('active', 'archived')`),
    check("inventory_locations_default_active", sql`${table.isDefault} = 0 OR ${table.status} = 'active'`),
    check("inventory_locations_version_positive", sql`${table.version} >= 1`),
]);

/**
 * On-hand units of one SKU at one location. Trigger-maintained only (like
 * `category_closure`): every ledger-v2 movement with a stock delta books it
 * at its location, a compensating movement delete reverses it, and a SKU
 * inserted with stock books that stock at the default location. Application
 * code never writes it. For every SKU, the levels sum to
 * `product_variants.stock`; the CHECK makes a shipment from a location
 * without the units abort its whole batch.
 */
export const inventoryLevels = sqliteTable("inventory_levels", {
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: text("location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    onHand: integer("on_hand").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.variantId, table.locationId] }),
    index("inventory_levels_location_idx").on(table.locationId, table.onHand, table.variantId),
    index("inventory_levels_positive_variant_idx").on(table.variantId).where(sql`${table.onHand} > 0`),
    check("inventory_levels_on_hand_nonnegative", sql`${table.onHand} >= 0`),
]);

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
    // Nullable and not a foreign key: manual stock operations have no order.
    orderId: text("order_id"),
    type: text("type").notNull(),
    quantity: integer("quantity").notNull(),
    previousStock: integer("previous_stock").notNull(),
    newStock: integer("new_stock").notNull(),
    notes: text("notes"),
    createdBy: text("created_by"),
    // Every production counter mutation writes a complete version edge and all
    // counter deltas (ledger v2).
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
    /**
     * Where physical stock moved. Required (trigger) on every v2 movement
     * whose `stock_delta` is not zero; reservations and releases leave it
     * null. Deducts and restores carry it even for pools that move no
     * physical stock, so a restore can find where its units left from.
     * Keep it the last column: movement claims insert by position.
     */
    locationId: text("location_id")
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
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
        enum: ["manual_adjustment", "scanner_adjustment", "stocktake", "licence_keys"],
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
 * Multi-SKU stock commands (migration 0109): receiving a purchase order and
 * shipping, receiving or cancelling a transfer. One row per merchant
 * operation key, inserted in the same batch as the command's ledger-v2
 * movements and stockVersion CAS updates; an exact retry replays
 * `result_payload`, a changed request under the same key is refused.
 * Immutable (triggers).
 */
export const INVENTORY_COMMAND_TYPES = [
    "purchase_order_receive",
    "transfer_ship",
    "transfer_receive",
    "transfer_cancel",
] as const;
export type InventoryCommandType = (typeof INVENTORY_COMMAND_TYPES)[number];

export const inventoryCommands = sqliteTable("inventory_commands", {
    operationKey: text("operation_key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    commandType: text("command_type", { enum: INVENTORY_COMMAND_TYPES }).notNull(),
    /** The purchase order or transfer the command acted on. */
    subjectId: text("subject_id").notNull(),
    /** The subject's revision this command produced: commands of one subject in order. */
    subjectRevision: integer("subject_revision").notNull(),
    resultPayload: text("result_payload").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("inventory_commands_subject_revision_unique").on(table.subjectId, table.subjectRevision),
    check("inventory_commands_subject_revision_positive", sql`${table.subjectRevision} >= 1`),
    check(
        "inventory_commands_type_check",
        sql`${table.commandType} IN ('purchase_order_receive', 'transfer_ship', 'transfer_receive', 'transfer_cancel')`,
    ),
    check("inventory_commands_payload_json", sql`json_valid(${table.resultPayload})`),
]);

/**
 * Stock moved between two locations (migration 0109). Shipping takes the
 * units out of the origin (`transfer_out` movements: they leave the origin
 * level and the SKU's `stock`, so buyers cannot buy units in transit);
 * receiving books them at the destination (`transfer_in`), partially if
 * need be; cancelling returns whatever is still in transit to the origin
 * (`transfer_in` there). Every step keeps sum(levels) = stock.
 */
export const INVENTORY_TRANSFER_STATUSES = [
    "draft",
    "in_transit",
    "partially_received",
    "received",
    "cancelled",
] as const;
export type InventoryTransferStatus = (typeof INVENTORY_TRANSFER_STATUSES)[number];

export const inventoryTransfers = sqliteTable("inventory_transfers", {
    id: text("id").primaryKey(),
    /** Merchant-facing number (#T1001), unique and increasing. */
    number: integer("number").notNull(),
    originLocationId: text("origin_location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    destinationLocationId: text("destination_location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    status: text("status", { enum: INVENTORY_TRANSFER_STATUSES }).notNull().default("draft"),
    /** Calendar date (YYYY-MM-DD) the merchant expects it to arrive. */
    expectedOn: text("expected_on"),
    reference: text("reference"),
    notes: text("notes"),
    shippedAt: integer("shipped_at", { mode: "timestamp" }),
    receivedAt: integer("received_at", { mode: "timestamp" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    /** Advanced by every write; edits and commands require the current value. */
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("inventory_transfers_number_unique").on(table.number),
    index("inventory_transfers_status_created_idx").on(table.status, table.createdAt),
    index("inventory_transfers_origin_idx").on(table.originLocationId, table.status),
    index("inventory_transfers_destination_idx").on(table.destinationLocationId, table.status),
    check("inventory_transfers_number_positive", sql`${table.number} >= 1`),
    check("inventory_transfers_locations_differ", sql`${table.originLocationId} <> ${table.destinationLocationId}`),
    check(
        "inventory_transfers_status_check",
        sql`${table.status} IN ('draft', 'in_transit', 'partially_received', 'received', 'cancelled')`,
    ),
    check("inventory_transfers_revision_positive", sql`${table.revision} >= 1`),
    check("inventory_transfers_expected_on", sql`${table.expectedOn} IS NULL OR length(${table.expectedOn}) = 10`),
    check(
        "inventory_transfers_text_lengths",
        sql`(${table.reference} IS NULL OR length(${table.reference}) BETWEEN 1 AND 100) AND (${table.notes} IS NULL OR length(${table.notes}) BETWEEN 1 AND 2000)`,
    ),
]);

/**
 * One SKU on a transfer. In transit = shipped − received − returned; shipped
 * is all of the quantity or nothing (a transfer ships whole).
 */
export const inventoryTransferLines = sqliteTable("inventory_transfer_lines", {
    id: text("id").primaryKey(),
    transferId: text("transfer_id")
        .notNull()
        .references(() => inventoryTransfers.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),
    quantity: integer("quantity").notNull(),
    shippedQuantity: integer("shipped_quantity").notNull().default(0),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    /** Units a cancellation returned to the origin. */
    returnedQuantity: integer("returned_quantity").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("inventory_transfer_lines_transfer_variant_unique").on(table.transferId, table.variantId),
    index("inventory_transfer_lines_variant_idx").on(table.variantId, table.transferId),
    check("inventory_transfer_lines_quantity_positive", sql`${table.quantity} >= 1`),
    check(
        "inventory_transfer_lines_progress",
        sql`(${table.shippedQuantity} = 0 OR ${table.shippedQuantity} = ${table.quantity}) AND ${table.receivedQuantity} >= 0 AND ${table.returnedQuantity} >= 0 AND ${table.receivedQuantity} + ${table.returnedQuantity} <= ${table.shippedQuantity}`,
    ),
    check("inventory_transfer_lines_position_nonnegative", sql`${table.position} >= 0`),
]);

/** Which ledger movement each transfer step wrote, per line. Immutable (triggers). */
export const INVENTORY_TRANSFER_MOVEMENT_KINDS = ["ship", "receive", "return"] as const;
export type InventoryTransferMovementKind = (typeof INVENTORY_TRANSFER_MOVEMENT_KINDS)[number];

export const inventoryTransferMovements = sqliteTable("inventory_transfer_movements", {
    id: text("id").primaryKey(),
    operationKey: text("operation_key")
        .notNull()
        .references(() => inventoryCommands.operationKey, { onDelete: "restrict" }),
    transferId: text("transfer_id")
        .notNull()
        .references(() => inventoryTransfers.id, { onDelete: "restrict" }),
    transferLineId: text("transfer_line_id")
        .notNull()
        .references(() => inventoryTransferLines.id, { onDelete: "restrict" }),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    locationId: text("location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    movementId: text("movement_id")
        .notNull()
        .references(() => inventoryMovements.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: INVENTORY_TRANSFER_MOVEMENT_KINDS }).notNull(),
    quantity: integer("quantity").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("inventory_transfer_movements_movement_unique").on(table.movementId),
    index("inventory_transfer_movements_transfer_idx").on(table.transferId, table.createdAt),
    // Foreign keys a SKU delete and a draft transfer's line replacement check.
    index("inventory_transfer_movements_variant_idx").on(table.variantId),
    index("inventory_transfer_movements_line_idx").on(table.transferLineId),
    check("inventory_transfer_movements_kind_check", sql`${table.kind} IN ('ship', 'receive', 'return')`),
    check("inventory_transfer_movements_quantity_positive", sql`${table.quantity} >= 1`),
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

export type InventoryLocation = InferSelectModel<typeof inventoryLocations>;
export type InventoryLevel = InferSelectModel<typeof inventoryLevels>;
export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type InventoryOperation = InferSelectModel<typeof inventoryOperations>;
export type InventoryCommand = InferSelectModel<typeof inventoryCommands>;
export type InventoryTransfer = InferSelectModel<typeof inventoryTransfers>;
export type InventoryTransferLine = InferSelectModel<typeof inventoryTransferLines>;
export type InventoryTransferMovement = InferSelectModel<typeof inventoryTransferMovements>;
export type ProductLowStockAlert = InferSelectModel<typeof productLowStockAlerts>;
