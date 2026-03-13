// src/db/schema/delivery.ts
// Delivery domain tables: deliveryLocations, deliveryProviders, deliveryShipments.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { orders } from "./orders";

export const deliveryLocations = sqliteTable("delivery_locations", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type", { enum: ["city", "zone", "area"] }).notNull(),
    parentId: text("parent_id"),
    externalIds: text("external_ids").notNull(),
    metadata: text("metadata").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const deliveryProviders = sqliteTable("delivery_providers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    credentials: text("credentials").notNull(),
    config: text("config").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
});

export const deliveryShipments = sqliteTable("delivery_shipments", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    providerId: text("provider_id").references(() => deliveryProviders.id),
    providerType: text("provider_type").notNull().default("manual"),
    externalId: text("external_id"),
    trackingId: text("tracking_id"),
    trackingUrl: text("tracking_url"),
    courierName: text("courier_name"),
    status: text("status").notNull().default("pending"),
    rawStatus: text("raw_status"),
    note: text("note"),
    metadata: text("metadata"),
    lastChecked: integer("last_checked", { mode: "timestamp" }),
    shipmentItems: text("shipment_items"),
    shipmentAmount: real("shipment_amount"),
    isFinalShipment: integer("is_final_shipment", { mode: "boolean" }).default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
});

export type DeliveryLocation = InferSelectModel<typeof deliveryLocations>;
/** Row type for the delivery_providers table (the const enum is DeliveryProvider from enums.ts) */
export type DeliveryProviderRecord = InferSelectModel<typeof deliveryProviders>;
export type DeliveryShipment = InferSelectModel<typeof deliveryShipments>;
