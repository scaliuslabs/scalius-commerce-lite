-- Apps write the theme and the menus (the stable app API's theme.* and
-- menus.* operations), and templates name catalogue content by handle.
--
-- 1. Theme writes get their own sensitive permission, settings.theme.edit
--    (the Sensitive write_themes app scope confers it; settings.general.edit
--    would also open business, countries and media settings). Every role,
--    direct grant and agent grant that could edit general settings keeps
--    editing the theme: no staff member loses access.
-- 2. A restore point records an app's template applied over the draft
--    (reason 'app'): the table is rebuilt for the wider reason check.
-- 3. Collections get a handle (slug), unique in the store with trashed ones,
--    backfilled from the name (an ASCII reading; else collection-<id>, and a
--    repeated handle takes the id as its suffix). It is a visible column, so
--    its update trigger is reinstalled with it.
CREATE TABLE `__new_theme_restore_points` (
	`id` text PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_restore_points_id_shape" CHECK(substr("__new_theme_restore_points"."id", 1, 8) = 'themerp_' AND length("__new_theme_restore_points"."id") BETWEEN 12 AND 40),
	CONSTRAINT "theme_restore_points_reason_check" CHECK("__new_theme_restore_points"."reason" IN ('restore', 'discard', 'app')),
	CONSTRAINT "theme_restore_points_draft_revision_positive" CHECK("__new_theme_restore_points"."draft_revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_theme_restore_points`("id", "theme", "draft_revision", "reason", "created_by", "created_at") SELECT "id", "theme", "draft_revision", "reason", "created_by", "created_at" FROM `theme_restore_points`;
--> statement-breakpoint
DROP TABLE `theme_restore_points`;
--> statement-breakpoint
ALTER TABLE `__new_theme_restore_points` RENAME TO `theme_restore_points`;
--> statement-breakpoint
CREATE INDEX `theme_restore_points_created_at_idx` ON `theme_restore_points` (`created_at`);
--> statement-breakpoint
ALTER TABLE `collections` ADD `slug` text;
--> statement-breakpoint
UPDATE `collections` SET `slug` = trim(substr(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim(`name`)), ' ', '-'), char(9), '-'), '_', '-'), '/', '-'), '.', '-'), ',', '-'), '&', '-'), '''', '-'), '(', '-'), ')', '-'), '[', '-'), ']', '-'), ':', '-'), ';', '-'), '!', '-'), '?', '-'), '+', '-'), '#', '-'), '@', '-'), '%', '-'), '*', '-'), '=', '-'), '|', '-'), '~', '-'), '^', '-'), '$', '-'), '<', '-'), '>', '-'), '{', '-'), '}', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '-'), 1, 100), '-');
--> statement-breakpoint
UPDATE `collections` SET `slug` = trim(substr(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim('collection-' || `id`)), ' ', '-'), char(9), '-'), '_', '-'), '/', '-'), '.', '-'), ',', '-'), '&', '-'), '''', '-'), '(', '-'), ')', '-'), '[', '-'), ']', '-'), ':', '-'), ';', '-'), '!', '-'), '?', '-'), '+', '-'), '#', '-'), '@', '-'), '%', '-'), '*', '-'), '=', '-'), '|', '-'), '~', '-'), '^', '-'), '$', '-'), '<', '-'), '>', '-'), '{', '-'), '}', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '-'), 1, 100), '-')
WHERE length(`slug`) < 3 OR `slug` GLOB '*[^a-z0-9-]*';
--> statement-breakpoint
UPDATE `collections` SET `slug` = trim(substr(`slug`, 1, 60), '-') || '-' || trim(substr(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim(`id`)), ' ', '-'), char(9), '-'), '_', '-'), '/', '-'), '.', '-'), ',', '-'), '&', '-'), '''', '-'), '(', '-'), ')', '-'), '[', '-'), ']', '-'), ':', '-'), ';', '-'), '!', '-'), '?', '-'), '+', '-'), '#', '-'), '@', '-'), '%', '-'), '*', '-'), '=', '-'), '|', '-'), '~', '-'), '^', '-'), '$', '-'), '<', '-'), '>', '-'), '{', '-'), '}', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '-'), 1, 100), '-')
WHERE EXISTS (SELECT 1 FROM `collections` AS `earlier` WHERE `earlier`.`slug` = `collections`.`slug` AND `earlier`.`id` < `collections`.`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_slug_idx` ON `collections` (`slug`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_collections_upd`;
--> statement-breakpoint
CREATE TRIGGER `cdep_collections_upd` AFTER UPDATE ON `collections`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`name` IS NOT NEW.`name` OR OLD.`slug` IS NOT NEW.`slug` OR OLD.`description` IS NOT NEW.`description` OR OLD.`content` IS NOT NEW.`content` OR OLD.`presentation` IS NOT NEW.`presentation` OR OLD.`config` IS NOT NEW.`config` OR OLD.`sort_order` IS NOT NEW.`sort_order` OR OLD.`is_active` IS NOT NEW.`is_active` OR OLD.`meta_title` IS NOT NEW.`meta_title` OR OLD.`meta_description` IS NOT NEW.`meta_description` OR OLD.`canonical_path` IS NOT NEW.`canonical_path` OR OLD.`no_index` IS NOT NEW.`no_index` OR OLD.`exclude_from_sitemap` IS NOT NEW.`exclude_from_sitemap` OR OLD.`listing_template` IS NOT NEW.`listing_template` OR OLD.`created_at` IS NOT NEW.`created_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('col:' || NEW.`id`, 'col:*', 't:collections')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `permissions` (`id`, `name`, `display_name`, `description`, `resource`, `action`, `category`, `is_sensitive`)
SELECT 'perm_settings_theme_edit', 'settings.theme.edit', 'Edit Theme', 'Edit, restore and publish the storefront theme', 'settings', 'theme.edit', 'Settings', 1
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `name` = 'settings.theme.edit');
--> statement-breakpoint
INSERT INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT 'rpm_theme_edit_' || `granted`.`role_id`, `granted`.`role_id`, `theme`.`id`
FROM `role_permissions` AS `granted`
JOIN `permissions` AS `general` ON `general`.`id` = `granted`.`permission_id` AND `general`.`name` = 'settings.general.edit'
JOIN `permissions` AS `theme` ON `theme`.`name` = 'settings.theme.edit'
WHERE NOT EXISTS (
  SELECT 1 FROM `role_permissions` AS `existing`
  WHERE `existing`.`role_id` = `granted`.`role_id` AND `existing`.`permission_id` = `theme`.`id`
);
--> statement-breakpoint
INSERT INTO `user_permissions` (`id`, `user_id`, `permission_id`, `granted`, `assigned_by`)
SELECT 'upm_theme_edit_' || `direct`.`user_id`, `direct`.`user_id`, `theme`.`id`, `direct`.`granted`, `direct`.`assigned_by`
FROM `user_permissions` AS `direct`
JOIN `permissions` AS `general` ON `general`.`id` = `direct`.`permission_id` AND `general`.`name` = 'settings.general.edit'
JOIN `permissions` AS `theme` ON `theme`.`name` = 'settings.theme.edit'
WHERE NOT EXISTS (
  SELECT 1 FROM `user_permissions` AS `existing`
  WHERE `existing`.`user_id` = `direct`.`user_id` AND `existing`.`permission_id` = `theme`.`id`
);
--> statement-breakpoint
-- A list that names settings.general.edit is a non-empty JSON array: append before its closing bracket.
UPDATE `agent_grants`
SET `permissions_json` = substr(rtrim(`permissions_json`), 1, length(rtrim(`permissions_json`)) - 1) || ',"settings.theme.edit"]'
WHERE instr(`permissions_json`, '"settings.general.edit"') > 0 AND instr(`permissions_json`, '"settings.theme.edit"') = 0;
--> statement-breakpoint
UPDATE `agent_device_authorizations`
SET `requested_permissions_json` = substr(rtrim(`requested_permissions_json`), 1, length(rtrim(`requested_permissions_json`)) - 1) || ',"settings.theme.edit"]'
WHERE instr(`requested_permissions_json`, '"settings.general.edit"') > 0 AND instr(`requested_permissions_json`, '"settings.theme.edit"') = 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (170, '0170_collection_slugs_and_theme_permission', 'd392d4f5489fb732bf8193dc3e01c6a048464950d9160839787d722d942cfa8a');
