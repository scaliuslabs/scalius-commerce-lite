-- Apps hold customer roles and run background jobs.
--
-- 1. plugin_customer_roles: a role an app names (seller, wholesale) on a
--    customer, with an optional reference to the app's own record. Each app
--    reads and writes only its own rows; a customer's hard delete removes
--    them. Private state: no public read touches it.
-- 2. bulk_runs takes app jobs (kind 'app.job'): an app's long admin action
--    rides the bulk-run lease and drain (right after the response and the
--    minute cron). The table is rebuilt for the wider kind check.
CREATE TABLE "plugin_customer_roles" (
	"plugin_id" text COLLATE "C" NOT NULL,
	"customer_id" text COLLATE "C" NOT NULL,
	"role" text COLLATE "C" NOT NULL,
	"ref" text COLLATE "C",
	"granted_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("plugin_id", "customer_id", "role"),
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plugin_customer_roles_plugin_shape" CHECK(length("plugin_customer_roles"."plugin_id") BETWEEN 3 AND 100 AND "plugin_customer_roles"."plugin_id" !~ '[^a-z0-9.-]' AND strpos("plugin_customer_roles"."plugin_id", '.') > 1 AND strpos("plugin_customer_roles"."plugin_id", '.') < length("plugin_customer_roles"."plugin_id")),
	CONSTRAINT "plugin_customer_roles_role_shape" CHECK(length("plugin_customer_roles"."role") BETWEEN 1 AND 32 AND substr("plugin_customer_roles"."role", 1, 1) BETWEEN 'a' AND 'z' AND "plugin_customer_roles"."role" !~ '[^a-z0-9_-]'),
	CONSTRAINT "plugin_customer_roles_ref_shape" CHECK("plugin_customer_roles"."ref" IS NULL OR (length("plugin_customer_roles"."ref") BETWEEN 1 AND 128 AND "plugin_customer_roles"."ref" !~ '[^ -~]'))
);
--> statement-breakpoint
CREATE INDEX "plugin_customer_roles_customer_idx" ON "plugin_customer_roles" ("customer_id");
--> statement-breakpoint
CREATE INDEX "plugin_customer_roles_role_idx" ON "plugin_customer_roles" ("plugin_id","role","customer_id");
--> statement-breakpoint
ALTER TABLE "bulk_runs" DROP CONSTRAINT "bulk_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "bulk_runs" ADD CONSTRAINT "bulk_runs_kind_check" CHECK ("kind" IN ('variants.set_prices', 'variants.set_stock', 'customers.tag', 'products.set_status', 'products.publish', 'app.job'));
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (171, '0171_app_customer_roles_and_jobs', 'a2736d0c89081497f17bd00e6ad36d38f5c181b97754a4870ad6ac119776b3f6');
