// src/db/schema/delivery.ts
// Delivery domain tables: deliveryLocations, deliveryZones (+ their regions and
// Bangladesh locations), shippingMethods (a zone's delivery rates and local
// pickup), deliveryProviders, deliveryShipments.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, check } from "drizzle-orm/sqlite-core";
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
    uniqueIndex("delivery_locations_active_city_name_uidx")
        .on(sql`lower(trim(${table.name}))`)
        .where(sql`${table.deletedAt} IS NULL AND ${table.isActive} = 1 AND ${table.type} = 'city'`),
    uniqueIndex("delivery_locations_active_child_name_uidx")
        .on(table.type, table.parentId, sql`lower(trim(${table.name}))`)
        .where(sql`${table.deletedAt} IS NULL AND ${table.isActive} = 1 AND ${table.type} IN ('zone', 'area') AND ${table.parentId} IS NOT NULL`),
]);

/**
 * A shipping zone (Shopify's model, MARKETS-DESIGN step 3b): the places that
 * share delivery rates. It serves countries, admin areas and postal-code
 * prefixes (`delivery_zone_regions`) and Bangladesh delivery locations
 * (`delivery_zone_locations`). An address belongs to its most specific
 * matching zone: Bangladesh location (area, thana, city) > postal prefix >
 * admin area > country. An address no zone matches gets no delivery rate.
 * Zones serve countries, not markets.
 */
export const deliveryZones = sqliteTable("delivery_zones", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Advances on every edit; a stale edit is rejected (409). */
    revision: integer("revision").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

/**
 * The regions a zone serves: a whole country (`admin_area` and
 * `postal_prefix` empty), one admin area of it (the address rules' code), or
 * the postal codes that start with a prefix (upper case, no spaces). A
 * region belongs to at most one zone (the primary key).
 */
export const deliveryZoneRegions = sqliteTable("delivery_zone_regions", {
    /** ISO 3166-1 alpha-2, upper case. */
    countryCode: text("country_code").notNull(),
    /** The admin area code of the country's address rules; '' for none. */
    adminArea: text("admin_area").notNull().default(""),
    /** Upper-case letters and digits; '' for none. */
    postalPrefix: text("postal_prefix").notNull().default(""),
    zoneId: text("zone_id")
        .notNull()
        .references(() => deliveryZones.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.countryCode, table.adminArea, table.postalPrefix] }),
    index("delivery_zone_regions_zone_idx").on(table.zoneId),
    check("delivery_zone_regions_country_shape", sql`length(${table.countryCode}) = 2 AND ${table.countryCode} NOT GLOB '*[^A-Z]*'`),
    // A region is a whole country, an admin area or a postal prefix: never two at once.
    check("delivery_zone_regions_one_kind", sql`${table.adminArea} = '' OR ${table.postalPrefix} = ''`),
    check("delivery_zone_regions_admin_area_shape", sql`length(${table.adminArea}) <= 120 AND ${table.adminArea} = trim(${table.adminArea})`),
    check("delivery_zone_regions_postal_prefix_shape", sql`length(${table.postalPrefix}) <= 10 AND ${table.postalPrefix} NOT GLOB '*[^A-Z0-9]*'`),
]);

/** A Bangladesh location belongs to at most one zone (the primary key). */
export const deliveryZoneLocations = sqliteTable("delivery_zone_locations", {
    locationId: text("location_id")
        .primaryKey()
        .references(() => deliveryLocations.id, { onDelete: "cascade" }),
    zoneId: text("zone_id")
        .notNull()
        .references(() => deliveryZones.id, { onDelete: "cascade" }),
}, (table) => [
    index("delivery_zone_locations_zone_id_idx").on(table.zoneId),
]);

/**
 * A rate: a delivery rate of one zone, offered to buyers whose address
 * belongs to that zone, or a local pickup rate (no zone), offered to every
 * buyer. A live delivery rate always has a zone (a trigger refuses one
 * without). Removed rates are soft-deleted: orders keep referencing the rate
 * they were placed with.
 */
export const shippingMethods = sqliteTable("shipping_methods", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Integer minor units of the store currency. */
    feeMinor: integer("fee_minor").notNull().default(0),
    description: text("description"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    zoneId: text("zone_id").references(() => deliveryZones.id, { onDelete: "set null" }),
    /** Free when the items subtotal (before discounts) reaches this; minor units. */
    freeOverMinor: integer("free_over_minor"),
    pickupAddress: text("pickup_address"),
    pickupHours: text("pickup_hours"),
    /**
     * "pickup" is local pickup: store-wide (no zone), offered for every
     * address and needs a pickup address (a DB CHECK enforces both).
     */
    kind: text("kind", { enum: ["delivery", "pickup"] }).notNull().default("delivery"),
}, (table) => [
    index("shipping_methods_deleted_at_idx").on(table.deletedAt),
    index("shipping_methods_zone_id_idx").on(table.zoneId),
    uniqueIndex("shipping_methods_zone_name_uidx")
        .on(sql`coalesce(${table.zoneId}, '')`, sql`lower(trim(${table.name}))`)
        .where(sql`${table.deletedAt} IS NULL`),
]);

export const deliveryProviders = sqliteTable("delivery_providers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    credentials: text("credentials").notNull(),
    config: text("config").notNull(),
    lastTestAttemptAt: integer("last_test_attempt_at", { mode: "timestamp" }),
    lastTestSuccessAt: integer("last_test_success_at", { mode: "timestamp" }),
    lastTestFailureAt: integer("last_test_failure_at", { mode: "timestamp" }),
    lastTestSuccessFingerprint: text("last_test_success_fingerprint"),
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
    /** Amount to collect for this shipment, in minor units of the order currency. */
    shipmentAmountMinor: integer("shipment_amount_minor"),
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
export type DeliveryZone = InferSelectModel<typeof deliveryZones>;
export type DeliveryZoneRegion = InferSelectModel<typeof deliveryZoneRegions>;
export type ShippingMethod = InferSelectModel<typeof shippingMethods>;
/** Row type for the delivery_providers table (the const enum is DeliveryProvider from enums.ts) */
export type DeliveryProviderRecord = InferSelectModel<typeof deliveryProviders>;
export type DeliveryShipment = InferSelectModel<typeof deliveryShipments>;
