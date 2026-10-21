-- A saved payment method belongs to the app that kept it (security audit N3).
-- The app whose purchase option the buyer agreed to (`owner_plugin_id`, and
-- the option itself when the order named exactly one) is the only app that
-- may charge it without the buyer; staff are unrestricted. Methods kept
-- before this migration have no owner: only staff may charge them.
ALTER TABLE `customer_payment_methods` ADD `owner_plugin_id` text;
--> statement-breakpoint
ALTER TABLE `customer_payment_methods` ADD `purchase_option_id` text;
--> statement-breakpoint
ALTER TABLE `customer_payment_methods` ADD `purchase_option_title` text;
--> statement-breakpoint
-- Charging a saved method off-session (and capturing or voiding an
-- authorization) gets its own sensitive permission, separate from recording
-- an invoice payment. Every role, direct grant and agent grant that could
-- record payments keeps charging: no staff member loses access. App grants
-- are not widened: an app asks for write_payment_methods.
INSERT INTO `permissions` (`id`, `name`, `display_name`, `description`, `resource`, `action`, `category`, `is_sensitive`)
SELECT 'perm_orders_charge_saved_methods', 'orders.charge_saved_methods', 'Charge Saved Payment Methods', 'Charge a customer''s saved card or wallet without them, and capture or void an authorization', 'orders', 'charge_saved_methods', 'Orders', 1
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `name` = 'orders.charge_saved_methods');
--> statement-breakpoint
INSERT INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT 'rpm_charge_saved_' || `granted`.`role_id`, `granted`.`role_id`, `charge`.`id`
FROM `role_permissions` AS `granted`
JOIN `permissions` AS `record` ON `record`.`id` = `granted`.`permission_id` AND `record`.`name` = 'orders.record_payment'
JOIN `permissions` AS `charge` ON `charge`.`name` = 'orders.charge_saved_methods'
WHERE NOT EXISTS (
  SELECT 1 FROM `role_permissions` AS `existing`
  WHERE `existing`.`role_id` = `granted`.`role_id` AND `existing`.`permission_id` = `charge`.`id`
);
--> statement-breakpoint
INSERT INTO `user_permissions` (`id`, `user_id`, `permission_id`, `granted`, `assigned_by`)
SELECT 'upm_charge_saved_' || `direct`.`user_id`, `direct`.`user_id`, `charge`.`id`, `direct`.`granted`, `direct`.`assigned_by`
FROM `user_permissions` AS `direct`
JOIN `permissions` AS `record` ON `record`.`id` = `direct`.`permission_id` AND `record`.`name` = 'orders.record_payment'
JOIN `permissions` AS `charge` ON `charge`.`name` = 'orders.charge_saved_methods'
WHERE NOT EXISTS (
  SELECT 1 FROM `user_permissions` AS `existing`
  WHERE `existing`.`user_id` = `direct`.`user_id` AND `existing`.`permission_id` = `charge`.`id`
);
--> statement-breakpoint
-- A list that names orders.record_payment is a non-empty JSON array: append before its closing bracket.
UPDATE `agent_grants`
SET `permissions_json` = substr(rtrim(`permissions_json`), 1, length(rtrim(`permissions_json`)) - 1) || ',"orders.charge_saved_methods"]'
WHERE instr(`permissions_json`, '"orders.record_payment"') > 0 AND instr(`permissions_json`, '"orders.charge_saved_methods"') = 0;
--> statement-breakpoint
UPDATE `agent_device_authorizations`
SET `requested_permissions_json` = substr(rtrim(`requested_permissions_json`), 1, length(rtrim(`requested_permissions_json`)) - 1) || ',"orders.charge_saved_methods"]'
WHERE instr(`requested_permissions_json`, '"orders.record_payment"') > 0 AND instr(`requested_permissions_json`, '"orders.charge_saved_methods"') = 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (175, '0175_saved_method_owner', '2ebd2d7e7f51054207bd4a8b15587dd625d0e744dabeae69823f340dfb479172');
