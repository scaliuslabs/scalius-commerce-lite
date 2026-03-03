// src/db/schema/inventory.ts
// Inventory tracking tables: inventoryMovements, productLowStockAlerts.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";

/**
 * Audit log for all stock movements.
 * type values: reserved | deducted | released | adjusted | preorder_reserved | preorder_deducted
 * quantity: Positive = added, negative = removed
 */
export const inventoryMovements = sqliteTable("inventory_movements", {
    id: text("id").primaryKey(),
    variantId: text("variant_id").notNull(),
    orderId: text("order_id"),
    type: text("type").notNull(),
    quantity: integer("quantity").notNull(),
    previousStock: integer("previous_stock").notNull(),
    newStock: integer("new_stock").notNull(),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
    index("inventory_movements_variant_idx").on(table.variantId),
    index("inventory_movements_order_idx").on(table.orderId),
    index("inventory_movements_created_at_idx").on(table.createdAt),
]);

export const productLowStockAlerts = sqliteTable("product_low_stock_alerts", {
    id: text("id").primaryKey(),
    variantId: text("variant_id").notNull().unique(),
    productId: text("product_id").notNull(),
    currentQty: integer("current_qty").notNull(),
    threshold: integer("threshold").notNull(),
    alertStatus: text("alert_status").notNull().default("active"),
    alertSentAt: integer("alert_sent_at", { mode: "timestamp" }),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(cast(strftime('%s','now') as int))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
    index("pls_alerts_product_idx").on(table.productId),
    index("pls_alerts_status_idx").on(table.alertStatus),
]);

export type InventoryMovement = InferSelectModel<typeof inventoryMovements>;
export type ProductLowStockAlert = InferSelectModel<typeof productLowStockAlerts>;
