-- The merchant's order of apps at each function point and the shared in-flight mark: see ../0200_function_order.sql.
ALTER TABLE "plugin_installations" ADD COLUMN "function_ranks" text COLLATE "C" DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "circuit_inflight_shared" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (200, '0200_function_order', '42ba9ffdb3c6030b831d840c9d2fd30284ddf84e1c8e467b3c2220754aa6cb59');
