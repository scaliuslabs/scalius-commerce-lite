// src/db/schema/customers.ts
// Customer domain tables: customers, customerAddresses (the address book),
// customerHistory, customerAuthOtpChallenges, authOtpDeliveryReceipts,
// customerSessions.

import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql, type InferSelectModel } from "drizzle-orm";
import { UNIX_NOW, contactPhone } from "./shared";

export const customers = sqliteTable("customers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    /**
     * The contact the buyer gave; a claim until proven by code. Only a proven
     * phone is unique (one account per verified phone), plus one guest record
     * per phone for the merchant's CRM. Typed phones never block anyone.
     * '' (`NO_PHONE` in @scalius/shared/customer-auth-policy) is a contact
     * without a phone (a digital or service order, migration 0117): its guest
     * record is keyed by email instead, and it is read back as null.
     */
    phone: contactPhone("phone").notNull(),
    // Addresses live in the address book (`customer_addresses`, migration 0113).
    accountClaimedAt: integer("account_claimed_at", { mode: "timestamp" }),
    phoneVerifiedAt: integer("phone_verified_at", { mode: "timestamp" }),
    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp" }),
    lastAuthenticatedAt: integer("last_authenticated_at", { mode: "timestamp" }),
    totalOrders: integer("total_orders").notNull().default(0),
    lastOrderAt: integer("last_order_at", { mode: "timestamp" }),
    /**
     * Who made this record: "order" (checkout or a dashboard order filed by
     * phone, so it can hold different people's orders and is titled by its
     * phone), "merchant" (created or named in the dashboard), or "account"
     * (a buyer who signed up by code).
     */
    origin: text("origin", { enum: ["order", "merchant", "account"] }).notNull().default("order"),
    /**
     * Set when every order on a guest record joined an account that proved
     * their contact: the record is retired (deleted_at) and merged, so lists
     * and trash hide it and its page points at the account.
     */
    mergedIntoCustomerId: text("merged_into_customer_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("customers_email_idx").on(table.email),
    index("customers_merged_into_idx").on(table.mergedIntoCustomerId),
    index("customers_phone_idx").on(table.phone),
    uniqueIndex("customers_verified_phone_unique")
        .on(table.phone)
        .where(sql`${table.phoneVerifiedAt} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("customers_verified_email_unique")
        .on(sql`lower(${table.email})`)
        .where(sql`${table.emailVerifiedAt} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("customers_guest_phone_unique")
        .on(table.phone)
        .where(sql`${table.accountClaimedAt} IS NULL AND ${table.deletedAt} IS NULL AND ${table.phone} <> ''`),
    // A guest record without a phone (NO_PHONE) is keyed by its email, as Shopify keys guests.
    uniqueIndex("customers_guest_email_unique")
        .on(sql`lower(${table.email})`)
        .where(sql`${table.phone} = '' AND ${table.accountClaimedAt} IS NULL AND ${table.deletedAt} IS NULL`),
    index("customers_dashboard_activity_idx").on(table.deletedAt, table.createdAt),
]);

/** Every address-book id starts with it (`caddr_<nanoid>`). */
export const CUSTOMER_ADDRESS_ID_PREFIX = "caddr_";

/**
 * The id of a record's first address when it is written with the record (a
 * new customer's address, an order's seed, the 0113 move): no
 * `customer.updated` is announced for it, as `customer.created` carries it.
 */
export function firstCustomerAddressId(customerId: string): string {
  return `${CUSTOMER_ADDRESS_ID_PREFIX}${customerId}`;
}

/**
 * The address book (Shopify's customer addresses; MARKETS-DESIGN D7, migration
 * 0113): canonical fields validated by the country's rules, and Bangladesh's
 * City/Thana/Area adapter (delivery location ids and names) beside them. At
 * most one address per customer is the default (a partial unique index).
 *
 * `name` and `phone_e164` are the recipient when it is not the customer
 * (null means the customer's own name and phone). `phone_raw` keeps what was
 * typed when it could not be read as E.164 (validation skipped).
 *
 * The first delivery address of a guest record (no account) comes from its
 * first shipping order: trigger `orders_seed_customer_address` copies the
 * order's snapshot when the record has no address yet, for every order writer
 * (id `firstCustomerAddressId`).
 */
export const customerAddresses = sqliteTable("customer_addresses", {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** ISO 3166-1 alpha-2. */
    countryCode: text("country_code").notNull(),
    name: text("name"),
    company: text("company"),
    line1: text("line1"),
    line2: text("line2"),
    dependentLocality: text("dependent_locality"),
    locality: text("locality"),
    adminArea: text("admin_area"),
    postalCode: text("postal_code"),
    phoneE164: text("phone_e164"),
    phoneRaw: text("phone_raw"),
    /** Bangladesh adapter: delivery location ids (couriers book with them) and their names. */
    city: text("city"),
    zone: text("zone"),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    /** Saved by staff although it breaks its country's rules. */
    validationSkipped: integer("validation_skipped", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("customer_addresses_default_unique")
        .on(table.customerId)
        .where(sql`${table.isDefault} = 1`),
    index("customer_addresses_customer_idx").on(table.customerId, table.createdAt),
    check("customer_addresses_default_flag", sql`${table.isDefault} IN (0, 1)`),
    check("customer_addresses_validation_skipped_flag", sql`${table.validationSkipped} IN (0, 1)`),
    check(
        "customer_addresses_country_shape",
        sql`length(${table.countryCode}) = 2 AND ${table.countryCode} NOT GLOB '*[^A-Z]*'`,
    ),
    // The City/Thana/Area adapter is Bangladesh's alone.
    check(
        "customer_addresses_delivery_hierarchy_bd_only",
        sql`${table.countryCode} = 'BD' OR (${table.city} IS NULL AND ${table.zone} IS NULL AND ${table.area} IS NULL)`,
    ),
]);

export const customerHistory = sqliteTable("customer_history", {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: contactPhone("phone").notNull(),
    /**
     * signed_up: an account was created (or a guest record claimed) by a code.
     * order_linked: `orderId` was filed to this account at checkout by a verified contact.
     * order_moved_in / order_moved_out: `orderId` moved between this record and `relatedCustomerId`.
     */
    changeType: text("change_type", {
        enum: ["created", "updated", "deleted", "restored", "signed_up", "order_linked", "order_moved_in", "order_moved_out"],
    }).notNull(),
    orderId: text("order_id"),
    relatedCustomerId: text("related_customer_id"),
    /** The proven contact behind signed_up / order_linked / order_moved_*. */
    verifiedContact: text("verified_contact", { enum: ["email", "phone"] }),
    /** Who made the change: a staff member (actor_id is their user id), the buyer, or the system. */
    actor: text("actor", { enum: ["staff", "buyer", "system"] }),
    actorId: text("actor_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("customer_history_customer_created_idx").on(table.customerId, table.createdAt),
]);

export const customerAuthOtpChallenges = sqliteTable("customer_auth_otp_challenges", {
    otpKey: text("otp_key").primaryKey(),
    deliveryKey: text("delivery_key").notNull(),
    method: text("method", { enum: ["email", "phone"] }).notNull(),
    channel: text("channel", { enum: ["email", "sms", "whatsapp"] }).notNull(),
    identifierHash: text("identifier_hash").notNull(),
    identifierMasked: text("identifier_masked").notNull(),
    deliveryTargetEncrypted: text("delivery_target_encrypted"),
    deliveryNameEncrypted: text("delivery_name_encrypted"),
    codeHash: text("code_hash").notNull(),
    /** The code this challenge replaced on resend, so it can say "a newer code was sent". */
    previousCodeHash: text("previous_code_hash"),
    status: text("status", { enum: ["pending", "consumed", "locked"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    resendAvailableAt: integer("resend_available_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("customer_auth_otp_challenges_delivery_key_unique").on(table.deliveryKey),
    index("customer_auth_otp_challenges_identifier_created_idx").on(table.identifierHash, table.createdAt),
    index("customer_auth_otp_challenges_status_expires_idx").on(table.status, table.expiresAt),
]);

export const customerSessions = sqliteTable("customer_sessions", {
    tokenHash: text("token_hash").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("customer_sessions_customer_id_idx").on(table.customerId),
    index("customer_sessions_active_expiry_idx").on(table.revokedAt, table.expiresAt),
]);

export const customerAuthOtpRateLimits = sqliteTable("customer_auth_otp_rate_limits", {
    key: text("key").primaryKey(),
    scope: text("scope", { enum: ["ip", "identifier"] }).notNull().default("ip"),
    attempts: integer("attempts").notNull().default(0),
    windowExpiresAt: integer("window_expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("customer_auth_otp_rate_limits_window_idx").on(table.windowExpiresAt),
]);

export const authOtpDeliveryReceipts = sqliteTable("auth_otp_delivery_receipts", {
    id: text("id").primaryKey(),
    deliveryKey: text("delivery_key").notNull(),
    purpose: text("purpose").notNull().default("customer_login"),
    method: text("method").notNull(),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    identifierHash: text("identifier_hash").notNull(),
    identifierMasked: text("identifier_masked"),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    providerStatus: text("provider_status"),
    rawResponse: text("raw_response"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    lastAttemptAt: integer("last_attempt_at"),
    acceptedAt: integer("accepted_at"),
    deliveredAt: integer("delivered_at"),
    failedAt: integer("failed_at"),
    skippedAt: integer("skipped_at"),
    otpExpiresAt: integer("otp_expires_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("auth_otp_delivery_receipts_delivery_key_unique").on(table.deliveryKey),
    index("auth_otp_delivery_receipts_identifier_created_idx").on(table.identifierHash, table.createdAt),
    index("auth_otp_delivery_receipts_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("auth_otp_delivery_receipts_claim_idx").on(table.status, table.claimExpiresAt, table.createdAt),
    index("auth_otp_delivery_receipts_provider_message_idx").on(table.provider, table.providerMessageId),
]);

export type Customer = InferSelectModel<typeof customers>;
export type CustomerAddressRow = InferSelectModel<typeof customerAddresses>;
export type CustomerHistory = InferSelectModel<typeof customerHistory>;
export type CustomerAuthOtpChallenge = InferSelectModel<typeof customerAuthOtpChallenges>;
export type CustomerSessionRow = InferSelectModel<typeof customerSessions>;
export type CustomerAuthOtpRateLimit = InferSelectModel<typeof customerAuthOtpRateLimits>;
export type AuthOtpDeliveryReceipt = InferSelectModel<typeof authOtpDeliveryReceipts>;
