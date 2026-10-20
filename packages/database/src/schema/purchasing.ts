// Purchasing (migration 0109): suppliers, purchase orders and their receipts.
//
// A purchase order is a draft until the merchant marks it ordered; its open
// lines (ordered − received) are the SKU's incoming stock at the PO's
// destination. Receiving books `received` ledger-v2 movements at that
// location in the same batch as the stockVersion CAS (inventory_commands
// holds the operation key), and records each receipt line's unit cost: the
// SKU's cost history. Money is integer minor units of the store currency.

import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { productVariants } from "./products";
import { inventoryCommands, inventoryLocations, inventoryMovements } from "./inventory";
import { UNIX_NOW } from "./shared";

export const SUPPLIER_STATUSES = ["active", "archived"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

/** Who the merchant buys from. Archived, never deleted, so purchase orders keep pointing at them. */
export const suppliers = sqliteTable("suppliers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    notes: text("notes"),
    status: text("status", { enum: SUPPLIER_STATUSES }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("suppliers_status_name_idx").on(table.status, table.name),
    check("suppliers_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 120`),
    check("suppliers_status_check", sql`${table.status} IN ('active', 'archived')`),
    check(
        "suppliers_text_lengths",
        sql`(${table.contactName} IS NULL OR length(${table.contactName}) BETWEEN 1 AND 120) AND (${table.phone} IS NULL OR length(${table.phone}) BETWEEN 1 AND 32) AND (${table.email} IS NULL OR length(${table.email}) BETWEEN 3 AND 254) AND (${table.notes} IS NULL OR length(${table.notes}) BETWEEN 1 AND 2000)`,
    ),
    check("suppliers_version_positive", sql`${table.version} >= 1`),
]);

export const PURCHASE_ORDER_STATUSES = [
    "draft",
    "ordered",
    "partially_received",
    "received",
    "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const purchaseOrders = sqliteTable("purchase_orders", {
    id: text("id").primaryKey(),
    /** Merchant-facing number (#PO1001), unique and increasing. */
    number: integer("number").notNull(),
    supplierId: text("supplier_id")
        .references(() => suppliers.id, { onDelete: "restrict" }),
    /** Where the goods arrive; receiving books them there. */
    destinationLocationId: text("destination_location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    status: text("status", { enum: PURCHASE_ORDER_STATUSES }).notNull().default("draft"),
    /** Calendar date (YYYY-MM-DD) the merchant expects the goods. */
    expectedOn: text("expected_on"),
    /** The supplier's reference or invoice number. */
    reference: text("reference"),
    notes: text("notes"),
    /** Store currency when the PO was created (the store currency is locked once products exist). */
    currencyCode: text("currency_code").notNull(),
    /** As the merchant entered them; not spread into unit costs. */
    shippingMinor: integer("shipping_minor").notNull().default(0),
    otherCostsMinor: integer("other_costs_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    orderedAt: integer("ordered_at", { mode: "timestamp" }),
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
    uniqueIndex("purchase_orders_number_unique").on(table.number),
    index("purchase_orders_status_created_idx").on(table.status, table.createdAt),
    index("purchase_orders_supplier_idx").on(table.supplierId, table.createdAt),
    index("purchase_orders_destination_idx").on(table.destinationLocationId, table.status),
    check("purchase_orders_number_positive", sql`${table.number} >= 1`),
    check(
        "purchase_orders_status_check",
        sql`${table.status} IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')`,
    ),
    check(
        "purchase_orders_costs_nonnegative",
        sql`${table.shippingMinor} >= 0 AND ${table.otherCostsMinor} >= 0 AND ${table.taxMinor} >= 0`,
    ),
    check("purchase_orders_revision_positive", sql`${table.revision} >= 1`),
    check("purchase_orders_currency_code", sql`length(${table.currencyCode}) = 3`),
    check("purchase_orders_expected_on", sql`${table.expectedOn} IS NULL OR length(${table.expectedOn}) = 10`),
    check(
        "purchase_orders_text_lengths",
        sql`(${table.reference} IS NULL OR length(${table.reference}) BETWEEN 1 AND 100) AND (${table.notes} IS NULL OR length(${table.notes}) BETWEEN 1 AND 2000)`,
    ),
]);

/** One SKU on a purchase order. Open (incoming) = quantity − received while the PO is ordered or partially received. */
export const purchaseOrderLines = sqliteTable("purchase_order_lines", {
    id: text("id").primaryKey(),
    purchaseOrderId: text("purchase_order_id")
        .notNull()
        .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),
    quantity: integer("quantity").notNull(),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    unitCostMinor: integer("unit_cost_minor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("purchase_order_lines_order_variant_unique").on(table.purchaseOrderId, table.variantId),
    index("purchase_order_lines_variant_idx").on(table.variantId, table.purchaseOrderId),
    check(
        "purchase_order_lines_quantities",
        sql`${table.quantity} >= 1 AND ${table.receivedQuantity} >= 0 AND ${table.receivedQuantity} <= ${table.quantity}`,
    ),
    check("purchase_order_lines_unit_cost_nonnegative", sql`${table.unitCostMinor} >= 0`),
    check("purchase_order_lines_position_nonnegative", sql`${table.position} >= 0`),
]);

/**
 * One received quantity of one PO line: the `received` movement it wrote and
 * the unit cost it arrived at (the SKU's cost history), with the SKU cost
 * before and after when the receipt updated it. Immutable (triggers).
 */
export const purchaseOrderReceiptLines = sqliteTable("purchase_order_receipt_lines", {
    id: text("id").primaryKey(),
    operationKey: text("operation_key")
        .notNull()
        .references(() => inventoryCommands.operationKey, { onDelete: "restrict" }),
    purchaseOrderId: text("purchase_order_id")
        .notNull()
        .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    purchaseOrderLineId: text("purchase_order_line_id")
        .notNull()
        .references(() => purchaseOrderLines.id, { onDelete: "restrict" }),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "restrict" }),
    locationId: text("location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    movementId: text("movement_id")
        .notNull()
        .references(() => inventoryMovements.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitCostMinor: integer("unit_cost_minor").notNull(),
    costBeforeMinor: integer("cost_before_minor"),
    costAfterMinor: integer("cost_after_minor"),
    costUpdated: integer("cost_updated", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("purchase_order_receipt_lines_movement_unique").on(table.movementId),
    index("purchase_order_receipt_lines_order_idx").on(table.purchaseOrderId, table.createdAt),
    index("purchase_order_receipt_lines_variant_idx").on(table.variantId, table.createdAt),
    // A draft order's line replacement checks this foreign key.
    index("purchase_order_receipt_lines_line_idx").on(table.purchaseOrderLineId),
    check("purchase_order_receipt_lines_quantity_positive", sql`${table.quantity} >= 1`),
    check(
        "purchase_order_receipt_lines_costs_nonnegative",
        sql`${table.unitCostMinor} >= 0 AND (${table.costBeforeMinor} IS NULL OR ${table.costBeforeMinor} >= 0) AND (${table.costAfterMinor} IS NULL OR ${table.costAfterMinor} >= 0)`,
    ),
]);

export type Supplier = InferSelectModel<typeof suppliers>;
export type PurchaseOrder = InferSelectModel<typeof purchaseOrders>;
export type PurchaseOrderLine = InferSelectModel<typeof purchaseOrderLines>;
export type PurchaseOrderReceiptLine = InferSelectModel<typeof purchaseOrderReceiptLines>;
