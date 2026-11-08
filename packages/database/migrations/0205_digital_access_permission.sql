-- Giving, resetting and taking away a buyer's downloads and licence keys gets
-- its own permission, orders.manage_digital_access, so an app needs the
-- write_digital_access scope rather than write_orders (whose apps tag and edit
-- orders, and should not ask the merchant for an undoable revoke). Every role,
-- direct grant and agent grant that could edit orders keeps managing digital
-- access: no staff member loses access. App grants are not widened: an app
-- asks for write_digital_access and the merchant approves it.
INSERT INTO `permissions` (`id`, `name`, `display_name`, `description`, `resource`, `action`, `category`, `is_sensitive`)
SELECT 'perm_orders_manage_digital_access', 'orders.manage_digital_access', 'Manage Digital Access', 'Give, reset and take away a buyer''s downloads and licence keys', 'orders', 'manage_digital_access', 'Orders', 0
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `name` = 'orders.manage_digital_access');
--> statement-breakpoint
INSERT INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT 'rpm_digital_access_' || `granted`.`role_id`, `granted`.`role_id`, `access`.`id`
FROM `role_permissions` AS `granted`
JOIN `permissions` AS `edit` ON `edit`.`id` = `granted`.`permission_id` AND `edit`.`name` = 'orders.edit'
JOIN `permissions` AS `access` ON `access`.`name` = 'orders.manage_digital_access'
WHERE NOT EXISTS (
  SELECT 1 FROM `role_permissions` AS `existing`
  WHERE `existing`.`role_id` = `granted`.`role_id` AND `existing`.`permission_id` = `access`.`id`
);
--> statement-breakpoint
INSERT INTO `user_permissions` (`id`, `user_id`, `permission_id`, `granted`, `assigned_by`)
SELECT 'upm_digital_access_' || `direct`.`user_id`, `direct`.`user_id`, `access`.`id`, `direct`.`granted`, `direct`.`assigned_by`
FROM `user_permissions` AS `direct`
JOIN `permissions` AS `edit` ON `edit`.`id` = `direct`.`permission_id` AND `edit`.`name` = 'orders.edit'
JOIN `permissions` AS `access` ON `access`.`name` = 'orders.manage_digital_access'
WHERE NOT EXISTS (
  SELECT 1 FROM `user_permissions` AS `existing`
  WHERE `existing`.`user_id` = `direct`.`user_id` AND `existing`.`permission_id` = `access`.`id`
);
--> statement-breakpoint
-- A list that names orders.edit is a non-empty JSON array: append before its closing bracket.
UPDATE `agent_grants`
SET `permissions_json` = substr(rtrim(`permissions_json`), 1, length(rtrim(`permissions_json`)) - 1) || ',"orders.manage_digital_access"]'
WHERE instr(`permissions_json`, '"orders.edit"') > 0 AND instr(`permissions_json`, '"orders.manage_digital_access"') = 0;
--> statement-breakpoint
UPDATE `agent_device_authorizations`
SET `requested_permissions_json` = substr(rtrim(`requested_permissions_json`), 1, length(rtrim(`requested_permissions_json`)) - 1) || ',"orders.manage_digital_access"]'
WHERE instr(`requested_permissions_json`, '"orders.edit"') > 0 AND instr(`requested_permissions_json`, '"orders.manage_digital_access"') = 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (205, '0205_digital_access_permission', '12f14d883ebc921c40951c124153868558f2416b256bde5549589db7e8458a89');
