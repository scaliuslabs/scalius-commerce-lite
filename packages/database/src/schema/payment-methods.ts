// Saved payment methods (migration 0173): a buyer's card or wallet kept by
// its payment provider for later charges without the buyer (a subscription's
// renewals). The provider vaults the method; the store keeps only its opaque
// reference (`provider_method_ref`, never shown to apps) and the facts a
// buyer or staff member may see: brand, last four digits, expiry and a label.
// Never a card number, a CVC or a provider payload.
//
// A method is written in the batch that applies the confirmed or authorized
// payment that kept it, for the order's account customer only. One row per
// provider method (`UNIQUE(provider_id, provider_method_ref)`): a repeat
// refreshes its facts and never moves it to another customer. Removing it
// detaches it at the provider first, then marks it `removed` (kept for the
// audit of the orders it paid).
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { UNIX_NOW } from "./shared";
import { customers } from "./customers";
import { orders } from "./orders";

export const CUSTOMER_PAYMENT_METHOD_STATUSES = ["active", "removed"] as const;
export type CustomerPaymentMethodStatus = (typeof CUSTOMER_PAYMENT_METHOD_STATUSES)[number];

export const customerPaymentMethods = sqliteTable("customer_payment_methods", {
    /** `cpm_` + random. */
    id: text("id").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    /** The qualified gateway id (`<plugin id>:<provider id>`, or a built-in id). */
    providerId: text("provider_id").notNull(),
    /** The provider's reference to the kept method. Opaque; never leaves the store. */
    providerMethodRef: text("provider_method_ref").notNull(),
    brand: text("brand"),
    last4: text("last4"),
    expiryMonth: integer("expiry_month"),
    expiryYear: integer("expiry_year"),
    label: text("label"),
    status: text("status", { enum: CUSTOMER_PAYMENT_METHOD_STATUSES }).notNull().default("active"),
    /** The order whose payment kept it. */
    sourceOrderId: text("source_order_id").references(() => orders.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("customer_payment_methods_provider_ref_unique").on(table.providerId, table.providerMethodRef),
    index("customer_payment_methods_customer_idx").on(table.customerId, table.status),
    index("customer_payment_methods_source_order_idx").on(table.sourceOrderId),
    check("customer_payment_methods_status_check", sql`${table.status} IN ('active', 'removed')`),
    check(
        "customer_payment_methods_last4_check",
        sql`${table.last4} IS NULL OR (length(${table.last4}) = 4 AND ${table.last4} NOT GLOB '*[^0-9]*')`,
    ),
    check(
        "customer_payment_methods_expiry_check",
        sql`(${table.expiryMonth} IS NULL OR ${table.expiryMonth} BETWEEN 1 AND 12) AND (${table.expiryYear} IS NULL OR ${table.expiryYear} BETWEEN 2000 AND 2200)`,
    ),
]);
