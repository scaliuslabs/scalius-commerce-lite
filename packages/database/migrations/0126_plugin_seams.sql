-- The plugin seams (packages/plugin-sdk/docs/apps.md, wave 7).
--
-- metaobject_definitions and metaobject_entries: content types the merchant
-- or an app defines (namespace `custom` or the app's id) and their entries.
-- Fields reuse the custom-field types; an entry keeps one canonical text per
-- field. Published entries of a definition with storefront access are
-- public: theme sections show them, cached under `mo:<definition id>` (the
-- cache dependency triggers below are generated from
-- packages/shared/src/cache-deps.ts).
--
-- push_subscriptions: browsers that asked for Web Push, staff and signed-in
-- buyers. The platform sends with VAPID keys derived from SCALIUS_SECRET.
--
-- customer_identities: a buyer's stable subject at an app identity provider.
--
-- markets.fx_rate_source: who writes a market's rate, `manual` or an app FX
-- rate provider. Added in place (no table rebuild), so the markets triggers
-- stay; it advances no cache dependency (the rate itself does).
CREATE TABLE `metaobject_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`fields` text DEFAULT '[]' NOT NULL,
	`display_field` text,
	`storefront_access` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "metaobject_definitions_id_shape" CHECK(substr("metaobject_definitions"."id", 1, 4) = 'mod_' AND length("metaobject_definitions"."id") BETWEEN 10 AND 68 AND "metaobject_definitions"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "metaobject_definitions_namespace_shape" CHECK("metaobject_definitions"."namespace" = 'custom' OR (length("metaobject_definitions"."namespace") BETWEEN 3 AND 101 AND "metaobject_definitions"."namespace" NOT GLOB '*[^a-z0-9.-]*' AND instr("metaobject_definitions"."namespace", '.') > 1 AND instr("metaobject_definitions"."namespace", '.') < length("metaobject_definitions"."namespace"))),
	CONSTRAINT "metaobject_definitions_type_shape" CHECK(length("metaobject_definitions"."type") BETWEEN 2 AND 64 AND "metaobject_definitions"."type" NOT GLOB '*[^_a-z0-9]*' AND substr("metaobject_definitions"."type", 1, 1) GLOB '[a-z]'),
	CONSTRAINT "metaobject_definitions_name_valid" CHECK("metaobject_definitions"."name" = trim("metaobject_definitions"."name") AND length("metaobject_definitions"."name") BETWEEN 1 AND 80),
	CONSTRAINT "metaobject_definitions_description_length" CHECK("metaobject_definitions"."description" IS NULL OR length("metaobject_definitions"."description") <= 300),
	CONSTRAINT "metaobject_definitions_fields_json" CHECK(json_valid("metaobject_definitions"."fields") AND substr("metaobject_definitions"."fields", 1, 1) = '[' AND length("metaobject_definitions"."fields") <= 65536),
	CONSTRAINT "metaobject_definitions_display_field_shape" CHECK("metaobject_definitions"."display_field" IS NULL OR (length("metaobject_definitions"."display_field") BETWEEN 2 AND 64 AND "metaobject_definitions"."display_field" NOT GLOB '*[^_a-z0-9]*')),
	CONSTRAINT "metaobject_definitions_revision_positive" CHECK("metaobject_definitions"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metaobject_definitions_namespace_type_unique` ON `metaobject_definitions` (`namespace`,`type`);
--> statement-breakpoint
CREATE TABLE `metaobject_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`handle` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `metaobject_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "metaobject_entries_id_shape" CHECK(substr("metaobject_entries"."id", 1, 4) = 'moe_' AND length("metaobject_entries"."id") BETWEEN 10 AND 68 AND "metaobject_entries"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "metaobject_entries_handle_shape" CHECK(length("metaobject_entries"."handle") BETWEEN 1 AND 100 AND "metaobject_entries"."handle" NOT GLOB '*[^a-z0-9-]*' AND substr("metaobject_entries"."handle", 1, 1) <> '-' AND substr("metaobject_entries"."handle", length("metaobject_entries"."handle"), 1) <> '-'),
	CONSTRAINT "metaobject_entries_status_check" CHECK("metaobject_entries"."status" IN ('draft', 'published')),
	CONSTRAINT "metaobject_entries_fields_json" CHECK(json_valid("metaobject_entries"."fields") AND substr("metaobject_entries"."fields", 1, 1) = '{' AND length("metaobject_entries"."fields") <= 262144),
	CONSTRAINT "metaobject_entries_position_range" CHECK("metaobject_entries"."position" BETWEEN 0 AND 1000000),
	CONSTRAINT "metaobject_entries_revision_positive" CHECK("metaobject_entries"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metaobject_entries_definition_handle_unique` ON `metaobject_entries` (`definition_id`,`handle`);
--> statement-breakpoint
CREATE INDEX `metaobject_entries_definition_status_position_idx` ON `metaobject_entries` (`definition_id`,`status`,`position`);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`audience` text NOT NULL,
	`user_id` text,
	`customer_id` text,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device_label` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "push_subscriptions_id_shape" CHECK(substr("push_subscriptions"."id", 1, 4) = 'psb_' AND length("push_subscriptions"."id") BETWEEN 10 AND 68),
	CONSTRAINT "push_subscriptions_audience_owner" CHECK(("push_subscriptions"."audience" = 'staff' AND "push_subscriptions"."user_id" IS NOT NULL AND "push_subscriptions"."customer_id" IS NULL) OR ("push_subscriptions"."audience" = 'customer' AND "push_subscriptions"."customer_id" IS NOT NULL AND "push_subscriptions"."user_id" IS NULL)),
	CONSTRAINT "push_subscriptions_endpoint_https" CHECK(substr("push_subscriptions"."endpoint", 1, 8) = 'https://' AND length("push_subscriptions"."endpoint") <= 2048),
	CONSTRAINT "push_subscriptions_key_lengths" CHECK(length("push_subscriptions"."p256dh") BETWEEN 80 AND 100 AND length("push_subscriptions"."auth") BETWEEN 16 AND 32),
	CONSTRAINT "push_subscriptions_device_label_length" CHECK("push_subscriptions"."device_label" IS NULL OR length("push_subscriptions"."device_label") <= 120),
	CONSTRAINT "push_subscriptions_failure_count" CHECK("push_subscriptions"."failure_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_staff_idx` ON `push_subscriptions` (`audience`,`user_id`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_customer_idx` ON `push_subscriptions` (`customer_id`);
--> statement-breakpoint
CREATE TABLE `customer_identities` (
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`customer_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`last_used_at` integer,
	PRIMARY KEY(`provider_id`, `subject`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "customer_identities_provider_shape" CHECK(length("customer_identities"."provider_id") BETWEEN 3 AND 150 AND instr("customer_identities"."provider_id", ':') > 1),
	CONSTRAINT "customer_identities_subject_length" CHECK(length("customer_identities"."subject") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX `customer_identities_customer_idx` ON `customer_identities` (`customer_id`);
--> statement-breakpoint
ALTER TABLE `markets` ADD `fx_rate_source` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_definitions_ins` AFTER INSERT ON `metaobject_definitions`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || NEW.`id`, 'mo:*', 't:metaobject_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_definitions_del` AFTER DELETE ON `metaobject_definitions`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || OLD.`id`, 'mo:*', 't:metaobject_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_definitions_upd` AFTER UPDATE ON `metaobject_definitions`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`namespace` IS NOT NEW.`namespace` OR OLD.`type` IS NOT NEW.`type` OR OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description` OR OLD.`fields` IS NOT NEW.`fields` OR OLD.`display_field` IS NOT NEW.`display_field` OR OLD.`storefront_access` IS NOT NEW.`storefront_access`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || NEW.`id`, 'mo:*', 't:metaobject_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_definitions_upd_old` AFTER UPDATE ON `metaobject_definitions`
WHEN (OLD.`id` IS NOT NEW.`id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || OLD.`id`, 'mo:*', 't:metaobject_definitions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_entries_ins` AFTER INSERT ON `metaobject_entries`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || NEW.`definition_id`, 't:metaobject_entries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_entries_del` AFTER DELETE ON `metaobject_entries`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || OLD.`definition_id`, 't:metaobject_entries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_entries_upd` AFTER UPDATE ON `metaobject_entries`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`definition_id` IS NOT NEW.`definition_id` OR OLD.`handle` IS NOT NEW.`handle` OR OLD.`status` IS NOT NEW.`status` OR OLD.`fields` IS NOT NEW.`fields` OR OLD.`position` IS NOT NEW.`position`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || NEW.`definition_id`, 't:metaobject_entries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_metaobject_entries_upd_old` AFTER UPDATE ON `metaobject_entries`
WHEN (OLD.`definition_id` IS NOT NEW.`definition_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mo:' || OLD.`definition_id`, 't:metaobject_entries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (126, '0126_plugin_seams', '470fbd59758360fd69f2f9e5e26fef0aed345040ef924cc5d118a213a2e60614');
