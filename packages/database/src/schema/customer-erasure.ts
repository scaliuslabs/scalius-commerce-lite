// Customer erasure's work outside the database (migration 0186): one row a
// buyer file to delete from storage (`delete_file`, `ref` = its R2 key: a
// conversation image, or since migration 0201 a buyer upload) and
// one a saved payment method to detach at its provider
// (`detach_payment_method`, `ref` = the provider's method reference). The
// erasure batch writes them with the scrub it guards, so a refused erasure
// writes none and a committed one cannot lose them; the saved-method rows it
// deletes leave their provider reference only here. Drained right after the
// response and by the minute cron (`drainCustomerErasureTasks`); a row is
// deleted once its effect is done, so a customer's rows are what is left.
// `next_attempt_at` is both the backoff and the claim lease; `last_error` is
// a short code, never provider text.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { UNIX_NOW } from "./shared";

export const CUSTOMER_ERASURE_TASK_KINDS = ["delete_file", "detach_payment_method"] as const;
export type CustomerErasureTaskKind = (typeof CUSTOMER_ERASURE_TASK_KINDS)[number];

// Columns in the table's order: the erasure batch fills it with INSERT … SELECT, which names none.
export const customerErasureTasks = sqliteTable("customer_erasure_tasks", {
    /** `file:<attachment id>`, `upload:<buyer upload id>` or `method:<saved method id>`: a repeat enqueue is a no-op. */
    id: text("id").primaryKey(),
    /** The erased customer (no foreign key: the work outlives any later change to the record). */
    customerId: text("customer_id").notNull(),
    kind: text("kind", { enum: CUSTOMER_ERASURE_TASK_KINDS }).notNull(),
    /** detach_payment_method: the qualified gateway id. */
    providerId: text("provider_id"),
    /** delete_file: the R2 key; detach_payment_method: the provider's opaque reference. */
    ref: text("ref").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("customer_erasure_tasks_due_idx").on(table.nextAttemptAt),
    index("customer_erasure_tasks_customer_idx").on(table.customerId),
    check("customer_erasure_tasks_kind_check", sql`${table.kind} IN ('delete_file', 'detach_payment_method')`),
    check(
        "customer_erasure_tasks_shape",
        sql`(${table.kind} = 'delete_file' AND ${table.providerId} IS NULL AND (substr(${table.ref}, 1, 22) = 'private/conversations/' OR substr(${table.ref}, 1, 22) = 'private/buyer-uploads/')) OR (${table.kind} = 'detach_payment_method' AND ${table.providerId} IS NOT NULL AND length(${table.ref}) >= 1)`,
    ),
    check("customer_erasure_tasks_attempts_check", sql`${table.attempts} >= 0`),
    check("customer_erasure_tasks_last_error_length", sql`${table.lastError} IS NULL OR length(${table.lastError}) BETWEEN 1 AND 64`),
]);
