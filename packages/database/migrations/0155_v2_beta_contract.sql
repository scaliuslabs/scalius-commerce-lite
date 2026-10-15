DROP TABLE IF EXISTS `metaobject_entries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `metaobject_definitions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `plugin_records`;
--> statement-breakpoint
CREATE TABLE `event_demand` (
	`filter` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `object_types` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`fields_json` text NOT NULL,
	`indexes_json` text DEFAULT '[]' NOT NULL,
	`unique_json` text DEFAULT '[]' NOT NULL,
	`display_field` text,
	`storefront` integer DEFAULT false NOT NULL,
	`admin` text DEFAULT 'none' NOT NULL,
	`events` integer DEFAULT false NOT NULL,
	`handle` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "object_types_id_shape" CHECK("object_types"."id" = 'oty_' || "object_types"."namespace" || '.' || "object_types"."type"),
	CONSTRAINT "object_types_namespace_shape" CHECK("object_types"."namespace" = 'custom' OR (length("object_types"."namespace") BETWEEN 3 AND 101 AND "object_types"."namespace" NOT GLOB '*[^a-z0-9.-]*' AND instr("object_types"."namespace", '.') > 1 AND instr("object_types"."namespace", '.') < length("object_types"."namespace"))),
	CONSTRAINT "object_types_type_shape" CHECK(length("object_types"."type") BETWEEN 2 AND 48 AND "object_types"."type" NOT GLOB '*[^_a-z0-9]*' AND substr("object_types"."type", 1, 1) GLOB '[a-z]'),
	CONSTRAINT "object_types_name_valid" CHECK("object_types"."name" = trim("object_types"."name") AND length("object_types"."name") BETWEEN 1 AND 80),
	CONSTRAINT "object_types_description_length" CHECK("object_types"."description" IS NULL OR length("object_types"."description") <= 300),
	CONSTRAINT "object_types_fields_json" CHECK(json_valid("object_types"."fields_json") AND json_type("object_types"."fields_json") = 'array' AND length("object_types"."fields_json") <= 65536),
	CONSTRAINT "object_types_indexes_json" CHECK(json_valid("object_types"."indexes_json") AND json_type("object_types"."indexes_json") = 'array' AND length("object_types"."indexes_json") <= 2048),
	CONSTRAINT "object_types_unique_json" CHECK(json_valid("object_types"."unique_json") AND json_type("object_types"."unique_json") = 'array' AND length("object_types"."unique_json") <= 1024),
	CONSTRAINT "object_types_admin_check" CHECK("object_types"."admin" IN ('none', 'read', 'edit')),
	CONSTRAINT "object_types_flags" CHECK("object_types"."storefront" IN (0, 1) AND "object_types"."events" IN (0, 1) AND "object_types"."handle" IN (0, 1)),
	CONSTRAINT "object_types_revision_positive" CHECK("object_types"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE `object_records` (
	`type_id` text NOT NULL,
	`id` text NOT NULL,
	`handle` text,
	`status` text DEFAULT 'active' NOT NULL,
	`data_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`k1` text,
	`k2` text,
	`k3` text,
	`k4` text,
	`u1` text,
	`u2` text,
	`pub` integer DEFAULT false NOT NULL,
	`ev` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`type_id`, `id`),
	FOREIGN KEY (`type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "object_records_id_length" CHECK(length("object_records"."id") BETWEEN 1 AND 128),
	CONSTRAINT "object_records_handle_shape" CHECK("object_records"."handle" IS NULL OR (length("object_records"."handle") BETWEEN 1 AND 100 AND "object_records"."handle" NOT GLOB '*[^a-z0-9-]*' AND substr("object_records"."handle", 1, 1) <> '-' AND substr("object_records"."handle", length("object_records"."handle"), 1) <> '-')),
	CONSTRAINT "object_records_status_check" CHECK("object_records"."status" IN ('active', 'draft', 'published')),
	CONSTRAINT "object_records_data_json" CHECK(json_valid("object_records"."data_json") AND json_type("object_records"."data_json") = 'object' AND length("object_records"."data_json") <= 65536),
	CONSTRAINT "object_records_revision_positive" CHECK("object_records"."revision" >= 1),
	CONSTRAINT "object_records_flags" CHECK("object_records"."pub" IN (0, 1) AND "object_records"."ev" IN (0, 1) AND ("object_records"."pub" = 0 OR "object_records"."status" = 'published')),
	CONSTRAINT "object_records_position_range" CHECK("object_records"."position" BETWEEN 0 AND 1000000),
	CONSTRAINT "object_records_k1_hex" CHECK("object_records"."k1" IS NULL OR (length("object_records"."k1") BETWEEN 2 AND 2048 AND "object_records"."k1" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "object_records_k2_hex" CHECK("object_records"."k2" IS NULL OR (length("object_records"."k2") BETWEEN 2 AND 2048 AND "object_records"."k2" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "object_records_k3_hex" CHECK("object_records"."k3" IS NULL OR (length("object_records"."k3") BETWEEN 2 AND 2048 AND "object_records"."k3" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "object_records_k4_hex" CHECK("object_records"."k4" IS NULL OR (length("object_records"."k4") BETWEEN 2 AND 2048 AND "object_records"."k4" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "object_records_u1_hex" CHECK("object_records"."u1" IS NULL OR (length("object_records"."u1") BETWEEN 2 AND 2048 AND "object_records"."u1" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "object_records_u2_hex" CHECK("object_records"."u2" IS NULL OR (length("object_records"."u2") BETWEEN 2 AND 2048 AND "object_records"."u2" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE INDEX `object_records_k1` ON `object_records` (`type_id`,`k1`,`id`) WHERE "object_records"."k1" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `object_records_k2` ON `object_records` (`type_id`,`k2`,`id`) WHERE "object_records"."k2" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `object_records_k3` ON `object_records` (`type_id`,`k3`,`id`) WHERE "object_records"."k3" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `object_records_k4` ON `object_records` (`type_id`,`k4`,`id`) WHERE "object_records"."k4" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `object_records_u1` ON `object_records` (`type_id`,`u1`) WHERE "object_records"."u1" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `object_records_u2` ON `object_records` (`type_id`,`u2`) WHERE "object_records"."u2" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `object_records_handle` ON `object_records` (`type_id`,`handle`) WHERE "object_records"."handle" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `object_records_public_position` ON `object_records` (`type_id`,`position`,`id`) WHERE "object_records"."pub" = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `object_types_namespace_type_unique` ON `object_types` (`namespace`,`type`);
--> statement-breakpoint
ALTER TABLE `abandoned_checkouts` ADD `abandoned_at` integer;
--> statement-breakpoint
CREATE INDEX `abandoned_checkouts_pending_idx` ON `abandoned_checkouts` (`abandoned_at`,`updated_at`,`id`);
--> statement-breakpoint
ALTER TABLE `orders` ADD `attributes` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `rate_source` text DEFAULT 'flat' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `rate_service` text;
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `fallback_fee_minor` integer;
--> statement-breakpoint
INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
--> statement-breakpoint
DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
--> statement-breakpoint
CREATE TRIGGER demand_webhook_insert_0 AFTER INSERT ON webhook_subscriptions
WHEN NEW.status = 'active'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_insert_1 AFTER INSERT ON webhook_subscriptions
WHEN NEW.status = 'active'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_update_0 AFTER UPDATE OF status, topics ON webhook_subscriptions
WHEN OLD.status IS NOT NEW.status OR OLD.topics IS NOT NEW.topics
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_update_1 AFTER UPDATE OF status, topics ON webhook_subscriptions
WHEN OLD.status IS NOT NEW.status OR OLD.topics IS NOT NEW.topics
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_delete_0 AFTER DELETE ON webhook_subscriptions
WHEN OLD.status = 'active'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_delete_1 AFTER DELETE ON webhook_subscriptions
WHEN OLD.status = 'active'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_insert_0 AFTER INSERT ON plugin_registrations
WHEN NEW.kind = 'event'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_insert_1 AFTER INSERT ON plugin_registrations
WHEN NEW.kind = 'event'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_update_0 AFTER UPDATE OF kind, name, plugin_id ON plugin_registrations
WHEN OLD.kind = 'event' OR NEW.kind = 'event'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_update_1 AFTER UPDATE OF kind, name, plugin_id ON plugin_registrations
WHEN OLD.kind = 'event' OR NEW.kind = 'event'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_delete_0 AFTER DELETE ON plugin_registrations
WHEN OLD.kind = 'event'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_delete_1 AFTER DELETE ON plugin_registrations
WHEN OLD.kind = 'event'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
CREATE TRIGGER demand_installation_status_0 AFTER UPDATE OF status ON plugin_installations
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_installation_status_1 AFTER UPDATE OF status ON plugin_installations
WHEN OLD.status IS NOT NEW.status
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
END;
--> statement-breakpoint
UPDATE permissions SET name = 'objects.view', resource = 'objects', display_name = 'View objects' WHERE name = 'metaobjects.view';
--> statement-breakpoint
UPDATE permissions SET name = 'objects.edit', resource = 'objects', display_name = 'Edit objects' WHERE name = 'metaobjects.edit';
--> statement-breakpoint
UPDATE agent_grants SET permissions_json = replace(replace(permissions_json, '"metaobjects.view"', '"objects.view"'), '"metaobjects.edit"', '"objects.edit"') WHERE instr(permissions_json, '"metaobjects.') > 0;
--> statement-breakpoint
UPDATE agent_device_authorizations SET requested_permissions_json = replace(replace(requested_permissions_json, '"metaobjects.view"', '"objects.view"'), '"metaobjects.edit"', '"objects.edit"') WHERE instr(requested_permissions_json, '"metaobjects.') > 0;
--> statement-breakpoint
DELETE FROM theme_preview_sessions;
--> statement-breakpoint
DELETE FROM theme_restore_points;
--> statement-breakpoint
DELETE FROM theme_settings_versions;
--> statement-breakpoint
DELETE FROM theme_settings_drafts;
--> statement-breakpoint
DELETE FROM theme_settings;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_shipping_methods_upd`;
--> statement-breakpoint
CREATE TRIGGER `cdep_shipping_methods_upd` AFTER UPDATE ON `shipping_methods`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`name` IS NOT NEW.`name` OR OLD.`fee_minor` IS NOT NEW.`fee_minor` OR OLD.`rate_source` IS NOT NEW.`rate_source` OR OLD.`rate_service` IS NOT NEW.`rate_service` OR OLD.`fallback_fee_minor` IS NOT NEW.`fallback_fee_minor` OR OLD.`description` IS NOT NEW.`description` OR OLD.`is_active` IS NOT NEW.`is_active` OR OLD.`sort_order` IS NOT NEW.`sort_order` OR OLD.`created_at` IS NOT NEW.`created_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at` OR OLD.`zone_id` IS NOT NEW.`zone_id` OR OLD.`free_over_minor` IS NOT NEW.`free_over_minor` OR OLD.`pickup_address` IS NOT NEW.`pickup_address` OR OLD.`pickup_hours` IS NOT NEW.`pickup_hours` OR OLD.`kind` IS NOT NEW.`kind`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:shipping_methods')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_ins` AFTER INSERT ON `object_types`
WHEN NEW.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`id`, 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_del` AFTER DELETE ON `object_types`
WHEN OLD.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`id`, 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_upd` AFTER UPDATE ON `object_types`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`namespace` IS NOT NEW.`namespace` OR OLD.`type` IS NOT NEW.`type` OR OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description` OR OLD.`fields_json` IS NOT NEW.`fields_json` OR OLD.`display_field` IS NOT NEW.`display_field` OR OLD.`storefront` IS NOT NEW.`storefront` OR OLD.`handle` IS NOT NEW.`handle`)
  AND NEW.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`id`, 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_types_upd_old` AFTER UPDATE ON `object_types`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`storefront` IS NOT NEW.`storefront`)
  AND OLD.`storefront` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`id`, 't:object_types')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_ins` AFTER INSERT ON `object_records`
WHEN NEW.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`type_id`, 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_del` AFTER DELETE ON `object_records`
WHEN OLD.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`type_id`, 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_upd` AFTER UPDATE ON `object_records`
WHEN (OLD.`type_id` IS NOT NEW.`type_id` OR OLD.`id` IS NOT NEW.`id` OR OLD.`handle` IS NOT NEW.`handle` OR OLD.`status` IS NOT NEW.`status` OR OLD.`data_json` IS NOT NEW.`data_json` OR OLD.`pub` IS NOT NEW.`pub` OR OLD.`position` IS NOT NEW.`position`)
  AND NEW.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || NEW.`type_id`, 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_object_records_upd_old` AFTER UPDATE ON `object_records`
WHEN (OLD.`type_id` IS NOT NEW.`type_id` OR OLD.`pub` IS NOT NEW.`pub`)
  AND OLD.`pub` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('obj:' || OLD.`type_id`, 't:object_records')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_orders_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_orders_created_from_incomplete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_orders_updated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_orders_paid_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_orders_paid;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_orders_cancelled;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_order_fulfillments_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_order_payments_refunded_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_order_payments_refunded;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_order_returns_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_order_returns_status;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_products_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_products_updated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_products_trashed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_products_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_product_channel_publications_published;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_product_channel_publications_republished;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_product_channel_publications_unpublished;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_product_channel_publications_removed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_movements_stock;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_movements_reverted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_purchase_orders_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_purchase_orders_changed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_purchase_orders_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_transfers_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_transfers_changed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_transfers_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customers_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customers_updated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customer_addresses_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customer_addresses_changed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customer_addresses_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customer_marketing_consents_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customer_marketing_consents_changed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_fulfillments_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_fulfillments_voided;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_shipments_status;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_payments_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_payments_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_checkouts_abandoned;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_promotions_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_promotions_updated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_promotions_trashed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_promotions_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_promotions_redeemed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_reviews_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_reviews_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_gift_cards_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_gift_cards_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_gift_card_transactions_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_objects_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_objects_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_objects_delete;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_created` AFTER INSERT ON `orders`
WHEN NEW.`status` <> 'incomplete' AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.created', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'status', NEW.`status`, 'paymentStatus', NEW.`payment_status`, 'channel', NEW.`channel`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_created_from_incomplete` AFTER UPDATE ON `orders`
WHEN (OLD.`status` = 'incomplete' AND NEW.`status` NOT IN ('incomplete', 'cancelled')) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.created', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'status', NEW.`status`, 'paymentStatus', NEW.`payment_status`, 'channel', NEW.`channel`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_updated` AFTER UPDATE ON `orders`
WHEN (OLD.`status` <> 'incomplete' AND NEW.`status` <> 'incomplete' AND (OLD.`status` IS NOT NEW.`status` OR OLD.`payment_status` IS NOT NEW.`payment_status` OR OLD.`fulfillment_status` IS NOT NEW.`fulfillment_status` OR OLD.`payment_method` IS NOT NEW.`payment_method` OR OLD.`paid_amount_minor` IS NOT NEW.`paid_amount_minor` OR OLD.`balance_due_minor` IS NOT NEW.`balance_due_minor` OR OLD.`subtotal_amount_minor` IS NOT NEW.`subtotal_amount_minor` OR OLD.`shipping_amount_minor` IS NOT NEW.`shipping_amount_minor` OR OLD.`discount_amount_minor` IS NOT NEW.`discount_amount_minor` OR OLD.`tax_amount_minor` IS NOT NEW.`tax_amount_minor` OR OLD.`total_amount_minor` IS NOT NEW.`total_amount_minor` OR OLD.`customer_name` IS NOT NEW.`customer_name` OR OLD.`customer_phone` IS NOT NEW.`customer_phone` OR OLD.`customer_email` IS NOT NEW.`customer_email` OR OLD.`customer_whatsapp` IS NOT NEW.`customer_whatsapp` OR OLD.`shipping_address` IS NOT NEW.`shipping_address` OR OLD.`shipping_address_line2` IS NOT NEW.`shipping_address_line2` OR OLD.`shipping_country_code` IS NOT NEW.`shipping_country_code` OR OLD.`shipping_dependent_locality` IS NOT NEW.`shipping_dependent_locality` OR OLD.`shipping_locality` IS NOT NEW.`shipping_locality` OR OLD.`shipping_admin_area` IS NOT NEW.`shipping_admin_area` OR OLD.`shipping_postal_code` IS NOT NEW.`shipping_postal_code` OR OLD.`shipping_company` IS NOT NEW.`shipping_company` OR OLD.`shipping_name` IS NOT NEW.`shipping_name` OR OLD.`shipping_phone` IS NOT NEW.`shipping_phone` OR OLD.`shipping_validation_skipped` IS NOT NEW.`shipping_validation_skipped` OR OLD.`city` IS NOT NEW.`city` OR OLD.`zone` IS NOT NEW.`zone` OR OLD.`area` IS NOT NEW.`area` OR OLD.`billing_same_as_shipping` IS NOT NEW.`billing_same_as_shipping` OR OLD.`billing_name` IS NOT NEW.`billing_name` OR OLD.`billing_company` IS NOT NEW.`billing_company` OR OLD.`billing_address` IS NOT NEW.`billing_address` OR OLD.`billing_address_line2` IS NOT NEW.`billing_address_line2` OR OLD.`billing_country_code` IS NOT NEW.`billing_country_code` OR OLD.`billing_dependent_locality` IS NOT NEW.`billing_dependent_locality` OR OLD.`billing_locality` IS NOT NEW.`billing_locality` OR OLD.`billing_admin_area` IS NOT NEW.`billing_admin_area` OR OLD.`billing_postal_code` IS NOT NEW.`billing_postal_code` OR OLD.`billing_phone` IS NOT NEW.`billing_phone` OR OLD.`billing_validation_skipped` IS NOT NEW.`billing_validation_skipped` OR OLD.`notes` IS NOT NEW.`notes` OR OLD.`shipping_method_id` IS NOT NEW.`shipping_method_id` OR OLD.`pickup_ready_at` IS NOT NEW.`pickup_ready_at` OR OLD.`expected_delivery` IS NOT NEW.`expected_delivery` OR OLD.`customer_id` IS NOT NEW.`customer_id` OR OLD.`channel_source` IS NOT NEW.`channel_source` OR OLD.`invoice_number` IS NOT NEW.`invoice_number` OR OLD.`archived_at` IS NOT NEW.`archived_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`)) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.updated', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'previousPaymentStatus', OLD.`payment_status`, 'paymentStatus', NEW.`payment_status`, 'previousFulfillmentStatus', OLD.`fulfillment_status`, 'fulfillmentStatus', NEW.`fulfillment_status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_paid_insert` AFTER INSERT ON `orders`
WHEN (NEW.`payment_status` = 'paid' AND NEW.`status` <> 'incomplete') AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.paid'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.paid', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'previousPaymentStatus', NULL, 'paymentStatus', NEW.`payment_status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_paid` AFTER UPDATE ON `orders`
WHEN (NEW.`payment_status` = 'paid' AND OLD.`payment_status` IS NOT 'paid' AND NEW.`status` <> 'incomplete') AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.paid'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.paid', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'previousPaymentStatus', OLD.`payment_status`, 'paymentStatus', NEW.`payment_status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_cancelled` AFTER UPDATE ON `orders`
WHEN (NEW.`status` = 'cancelled' AND OLD.`status` NOT IN ('cancelled', 'incomplete')) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.cancelled'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.cancelled', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'previousStatus', OLD.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_order_fulfillments_created` AFTER INSERT ON `order_fulfillments`
WHEN NEW.`status` = 'active' AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.fulfilled'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.fulfilled', 'order', NEW.`order_id`, json_object('orderId', NEW.`order_id`, 'fulfillmentId', NEW.`id`, 'kind', NEW.`kind`, 'locationId', NEW.`location_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_order_payments_refunded_insert` AFTER INSERT ON `order_payments`
WHEN (NEW.`payment_type` = 'refund' AND NEW.`status` = 'refunded') AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.refunded'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.refunded', 'order', NEW.`order_id`, json_object('orderId', NEW.`order_id`, 'paymentId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_order_payments_refunded` AFTER UPDATE ON `order_payments`
WHEN (NEW.`payment_type` = 'refund' AND NEW.`status` = 'refunded' AND OLD.`status` IS NOT 'refunded') AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.refunded'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.refunded', 'order', NEW.`order_id`, json_object('orderId', NEW.`order_id`, 'paymentId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_order_returns_created` AFTER INSERT ON `order_returns`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'return.*', 'return.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'return.updated', 'return', NEW.`id`, json_object('returnId', NEW.`id`, 'orderId', NEW.`order_id`, 'previousStatus', NULL, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_order_returns_status` AFTER UPDATE ON `order_returns`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'return.*', 'return.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'return.updated', 'return', NEW.`id`, json_object('returnId', NEW.`id`, 'orderId', NEW.`order_id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_products_created` AFTER INSERT ON `products`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.created', 'product', NEW.`id`, json_object('productId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_products_updated` AFTER UPDATE ON `products`
WHEN (NEW.`deleted_at` IS NULL AND ((OLD.`aggregate_revision` IS NOT NEW.`aggregate_revision` OR OLD.`tax_classification_version` IS NOT NEW.`tax_classification_version`) OR OLD.`deleted_at` IS NOT NULL)) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.updated', 'product', NEW.`id`, json_object('productId', NEW.`id`, 'revision', NEW.`aggregate_revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_products_trashed` AFTER UPDATE ON `products`
WHEN (OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.deleted'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.deleted', 'product', NEW.`id`, json_object('productId', NEW.`id`, 'deletion', 'trashed'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_products_deleted` AFTER DELETE ON `products`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.deleted'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.deleted', 'product', OLD.`id`, json_object('productId', OLD.`id`, 'deletion', 'permanent'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_published` AFTER INSERT ON `product_channel_publications`
WHEN NEW.`unpublished_at` IS NULL AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', NEW.`product_id`, json_object('productId', NEW.`product_id`, 'channelId', NEW.`channel_id`, 'state', 'published'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_republished` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`unpublished_at` IS NOT NULL AND NEW.`unpublished_at` IS NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', NEW.`product_id`, json_object('productId', NEW.`product_id`, 'channelId', NEW.`channel_id`, 'state', 'published'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_unpublished` AFTER UPDATE ON `product_channel_publications`
WHEN (OLD.`unpublished_at` IS NULL AND NEW.`unpublished_at` IS NOT NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', NEW.`product_id`, json_object('productId', NEW.`product_id`, 'channelId', NEW.`channel_id`, 'state', 'unpublished'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_product_channel_publications_removed` AFTER DELETE ON `product_channel_publications`
WHEN OLD.`unpublished_at` IS NULL AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'product.publication_changed', 'product', OLD.`product_id`, json_object('productId', OLD.`product_id`, 'channelId', OLD.`channel_id`, 'state', 'unpublished'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_movements_stock` AFTER INSERT ON `inventory_movements`
WHEN NEW.`stock_delta` <> 0 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.level_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.level_changed', 'variant', NEW.`variant_id`, json_object('variantId', NEW.`variant_id`, 'productId', (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`variant_id`), 'locationId', NEW.`location_id`, 'quantityDelta', NEW.`stock_delta`, 'movementId', NEW.`id`, 'movementType', NEW.`type`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_movements_reverted` AFTER DELETE ON `inventory_movements`
WHEN OLD.`stock_delta` <> 0 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.level_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.level_changed', 'variant', OLD.`variant_id`, json_object('variantId', OLD.`variant_id`, 'productId', (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`variant_id`), 'locationId', OLD.`location_id`, 'quantityDelta', -OLD.`stock_delta`, 'movementId', OLD.`id`, 'movementType', 'reversal'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_created` AFTER INSERT ON `purchase_orders`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.purchase_order_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.purchase_order_updated', 'purchase_order', NEW.`id`, json_object('purchaseOrderId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_changed` AFTER UPDATE ON `purchase_orders`
WHEN (OLD.`revision` IS NOT NEW.`revision`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.purchase_order_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.purchase_order_updated', 'purchase_order', NEW.`id`, json_object('purchaseOrderId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_deleted` AFTER DELETE ON `purchase_orders`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.purchase_order_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.purchase_order_updated', 'purchase_order', OLD.`id`, json_object('purchaseOrderId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted', 'revision', OLD.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_created` AFTER INSERT ON `inventory_transfers`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.transfer_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.transfer_updated', 'inventory_transfer', NEW.`id`, json_object('transferId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_changed` AFTER UPDATE ON `inventory_transfers`
WHEN (OLD.`revision` IS NOT NEW.`revision`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.transfer_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.transfer_updated', 'inventory_transfer', NEW.`id`, json_object('transferId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_deleted` AFTER DELETE ON `inventory_transfers`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.transfer_updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory.transfer_updated', 'inventory_transfer', OLD.`id`, json_object('transferId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted', 'revision', OLD.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customers_created` AFTER INSERT ON `customers`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.created', 'customer', NEW.`id`, json_object('customerId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customers_updated` AFTER UPDATE ON `customers`
WHEN (OLD.`name` IS NOT NEW.`name` OR OLD.`email` IS NOT NEW.`email` OR OLD.`phone` IS NOT NEW.`phone` OR OLD.`account_claimed_at` IS NOT NEW.`account_claimed_at` OR OLD.`phone_verified_at` IS NOT NEW.`phone_verified_at` OR OLD.`email_verified_at` IS NOT NEW.`email_verified_at` OR OLD.`origin` IS NOT NEW.`origin` OR OLD.`merged_into_customer_id` IS NOT NEW.`merged_into_customer_id` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', NEW.`id`, json_object('customerId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_addresses_created` AFTER INSERT ON `customer_addresses`
WHEN substr(NEW.`id`, 7) <> NEW.`customer_id` AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_addresses_changed` AFTER UPDATE ON `customer_addresses`
WHEN (OLD.`customer_id` IS NOT NEW.`customer_id` OR OLD.`is_default` IS NOT NEW.`is_default` OR OLD.`is_default_billing` IS NOT NEW.`is_default_billing` OR OLD.`country_code` IS NOT NEW.`country_code` OR OLD.`name` IS NOT NEW.`name` OR OLD.`company` IS NOT NEW.`company` OR OLD.`line1` IS NOT NEW.`line1` OR OLD.`line2` IS NOT NEW.`line2` OR OLD.`dependent_locality` IS NOT NEW.`dependent_locality` OR OLD.`locality` IS NOT NEW.`locality` OR OLD.`admin_area` IS NOT NEW.`admin_area` OR OLD.`postal_code` IS NOT NEW.`postal_code` OR OLD.`phone_e164` IS NOT NEW.`phone_e164` OR OLD.`phone_raw` IS NOT NEW.`phone_raw` OR OLD.`city` IS NOT NEW.`city` OR OLD.`zone` IS NOT NEW.`zone` OR OLD.`area` IS NOT NEW.`area` OR OLD.`city_name` IS NOT NEW.`city_name` OR OLD.`zone_name` IS NOT NEW.`zone_name` OR OLD.`area_name` IS NOT NEW.`area_name` OR OLD.`validation_skipped` IS NOT NEW.`validation_skipped`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_addresses_deleted` AFTER DELETE ON `customer_addresses`
WHEN (SELECT `id` FROM `customers` WHERE `id` = OLD.`customer_id`) IS NOT NULL AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', OLD.`customer_id`, json_object('customerId', OLD.`customer_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_marketing_consents_created` AFTER INSERT ON `customer_marketing_consents`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.consent_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.consent_changed', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`, 'channel', NEW.`channel`, 'previousState', NULL, 'state', NEW.`state`, 'source', NEW.`source`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_marketing_consents_changed` AFTER UPDATE ON `customer_marketing_consents`
WHEN (OLD.`state` IS NOT NEW.`state`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.consent_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.consent_changed', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`, 'channel', NEW.`channel`, 'previousState', OLD.`state`, 'state', NEW.`state`, 'source', NEW.`source`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_fulfillments_created` AFTER INSERT ON `order_fulfillments`
WHEN NEW.`status` = 'active' AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'fulfillment.created', 'fulfillment', NEW.`id`, json_object('fulfillmentId', NEW.`id`, 'orderId', NEW.`order_id`, 'kind', NEW.`kind`, 'locationId', NEW.`location_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_fulfillments_voided` AFTER UPDATE ON `order_fulfillments`
WHEN (OLD.`status` = 'active' AND NEW.`status` = 'voided') AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.voided'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'fulfillment.voided', 'fulfillment', NEW.`id`, json_object('fulfillmentId', NEW.`id`, 'orderId', NEW.`order_id`, 'kind', NEW.`kind`, 'locationId', NEW.`location_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_shipments_status` AFTER UPDATE ON `delivery_shipments`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'shipment.*', 'shipment.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'shipment.updated', 'shipment', NEW.`id`, json_object('shipmentId', NEW.`id`, 'orderId', NEW.`order_id`, 'providerId', NEW.`provider_id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_payments_insert` AFTER INSERT ON `order_payments`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payment.*', 'payment.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'payment.updated', 'payment', NEW.`id`, json_object('paymentId', NEW.`id`, 'orderId', NEW.`order_id`, 'provider', NEW.`payment_method`, 'previousStatus', NULL, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_payments_update` AFTER UPDATE ON `order_payments`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payment.*', 'payment.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'payment.updated', 'payment', NEW.`id`, json_object('paymentId', NEW.`id`, 'orderId', NEW.`order_id`, 'provider', NEW.`payment_method`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_checkouts_abandoned` AFTER UPDATE ON `abandoned_checkouts`
WHEN (OLD.`abandoned_at` IS NULL AND NEW.`abandoned_at` IS NOT NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'checkout.*', 'checkout.abandoned'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'checkout.abandoned', 'checkout', NEW.`id`, json_object('abandonedCheckoutId', NEW.`id`, 'checkoutId', NEW.`checkout_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_promotions_created` AFTER INSERT ON `promotions`
WHEN NEW.`deleted_at` IS NULL AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'discount.created', 'discount', NEW.`id`, json_object('promotionId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_promotions_updated` AFTER UPDATE ON `promotions`
WHEN (NEW.`deleted_at` IS NULL AND (OLD.`revision` IS NOT NEW.`revision` OR OLD.`status` IS NOT NEW.`status` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`)) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'discount.updated', 'discount', NEW.`id`, json_object('promotionId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_promotions_trashed` AFTER UPDATE ON `promotions`
WHEN (OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.deleted'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'discount.deleted', 'discount', OLD.`id`, json_object('promotionId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_promotions_deleted` AFTER DELETE ON `promotions`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.deleted'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'discount.deleted', 'discount', OLD.`id`, json_object('promotionId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_promotions_redeemed` AFTER INSERT ON `promotion_redemptions`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.redeemed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'discount.redeemed', 'discount', NEW.`promotion_id`, json_object('promotionId', NEW.`promotion_id`, 'orderId', NEW.`order_id`, 'codeId', (SELECT `id` FROM `promotion_codes` WHERE `normalized_code` = NEW.`promotion_code`)));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_reviews_insert` AFTER INSERT ON `product_reviews`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'review.*', 'review.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'review.created', 'review', NEW.`id`, json_object('reviewId', NEW.`id`, 'productId', NEW.`product_id`, 'previousStatus', NULL, 'status', NEW.`status`, 'rating', NEW.`rating`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_reviews_update` AFTER UPDATE ON `product_reviews`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'review.*', 'review.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'review.updated', 'review', NEW.`id`, json_object('reviewId', NEW.`id`, 'productId', NEW.`product_id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'rating', NEW.`rating`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_gift_cards_insert` AFTER INSERT ON `gift_cards`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card.*', 'gift_card.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'gift_card.created', 'gift_card', NEW.`id`, json_object('giftCardId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_gift_cards_update` AFTER UPDATE ON `gift_cards`
WHEN (OLD.`status` IS NOT NEW.`status`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card.*', 'gift_card.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'gift_card.updated', 'gift_card', NEW.`id`, json_object('giftCardId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_gift_card_transactions_created` AFTER INSERT ON `gift_card_transactions`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card.*', 'gift_card.transaction'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'gift_card.transaction', 'transaction', NEW.`id`, json_object('giftCardId', NEW.`gift_card_id`, 'transactionId', NEW.`id`, 'kind', NEW.`kind`, 'orderId', NEW.`order_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_objects_insert` AFTER INSERT ON `object_records`
WHEN NEW.`ev` = 1 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'object.*', 'object.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'object.created', 'object', NEW.`id`, json_object('objectType', NEW.`type_id`, 'objectId', NEW.`id`, 'revision', NEW.`revision`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_objects_update` AFTER UPDATE ON `object_records`
WHEN (NEW.`ev` = 1 AND (OLD.`revision` IS NOT NEW.`revision`)) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'object.*', 'object.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'object.updated', 'object', NEW.`id`, json_object('objectType', NEW.`type_id`, 'objectId', NEW.`id`, 'revision', NEW.`revision`, 'status', NEW.`status`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_objects_delete` AFTER DELETE ON `object_records`
WHEN OLD.`ev` = 1 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'object.*', 'object.deleted'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'object.deleted', 'object', OLD.`id`, json_object('objectType', OLD.`type_id`, 'objectId', OLD.`id`, 'revision', OLD.`revision`, 'status', 'deleted'));
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (155, '0155_v2_beta_contract', '5c507b12e9e4f51c1124cf2d804b34e179e6c5eb755eef62ef7bb7a7342e5112');
