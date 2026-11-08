-- The merchant's order of apps at each checkout function point
-- (plugin_installations.function_ranks, `{ "<point>": <rank> }`, lower
-- first; a point without a rank keeps the manifest priority, after the ranked
-- apps) and whether a sandboxed run's in-flight mark shared its request with
-- other runs (plugin_registrations.circuit_inflight_shared: a stale shared
-- mark makes the app a suspect that runs alone, a stale mark of a run alone
-- stops the app). Expand-only: both columns are added in place.
ALTER TABLE `plugin_installations` ADD `function_ranks` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `circuit_inflight_shared` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (200, '0200_function_order', '42ba9ffdb3c6030b831d840c9d2fd30284ddf84e1c8e467b3c2220754aa6cb59');
