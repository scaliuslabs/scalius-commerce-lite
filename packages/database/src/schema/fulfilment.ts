// Order-line fulfilment ledger (Wave A §2.2): append-only facts that units
// were handed over — to a courier, at the pickup counter, digitally, or as a
// performed service. `order_items.fulfilled_quantity` is a trigger projection
// of the active lines here; a fulfilment only ever moves active -> voided.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders, orderItems } from "./orders";
import { deliveryShipments } from "./delivery";

export const orderFulfillments = sqliteTable("order_fulfillments", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    /** Equals the `fulfillment_type` of every line it carries. */
    kind: text("kind", { enum: ["ship", "pickup", "digital", "gift_card", "service"] }).notNull(),
    status: text("status", { enum: ["active", "voided"] }).notNull().default("active"),
    /** The courier parcel a `ship` fulfilment handed over, when there is one. */
    shipmentId: text("shipment_id")
        .references(() => deliveryShipments.id, { onDelete: "restrict" }),
    /** Idempotency key of the action that recorded it, unique per order. */
    requestKey: text("request_key").notNull(),
    actorType: text("actor_type", { enum: ["admin", "system"] }).notNull(),
    actorId: text("actor_id"),
    /** Cash taken at the pickup counter in the same command, in order-currency minor units. */
    cashCollectedMinor: integer("cash_collected_minor"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    voidedAt: integer("voided_at"),
}, (table) => [
    uniqueIndex("order_fulfillments_order_request_key_unique").on(table.orderId, table.requestKey),
    index("order_fulfillments_order_created_idx").on(table.orderId, table.createdAt),
    uniqueIndex("order_fulfillments_shipment_unique")
        .on(table.shipmentId)
        .where(sql`${table.shipmentId} IS NOT NULL`),
    check("order_fulfillments_kind_check", sql`${table.kind} IN ('ship', 'pickup', 'digital', 'gift_card', 'service')`),
    check("order_fulfillments_status_check", sql`${table.status} IN ('active', 'voided')`),
    check("order_fulfillments_void_shape", sql`(${table.status} = 'active' AND ${table.voidedAt} IS NULL) OR (${table.status} = 'voided' AND ${table.voidedAt} IS NOT NULL)`),
    check("order_fulfillments_actor_type_check", sql`${table.actorType} IN ('admin', 'system')`),
    check("order_fulfillments_request_key_length", sql`length(trim(${table.requestKey})) BETWEEN 1 AND 200`),
    check("order_fulfillments_cash_nonnegative", sql`${table.cashCollectedMinor} IS NULL OR ${table.cashCollectedMinor} >= 0`),
    check("order_fulfillments_shipment_is_ship", sql`${table.shipmentId} IS NULL OR ${table.kind} = 'ship'`),
    // Triggers: order_fulfillments_update_guard (only active -> voided),
    // order_fulfillments_delete_blocked, order_fulfillments_project_void.
]);

export const orderFulfillmentLines = sqliteTable("order_fulfillment_lines", {
    id: text("id").primaryKey(),
    fulfillmentId: text("fulfillment_id")
        .notNull()
        .references(() => orderFulfillments.id, { onDelete: "restrict" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: text("order_item_id")
        .notNull()
        .references(() => orderItems.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_fulfillment_lines_fulfillment_item_unique").on(table.fulfillmentId, table.orderItemId),
    index("order_fulfillment_lines_order_item_idx").on(table.orderItemId),
    index("order_fulfillment_lines_order_idx").on(table.orderId),
    check("order_fulfillment_lines_quantity_positive", sql`${table.quantity} > 0`),
    // Triggers: order_fulfillment_lines_match_insert (same order, active
    // fulfilment, kind = line type), order_fulfillment_lines_bounds_insert (no
    // over-fulfilment), order_fulfillment_lines_project_insert, and
    // update/delete blocks.
]);

export type OrderFulfillment = InferSelectModel<typeof orderFulfillments>;
export type OrderFulfillmentLine = InferSelectModel<typeof orderFulfillmentLines>;
