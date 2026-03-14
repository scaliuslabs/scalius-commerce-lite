// src/db/schema/customers.ts
// Customer domain tables: customers, customerHistory.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";

export const customers = sqliteTable("customers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone").notNull().unique("customer_phone_unique"),
    address: text("address"),
    city: text("city"),
    zone: text("zone"),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    totalOrders: integer("total_orders").notNull().default(0),
    totalSpent: real("total_spent").notNull().default(0),
    lastOrderAt: integer("last_order_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("customers_email_idx").on(table.email),
]);

export const customerHistory = sqliteTable("customer_history", {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone").notNull(),
    address: text("address"),
    city: text("city"),
    zone: text("zone"),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    changeType: text("change_type", { enum: ["created", "updated", "deleted"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
    index("customer_history_customer_id_idx").on(table.customerId),
]);

export type Customer = InferSelectModel<typeof customers>;
export type CustomerHistory = InferSelectModel<typeof customerHistory>;
