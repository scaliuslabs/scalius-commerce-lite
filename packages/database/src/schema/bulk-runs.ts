// Bulk runs (migration 0159): one row per reviewed bulk change an agent, app
// or staff member started through /api/v1/admin/resources (variant prices,
// variant stock, customer tags, product status, product publishing). Bounded
// to these five kinds: the input is that kind's validated request, never an
// arbitrary job payload. Every run walks its selection in id order one chunk
// at a time; each chunk's writes and the run's cursor commit in one batch, so
// a crash between chunks repeats nothing and loses nothing. Runs of at most
// 250 items finish inside their request; larger ones are drained right after
// the response and by the minute cron (apps/api/src/bulk-runs).
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { UNIX_NOW } from "./shared";

export const BULK_RUN_KINDS = [
    "variants.set_prices",
    "variants.set_stock",
    "customers.tag",
    "products.set_status",
    "products.publish",
] as const;
export type BulkRunKind = (typeof BULK_RUN_KINDS)[number];

/** `running` is due (the drain continues it); `done` and `failed` are final. */
export const BULK_RUN_STATUSES = ["running", "done", "failed"] as const;
export type BulkRunStatus = (typeof BULK_RUN_STATUSES)[number];

export const bulkRuns = sqliteTable("bulk_runs", {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: BULK_RUN_KINDS }).notNull(),
    status: text("status", { enum: BULK_RUN_STATUSES }).notNull().default("running"),
    /** The caller-scoped Idempotency-Key (or a fresh key): one run per key. */
    operationKey: text("operation_key").notNull(),
    requestHash: text("request_hash").notNull(),
    /** The kind's validated request (JSON, at most 256 KiB). */
    input: text("input").notNull(),
    /** The last id the run finished (its selection is walked in id order); null before the first chunk. */
    cursor: text("cursor"),
    /** Chunks committed: each chunk's batch moves it on by exactly one (its compare-and-set). */
    chunks: integer("chunks").notNull().default(0),
    /** Items the selection held when the run started. */
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    changed: integer("changed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /** `{"sample": [...], "failures": [...]}`: the first 50 changes and the first 50 refusals. */
    results: text("results").notNull().default(`{"sample":[],"failures":[]}`),
    /** Why a failed run stopped (an error code, never provider text or PII). */
    errorCode: text("error_code"),
    createdBy: text("created_by"),
    /** A drain holds the run until this time (unix seconds); null when nobody does. */
    leaseUntil: integer("lease_until"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
}, (table) => [
    uniqueIndex("bulk_runs_operation_key_unique").on(table.operationKey),
    index("bulk_runs_status_created_idx").on(table.status, table.createdAt),
    check("bulk_runs_kind_check", sql`${table.kind} IN ('variants.set_prices', 'variants.set_stock', 'customers.tag', 'products.set_status', 'products.publish')`),
    check("bulk_runs_status_check", sql`${table.status} IN ('running', 'done', 'failed')`),
    check("bulk_runs_input_json", sql`json_valid(${table.input}) AND length(${table.input}) <= 262144`),
    check("bulk_runs_results_json", sql`json_valid(${table.results}) AND length(${table.results}) <= 65536`),
    check("bulk_runs_counts", sql`${table.chunks} >= 0 AND ${table.total} >= 0 AND ${table.processed} >= 0 AND ${table.changed} >= 0 AND ${table.failed} >= 0`),
]);
