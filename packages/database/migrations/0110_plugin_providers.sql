-- Plugin platform, phase 3: provider ports, atomic app storage, risk holds.
-- - plugin_registrations admits the `provider` kind (one row per app and
--   provider port), so "who provides payment" is one index read that returns
--   nothing when no app does. Rebuilt with foreign keys on, every row kept.
-- - plugin_records.revision and plugin_kv.revision: the compare-and-set tokens
--   of app storage; existing rows start at 1.
-- - order_holds: an app's order.risk "hold" stops fulfilment until staff
--   release it (one row per order and app).
-- - Generated cache dependency triggers for plugin_installations,
--   plugin_registrations and plugin_records replace the keys the plugin
--   module used to advance in application code.
CREATE TABLE `order_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`app_name` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`released_at` integer,
	`released_by` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`released_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "order_holds_id_shape" CHECK(length("order_holds"."id") = 36 AND substr("order_holds"."id", 1, 4) = 'ohd_'),
	CONSTRAINT "order_holds_app_name_length" CHECK(length("order_holds"."app_name") BETWEEN 1 AND 80),
	CONSTRAINT "order_holds_reason_length" CHECK(length("order_holds"."reason") BETWEEN 1 AND 1200),
	CONSTRAINT "order_holds_release_pair" CHECK(("order_holds"."released_at" IS NULL) OR ("order_holds"."released_at" >= "order_holds"."created_at"))
);
--> statement-breakpoint
CREATE INDEX `order_holds_open_idx` ON `order_holds` (`order_id`) WHERE "order_holds"."released_at" IS NULL;
--> statement-breakpoint
CREATE TABLE `__new_plugin_registrations` (
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`plugin_id` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	PRIMARY KEY(`kind`, `name`, `plugin_id`),
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin_installations`(`plugin_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plugin_registrations_kind_check" CHECK("__new_plugin_registrations"."kind" IN ('event', 'function', 'cron', 'provider')),
	CONSTRAINT "plugin_registrations_name_length" CHECK(length("__new_plugin_registrations"."name") BETWEEN 1 AND 64),
	CONSTRAINT "plugin_registrations_priority_range" CHECK("__new_plugin_registrations"."priority" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
INSERT INTO `__new_plugin_registrations`("kind", "name", "plugin_id", "priority") SELECT "kind", "name", "plugin_id", "priority" FROM `plugin_registrations`;
--> statement-breakpoint
DROP TABLE `plugin_registrations`;
--> statement-breakpoint
ALTER TABLE `__new_plugin_registrations` RENAME TO `plugin_registrations`;
--> statement-breakpoint
CREATE INDEX `plugin_registrations_plugin_idx` ON `plugin_registrations` (`plugin_id`);
--> statement-breakpoint
ALTER TABLE `plugin_kv` ADD COLUMN `revision` integer DEFAULT 1 NOT NULL CONSTRAINT `plugin_kv_revision_positive` CHECK (`revision` >= 1);
--> statement-breakpoint
ALTER TABLE `plugin_records` ADD COLUMN `revision` integer DEFAULT 1 NOT NULL CONSTRAINT `plugin_records_revision_positive` CHECK (`revision` >= 1);
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_installations_ins` AFTER INSERT ON `plugin_installations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || NEW.`plugin_id`, 'plg:*', 't:plugin_installations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_installations_del` AFTER DELETE ON `plugin_installations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || OLD.`plugin_id`, 'plg:*', 't:plugin_installations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_installations_upd` AFTER UPDATE ON `plugin_installations`
WHEN (OLD.`plugin_id` IS NOT NEW.`plugin_id` OR OLD.`version` IS NOT NEW.`version` OR OLD.`source` IS NOT NEW.`source` OR OLD.`bundle_sha256` IS NOT NEW.`bundle_sha256` OR OLD.`manifest_json` IS NOT NEW.`manifest_json` OR OLD.`grant_json` IS NOT NEW.`grant_json` OR OLD.`grant_key` IS NOT NEW.`grant_key` OR OLD.`status` IS NOT NEW.`status` OR OLD.`settings_json` IS NOT NEW.`settings_json`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || NEW.`plugin_id`, 'plg:*', 't:plugin_installations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_installations_upd_old` AFTER UPDATE ON `plugin_installations`
WHEN (OLD.`plugin_id` IS NOT NEW.`plugin_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || OLD.`plugin_id`, 'plg:*', 't:plugin_installations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_registrations_ins` AFTER INSERT ON `plugin_registrations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || NEW.`plugin_id`, 'plg:*', 't:plugin_registrations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_registrations_del` AFTER DELETE ON `plugin_registrations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || OLD.`plugin_id`, 'plg:*', 't:plugin_registrations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_registrations_upd` AFTER UPDATE ON `plugin_registrations`
WHEN (OLD.`kind` IS NOT NEW.`kind` OR OLD.`name` IS NOT NEW.`name` OR OLD.`plugin_id` IS NOT NEW.`plugin_id` OR OLD.`priority` IS NOT NEW.`priority`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || NEW.`plugin_id`, 'plg:*', 't:plugin_registrations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_registrations_upd_old` AFTER UPDATE ON `plugin_registrations`
WHEN (OLD.`plugin_id` IS NOT NEW.`plugin_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plg:' || OLD.`plugin_id`, 'plg:*', 't:plugin_registrations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_records_ins` AFTER INSERT ON `plugin_records`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plgs:' || NEW.`plugin_id` || ':' || NEW.`collection`, 't:plugin_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_records_del` AFTER DELETE ON `plugin_records`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plgs:' || OLD.`plugin_id` || ':' || OLD.`collection`, 't:plugin_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_records_upd` AFTER UPDATE ON `plugin_records`
WHEN (OLD.`plugin_id` IS NOT NEW.`plugin_id` OR OLD.`collection` IS NOT NEW.`collection` OR OLD.`id` IS NOT NEW.`id` OR OLD.`data_json` IS NOT NEW.`data_json`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plgs:' || NEW.`plugin_id` || ':' || NEW.`collection`, 't:plugin_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_plugin_records_upd_old` AFTER UPDATE ON `plugin_records`
WHEN (OLD.`plugin_id` IS NOT NEW.`plugin_id` OR OLD.`collection` IS NOT NEW.`collection`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('plgs:' || OLD.`plugin_id` || ':' || OLD.`collection`, 't:plugin_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (110, '0110_plugin_providers', '32b8eee16f47ec6363dd95a9ab710cfb6fcd8bcef8a2fbf86d9601aabe9c9dcd');
