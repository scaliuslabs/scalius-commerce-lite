// src/db/schema/delivery.ts
// Delivery domain tables: deliveryLocations, deliveryProviders, deliveryShipments.

import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders } from "./orders";
import { ShipmentStatus } from "./enums";

export const deliveryLocations = sqliteTable("delivery_locations", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type", { enum: ["city", "zone", "area"] }).notNull(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle self-referential FK requires any return type
    parentId: text("parent_id").references((): any => deliveryLocations.id, { onDelete: "set null" }),
    externalIds: text("external_ids").notNull(),
    metadata: text("metadata").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("delivery_locations_parent_id_idx").on(table.parentId),
    index("delivery_locations_type_idx").on(table.type),
]);

export const deliveryProviders = sqliteTable("delivery_providers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    credentials: text("credentials").notNull(),
    config: text("config").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("delivery_providers_type_idx").on(table.type),
]);

export const deliveryShipments = sqliteTable("delivery_shipments", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    providerId: text("provider_id").references(() => deliveryProviders.id, { onDelete: "set null" }),
    providerType: text("provider_type").notNull().default("manual"),
    externalId: text("external_id"),
    trackingId: text("tracking_id"),
    trackingUrl: text("tracking_url"),
    courierName: text("courier_name"),
    /** Plain-text shipment lifecycle/status. Common values are listed in ShipmentStatus enum. */
    status: text("status").notNull().default(ShipmentStatus.PENDING),
    rawStatus: text("raw_status"),
    note: text("note"),
    metadata: text("metadata"),
    lastChecked: integer("last_checked", { mode: "timestamp" }),
    shipmentItems: text("shipment_items"),
    shipmentAmount: real("shipment_amount"),
    isFinalShipment: integer("is_final_shipment", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("delivery_shipments_provider_status_idx").on(table.providerId, table.status),
    index("delivery_shipments_order_id_idx").on(table.orderId),
    index("delivery_shipments_external_id_idx").on(table.externalId),
]);

export type DeliveryLocation = InferSelectModel<typeof deliveryLocations>;
/** Row type for the delivery_providers table (the const enum is DeliveryProvider from enums.ts) */
export type DeliveryProviderRecord = InferSelectModel<typeof deliveryProviders>;
export type DeliveryShipment = InferSelectModel<typeof deliveryShipments>;
