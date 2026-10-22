-- The app lifecycle and safety layer (docs/platform/PLUGINS.md, "Registry",
-- "Quotas", "Data updates"). `plugin_migrations` records each data update an
-- app ran (one row per version, kept with its data on a keep-data uninstall).
-- The new `plugin_installations` columns are added in place, without a table
-- rebuild, so the generated cache dependency triggers stay: the newest data
-- update that ran, the key that verified the bundle, the measured storage and
-- the limit-breach window. None of them is buyer-visible, so none advances a
-- cache dependency (cache-deps.ts lists them as noise).
CREATE TABLE `plugin_migrations` (
	`plugin_id` text NOT NULL,
	`version` integer NOT NULL,
	`plugin_version` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`applied_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`plugin_id`, `version`),
	CONSTRAINT "plugin_migrations_plugin_id_shape" CHECK(length("plugin_migrations"."plugin_id") BETWEEN 3 AND 100 AND "plugin_migrations"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("plugin_migrations"."plugin_id", '.') > 1 AND instr("plugin_migrations"."plugin_id", '.') < length("plugin_migrations"."plugin_id")),
	CONSTRAINT "plugin_migrations_version_range" CHECK("plugin_migrations"."version" BETWEEN 1 AND 10000),
	CONSTRAINT "plugin_migrations_plugin_version_length" CHECK(length("plugin_migrations"."plugin_version") BETWEEN 5 AND 80),
	CONSTRAINT "plugin_migrations_duration" CHECK("plugin_migrations"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE `plugin_installations` ADD `migrated_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_installations` ADD `signer_key_id` text;
--> statement-breakpoint
ALTER TABLE `plugin_installations` ADD `storage_bytes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_installations` ADD `storage_measured_at` integer;
--> statement-breakpoint
ALTER TABLE `plugin_installations` ADD `breach_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_installations` ADD `last_breach_at` integer;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (125, '0125_plugin_lifecycle', 'b7db1cf080686c02603d68663907a68b828185e461033eb2f357a00ad3fdb6d0');
