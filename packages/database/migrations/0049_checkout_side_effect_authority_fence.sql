CREATE TRIGGER `admin_fcm_tokens_checkout_authority_insert`
AFTER INSERT ON `admin_fcm_tokens`
WHEN NEW.`is_active` = 1
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `admin_fcm_tokens_checkout_authority_update`
AFTER UPDATE ON `admin_fcm_tokens`
WHEN NEW.`is_active` IS NOT OLD.`is_active`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `admin_fcm_tokens_checkout_authority_delete`
AFTER DELETE ON `admin_fcm_tokens`
WHEN OLD.`is_active` = 1
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `meta_conversions_settings_checkout_authority_insert`
AFTER INSERT ON `meta_conversions_settings`
WHEN NEW.`singleton_key` = 'default'
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `meta_conversions_settings_checkout_authority_update`
AFTER UPDATE ON `meta_conversions_settings`
WHEN (OLD.`singleton_key` = 'default' OR NEW.`singleton_key` = 'default')
  AND (
    NEW.`singleton_key` IS NOT OLD.`singleton_key`
    OR NEW.`pixel_id` IS NOT OLD.`pixel_id`
    OR NEW.`access_token` IS NOT OLD.`access_token`
    OR NEW.`is_enabled` IS NOT OLD.`is_enabled`
  )
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `meta_conversions_settings_checkout_authority_delete`
AFTER DELETE ON `meta_conversions_settings`
WHEN OLD.`singleton_key` = 'default'
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
