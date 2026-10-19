-- Bulk runs (AGENT-TOOLING-SPEC D3): one row per reviewed bulk change of
-- variant prices, variant stock, customer tags, product status or product
-- publishing, started through /api/v1/admin/resources. Bounded to these five
-- kinds; the input is that kind's validated request. A run walks its
-- selection in id order, and each chunk's writes commit in one batch with the
-- run's cursor and chunk counter, so a crash between chunks repeats nothing.
-- Private operational state: no public read touches it.
CREATE TABLE "bulk_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"operation_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"input" text NOT NULL,
	"cursor" text,
	"chunks" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"processed" bigint DEFAULT 0 NOT NULL,
	"changed" bigint DEFAULT 0 NOT NULL,
	"failed" bigint DEFAULT 0 NOT NULL,
	"results" text DEFAULT '{"sample":[],"failures":[]}' NOT NULL,
	"error_code" text,
	"created_by" text,
	"lease_until" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "bulk_runs_kind_check" CHECK("bulk_runs"."kind" IN ('variants.set_prices', 'variants.set_stock', 'customers.tag', 'products.set_status', 'products.publish')),
	CONSTRAINT "bulk_runs_status_check" CHECK("bulk_runs"."status" IN ('running', 'done', 'failed')),
	CONSTRAINT "bulk_runs_input_json" CHECK(json_valid("bulk_runs"."input") AND length("bulk_runs"."input") <= 262144),
	CONSTRAINT "bulk_runs_results_json" CHECK(json_valid("bulk_runs"."results") AND length("bulk_runs"."results") <= 65536),
	CONSTRAINT "bulk_runs_counts" CHECK("bulk_runs"."chunks" >= 0 AND "bulk_runs"."total" >= 0 AND "bulk_runs"."processed" >= 0 AND "bulk_runs"."changed" >= 0 AND "bulk_runs"."failed" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_runs_operation_key_unique" ON "bulk_runs" ("operation_key");
--> statement-breakpoint
CREATE INDEX "bulk_runs_status_created_idx" ON "bulk_runs" ("status","created_at");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (159, '0159_bulk_runs', '3a97ca33ddea6ab59b273aaeb03d3337bc6a23fb455f8684adb6922d0cc87f78');
