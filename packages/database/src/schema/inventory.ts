// src/db/schema/inventory.ts
// Inventory tracking tables: inventoryMovements, productLowStockAlerts.

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
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
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("inventory_movements_variant_idx").on(table.variantId),
    index("inventory_movements_order_idx").on(table.orderId),
    index("inventory_movements_created_at_idx").on(table.createdAt),
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
export type ProductLowStockAlert = InferSelectModel<typeof productLowStockAlerts>;
