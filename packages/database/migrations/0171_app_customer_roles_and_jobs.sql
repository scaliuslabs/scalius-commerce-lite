-- Apps hold customer roles and run background jobs.
--
-- 1. plugin_customer_roles: a role an app names (seller, wholesale) on a
--    customer, with an optional reference to the app's own record. Each app
--    reads and writes only its own rows; a customer's hard delete removes
--    them. Private state: no public read touches it.
-- 2. bulk_runs takes app jobs (kind 'app.job'): an app's long admin action
--    rides the bulk-run lease and drain (right after the response and the
--    minute cron). The table is rebuilt for the wider kind check.
CREATE TABLE `plugin_customer_roles` (
	`plugin_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`role` text NOT NULL,
	`ref` text,
	`granted_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`plugin_id`, `customer_id`, `role`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plugin_customer_roles_plugin_shape" CHECK(length("plugin_customer_roles"."plugin_id") BETWEEN 3 AND 100 AND "plugin_customer_roles"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("plugin_customer_roles"."plugin_id", '.') > 1 AND instr("plugin_customer_roles"."plugin_id", '.') < length("plugin_customer_roles"."plugin_id")),
	CONSTRAINT "plugin_customer_roles_role_shape" CHECK(length("plugin_customer_roles"."role") BETWEEN 1 AND 32 AND substr("plugin_customer_roles"."role", 1, 1) BETWEEN 'a' AND 'z' AND "plugin_customer_roles"."role" NOT GLOB '*[^a-z0-9_-]*'),
	CONSTRAINT "plugin_customer_roles_ref_shape" CHECK("plugin_customer_roles"."ref" IS NULL OR (length("plugin_customer_roles"."ref") BETWEEN 1 AND 128 AND "plugin_customer_roles"."ref" NOT GLOB '*[^ -~]*'))
);
--> statement-breakpoint
CREATE INDEX `plugin_customer_roles_customer_idx` ON `plugin_customer_roles` (`customer_id`);
--> statement-breakpoint
CREATE INDEX `plugin_customer_roles_role_idx` ON `plugin_customer_roles` (`plugin_id`,`role`,`customer_id`);
--> statement-breakpoint
CREATE TABLE `__new_bulk_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`input` text NOT NULL,
	`cursor` text,
	`chunks` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`changed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`results` text DEFAULT '{"sample":[],"failures":[]}' NOT NULL,
	`error_code` text,
	`created_by` text,
	`lease_until` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`finished_at` integer,
	CONSTRAINT "bulk_runs_kind_check" CHECK("__new_bulk_runs"."kind" IN ('variants.set_prices', 'variants.set_stock', 'customers.tag', 'products.set_status', 'products.publish', 'app.job')),
	CONSTRAINT "bulk_runs_status_check" CHECK("__new_bulk_runs"."status" IN ('running', 'done', 'failed')),
	CONSTRAINT "bulk_runs_input_json" CHECK(json_valid("__new_bulk_runs"."input") AND length("__new_bulk_runs"."input") <= 262144),
	CONSTRAINT "bulk_runs_results_json" CHECK(json_valid("__new_bulk_runs"."results") AND length("__new_bulk_runs"."results") <= 65536),
	CONSTRAINT "bulk_runs_counts" CHECK("__new_bulk_runs"."chunks" >= 0 AND "__new_bulk_runs"."total" >= 0 AND "__new_bulk_runs"."processed" >= 0 AND "__new_bulk_runs"."changed" >= 0 AND "__new_bulk_runs"."failed" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_bulk_runs`("id", "kind", "status", "operation_key", "request_hash", "input", "cursor", "chunks", "total", "processed", "changed", "failed", "results", "error_code", "created_by", "lease_until", "created_at", "updated_at", "finished_at") SELECT "id", "kind", "status", "operation_key", "request_hash", "input", "cursor", "chunks", "total", "processed", "changed", "failed", "results", "error_code", "created_by", "lease_until", "created_at", "updated_at", "finished_at" FROM `bulk_runs`;
--> statement-breakpoint
DROP TABLE `bulk_runs`;
--> statement-breakpoint
ALTER TABLE `__new_bulk_runs` RENAME TO `bulk_runs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_runs_operation_key_unique` ON `bulk_runs` (`operation_key`);
--> statement-breakpoint
CREATE INDEX `bulk_runs_status_created_idx` ON `bulk_runs` (`status`,`created_at`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (171, '0171_app_customer_roles_and_jobs', 'a2736d0c89081497f17bd00e6ad36d38f5c181b97754a4870ad6ac119776b3f6');
