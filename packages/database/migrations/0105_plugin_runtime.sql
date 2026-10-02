-- Plugin platform runtime (docs/platform/PLUGINS.md, P1): installations with
-- their approved grant and sealed settings, extension-point registrations
-- derived from the manifest, declared storage collections (generic hex-encoded
-- index columns, per-collection unique indexes), a database key/value store and
-- a bounded log ring per plugin. Plugin principals that call /api/v1
-- operations are audited in agent_audit_events under plugin_id.
CREATE TABLE `plugin_installations` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`source` text NOT NULL,
	`bundle_sha256` text NOT NULL,
	`manifest_json` text NOT NULL,
	`grant_json` text,
	`grant_key` text,
	`status` text DEFAULT 'installed' NOT NULL,
	`failure_reason` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`installed_by` text,
	`activated_by` text,
	`installed_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`activated_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`installed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`activated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "plugin_installations_id_shape" CHECK(length("plugin_installations"."plugin_id") BETWEEN 3 AND 100 AND "plugin_installations"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("plugin_installations"."plugin_id", '.') > 1 AND instr("plugin_installations"."plugin_id", '.') < length("plugin_installations"."plugin_id")),
	CONSTRAINT "plugin_installations_version_length" CHECK(length("plugin_installations"."version") BETWEEN 5 AND 80),
	CONSTRAINT "plugin_installations_source_check" CHECK("plugin_installations"."source" IN ('bundled', 'registry', 'upload')),
	CONSTRAINT "plugin_installations_sha256_shape" CHECK(length("plugin_installations"."bundle_sha256") = 64 AND "plugin_installations"."bundle_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "plugin_installations_manifest_json" CHECK(json_valid("plugin_installations"."manifest_json") AND json_type("plugin_installations"."manifest_json") = 'object' AND length("plugin_installations"."manifest_json") <= 262144),
	CONSTRAINT "plugin_installations_grant_json" CHECK("plugin_installations"."grant_json" IS NULL OR (json_valid("plugin_installations"."grant_json") AND json_type("plugin_installations"."grant_json") = 'object' AND length("plugin_installations"."grant_json") <= 65536)),
	CONSTRAINT "plugin_installations_grant_pair" CHECK(("plugin_installations"."grant_json" IS NULL) = ("plugin_installations"."grant_key" IS NULL)),
	CONSTRAINT "plugin_installations_status_check" CHECK("plugin_installations"."status" IN ('installed', 'active', 'disabled', 'failed')),
	CONSTRAINT "plugin_installations_active_granted" CHECK("plugin_installations"."status" <> 'active' OR "plugin_installations"."grant_json" IS NOT NULL),
	CONSTRAINT "plugin_installations_failure_reason" CHECK("plugin_installations"."failure_reason" IS NULL OR length("plugin_installations"."failure_reason") BETWEEN 1 AND 500),
	CONSTRAINT "plugin_installations_settings_json" CHECK(json_valid("plugin_installations"."settings_json") AND json_type("plugin_installations"."settings_json") = 'object' AND length("plugin_installations"."settings_json") <= 131072),
	CONSTRAINT "plugin_installations_revision_positive" CHECK("plugin_installations"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `plugin_installations_status_idx` ON `plugin_installations` (`status`,`plugin_id`);
--> statement-breakpoint
CREATE TABLE `plugin_kv` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`expires_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`),
	CONSTRAINT "plugin_kv_plugin_id_shape" CHECK(length("plugin_kv"."plugin_id") BETWEEN 3 AND 100 AND "plugin_kv"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("plugin_kv"."plugin_id", '.') > 1 AND instr("plugin_kv"."plugin_id", '.') < length("plugin_kv"."plugin_id")),
	CONSTRAINT "plugin_kv_key_length" CHECK(length("plugin_kv"."key") BETWEEN 1 AND 256),
	CONSTRAINT "plugin_kv_value_json" CHECK(json_valid("plugin_kv"."value_json") AND length("plugin_kv"."value_json") <= 65536),
	CONSTRAINT "plugin_kv_expires_positive" CHECK("plugin_kv"."expires_at" IS NULL OR "plugin_kv"."expires_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `plugin_kv_expires_idx` ON `plugin_kv` (`plugin_id`,`expires_at`) WHERE "plugin_kv"."expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `plugin_log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`fields_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "plugin_log_entries_id_shape" CHECK(length("plugin_log_entries"."id") = 29 AND substr("plugin_log_entries"."id", 1, 4) = 'plg_'),
	CONSTRAINT "plugin_log_entries_plugin_id_shape" CHECK(length("plugin_log_entries"."plugin_id") BETWEEN 3 AND 100 AND "plugin_log_entries"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("plugin_log_entries"."plugin_id", '.') > 1 AND instr("plugin_log_entries"."plugin_id", '.') < length("plugin_log_entries"."plugin_id")),
	CONSTRAINT "plugin_log_entries_level_check" CHECK("plugin_log_entries"."level" IN ('debug', 'info', 'warn', 'error')),
	CONSTRAINT "plugin_log_entries_source_length" CHECK(length("plugin_log_entries"."source") BETWEEN 1 AND 80),
	CONSTRAINT "plugin_log_entries_message_length" CHECK(length("plugin_log_entries"."message") BETWEEN 1 AND 500),
	CONSTRAINT "plugin_log_entries_fields_json" CHECK(json_valid("plugin_log_entries"."fields_json") AND json_type("plugin_log_entries"."fields_json") = 'object' AND length("plugin_log_entries"."fields_json") <= 4096)
);
--> statement-breakpoint
CREATE INDEX `plugin_log_entries_plugin_idx` ON `plugin_log_entries` (`plugin_id`,`id`);
--> statement-breakpoint
CREATE TABLE `plugin_records` (
	`plugin_id` text NOT NULL,
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`data_json` text NOT NULL,
	`idx1` text,
	`idx2` text,
	`idx3` text,
	`idx4` text,
	`uq1` text,
	`uq2` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`plugin_id`, `collection`, `id`),
	CONSTRAINT "plugin_records_plugin_id_shape" CHECK(length("plugin_records"."plugin_id") BETWEEN 3 AND 100 AND "plugin_records"."plugin_id" NOT GLOB '*[^a-z0-9.-]*' AND instr("plugin_records"."plugin_id", '.') > 1 AND instr("plugin_records"."plugin_id", '.') < length("plugin_records"."plugin_id")),
	CONSTRAINT "plugin_records_collection_shape" CHECK(length("plugin_records"."collection") BETWEEN 1 AND 48 AND "plugin_records"."collection" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "plugin_records_id_length" CHECK(length("plugin_records"."id") BETWEEN 1 AND 128),
	CONSTRAINT "plugin_records_data_json" CHECK(json_valid("plugin_records"."data_json") AND json_type("plugin_records"."data_json") = 'object' AND length("plugin_records"."data_json") <= 65536),
	CONSTRAINT "plugin_records_idx1_hex" CHECK("plugin_records"."idx1" IS NULL OR (length("plugin_records"."idx1") BETWEEN 2 AND 2048 AND "plugin_records"."idx1" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "plugin_records_idx2_hex" CHECK("plugin_records"."idx2" IS NULL OR (length("plugin_records"."idx2") BETWEEN 2 AND 2048 AND "plugin_records"."idx2" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "plugin_records_idx3_hex" CHECK("plugin_records"."idx3" IS NULL OR (length("plugin_records"."idx3") BETWEEN 2 AND 2048 AND "plugin_records"."idx3" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "plugin_records_idx4_hex" CHECK("plugin_records"."idx4" IS NULL OR (length("plugin_records"."idx4") BETWEEN 2 AND 2048 AND "plugin_records"."idx4" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "plugin_records_uq1_hex" CHECK("plugin_records"."uq1" IS NULL OR (length("plugin_records"."uq1") BETWEEN 2 AND 2048 AND "plugin_records"."uq1" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "plugin_records_uq2_hex" CHECK("plugin_records"."uq2" IS NULL OR (length("plugin_records"."uq2") BETWEEN 2 AND 2048 AND "plugin_records"."uq2" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE INDEX `plugin_records_idx1` ON `plugin_records` (`plugin_id`,`collection`,`idx1`,`id`);
--> statement-breakpoint
CREATE INDEX `plugin_records_idx2` ON `plugin_records` (`plugin_id`,`collection`,`idx2`,`id`);
--> statement-breakpoint
CREATE INDEX `plugin_records_idx3` ON `plugin_records` (`plugin_id`,`collection`,`idx3`,`id`);
--> statement-breakpoint
CREATE INDEX `plugin_records_idx4` ON `plugin_records` (`plugin_id`,`collection`,`idx4`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_records_uq1` ON `plugin_records` (`plugin_id`,`collection`,`uq1`) WHERE "plugin_records"."uq1" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_records_uq2` ON `plugin_records` (`plugin_id`,`collection`,`uq2`) WHERE "plugin_records"."uq2" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `plugin_registrations` (
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`plugin_id` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	PRIMARY KEY(`kind`, `name`, `plugin_id`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin_installations`(`plugin_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plugin_registrations_kind_check" CHECK("plugin_registrations"."kind" IN ('event', 'function', 'cron')),
	CONSTRAINT "plugin_registrations_name_length" CHECK(length("plugin_registrations"."name") BETWEEN 1 AND 64),
	CONSTRAINT "plugin_registrations_priority_range" CHECK("plugin_registrations"."priority" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
CREATE INDEX `plugin_registrations_plugin_idx` ON `plugin_registrations` (`plugin_id`);
--> statement-breakpoint
ALTER TABLE `agent_audit_events` ADD `plugin_id` text;
--> statement-breakpoint
CREATE INDEX `agent_audit_events_plugin_created_idx` ON `agent_audit_events` (`plugin_id`,`created_at`) WHERE "agent_audit_events"."plugin_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (105, '0105_plugin_runtime', '779873f178ae9054a4f80c99ec75a6d0e38ae9e77e95ec7b07dd924c85397033');
