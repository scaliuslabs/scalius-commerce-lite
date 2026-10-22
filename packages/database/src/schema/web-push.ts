// Web Push subscriptions (packages/plugin-sdk/docs/apps.md, "Push"): browsers that
// asked for notifications, for staff (the dashboard) and signed-in buyers
// (the storefront). The platform sends with VAPID (RFC 8292) using a key
// pair derived from SCALIUS_SECRET, so no push service account and no new
// secret. A push service answering 404 or 410 deletes its subscription.
// Private: never read by a public page.

import { sqliteTable, text, integer, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { user } from "./auth";
import { customers } from "./customers";

export const PUSH_AUDIENCES = ["staff", "customer"] as const;
export type PushAudience = (typeof PUSH_AUDIENCES)[number];

export const pushSubscriptions = sqliteTable("push_subscriptions", {
    id: text("id").primaryKey(),
    audience: text("audience", { enum: PUSH_AUDIENCES }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    /** The push service URL the browser gave (a known push service host only). */
    endpoint: text("endpoint").notNull().unique(),
    /** The browser's P-256 public key and auth secret (base64url), RFC 8291. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** A short device label (browser and platform), for the staff member's own list. */
    deviceLabel: text("device_label"),
    failureCount: integer("failure_count").notNull().default(0),
    lastSuccessAt: integer("last_success_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    check("push_subscriptions_id_shape", sql`substr(${table.id}, 1, 4) = 'psb_' AND length(${table.id}) BETWEEN 10 AND 68`),
    check("push_subscriptions_audience_owner", sql`(${table.audience} = 'staff' AND ${table.userId} IS NOT NULL AND ${table.customerId} IS NULL) OR (${table.audience} = 'customer' AND ${table.customerId} IS NOT NULL AND ${table.userId} IS NULL)`),
    check("push_subscriptions_endpoint_https", sql`substr(${table.endpoint}, 1, 8) = 'https://' AND length(${table.endpoint}) <= 2048`),
    check("push_subscriptions_key_lengths", sql`length(${table.p256dh}) BETWEEN 80 AND 100 AND length(${table.auth}) BETWEEN 16 AND 32`),
    check("push_subscriptions_device_label_length", sql`${table.deviceLabel} IS NULL OR length(${table.deviceLabel}) <= 120`),
    check("push_subscriptions_failure_count", sql`${table.failureCount} >= 0`),
    index("push_subscriptions_staff_idx").on(table.audience, table.userId),
    index("push_subscriptions_customer_idx").on(table.customerId),
]);

export type PushSubscriptionRow = InferSelectModel<typeof pushSubscriptions>;
