// Buyer sign-in through an app identity provider (docs/platform/PLUGINS.md,
// "Identity"): the provider's stable subject for a customer, so a returning
// buyer signs in to the same account. A first sign-in links by the
// provider-verified email; later ones by the subject alone. Private.

import { sqliteTable, text, integer, index, primaryKey, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { customers } from "./customers";

export const customerIdentities = sqliteTable("customer_identities", {
    /** The app provider id (`<plugin id>:<provider id>`). */
    providerId: text("provider_id").notNull(),
    /** The provider's stable id of the person. */
    subject: text("subject").notNull(),
    customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    lastUsedAt: integer("last_used_at"),
}, (table) => [
    primaryKey({ columns: [table.providerId, table.subject] }),
    check("customer_identities_provider_shape", sql`length(${table.providerId}) BETWEEN 3 AND 150 AND instr(${table.providerId}, ':') > 1`),
    check("customer_identities_subject_length", sql`length(${table.subject}) BETWEEN 1 AND 255`),
    index("customer_identities_customer_idx").on(table.customerId),
]);

export type CustomerIdentityRow = InferSelectModel<typeof customerIdentities>;
