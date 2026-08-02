CREATE TABLE `checkout_authority` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "checkout_authority_singleton" CHECK("checkout_authority"."id" = 'default'),
	CONSTRAINT "checkout_authority_revision_positive" CHECK("checkout_authority"."revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `checkout_authority` (`id`, `revision`, `updated_at`)
VALUES ('default', 1, unixepoch());
--> statement-breakpoint
CREATE TRIGGER `settings_checkout_authority_insert`
AFTER INSERT ON `settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `settings_checkout_authority_update`
AFTER UPDATE ON `settings`
WHEN NEW.`key` IS NOT OLD.`key`
  OR NEW.`value` IS NOT OLD.`value`
  OR NEW.`type` IS NOT OLD.`type`
  OR NEW.`category` IS NOT OLD.`category`
  OR NEW.`expires_at` IS NOT OLD.`expires_at`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `settings_checkout_authority_delete`
AFTER DELETE ON `settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `site_settings_checkout_authority_insert`
AFTER INSERT ON `site_settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `site_settings_checkout_authority_update`
AFTER UPDATE ON `site_settings`
WHEN NEW.`guest_checkout_enabled` IS NOT OLD.`guest_checkout_enabled`
  OR NEW.`checkout_mode` IS NOT OLD.`checkout_mode`
  OR NEW.`partial_payment_enabled` IS NOT OLD.`partial_payment_enabled`
  OR NEW.`partial_payment_amount` IS NOT OLD.`partial_payment_amount`
  OR NEW.`checkout_flow_revision` IS NOT OLD.`checkout_flow_revision`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `site_settings_checkout_authority_delete`
AFTER DELETE ON `site_settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `products_checkout_authority_insert`
AFTER INSERT ON `products`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `products_checkout_authority_update`
AFTER UPDATE ON `products`
WHEN NEW.`name` IS NOT OLD.`name`
  OR NEW.`price` IS NOT OLD.`price`
  OR NEW.`category_id` IS NOT OLD.`category_id`
  OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
  OR NEW.`is_active` IS NOT OLD.`is_active`
  OR NEW.`discount_percentage` IS NOT OLD.`discount_percentage`
  OR NEW.`discount_type` IS NOT OLD.`discount_type`
  OR NEW.`discount_amount` IS NOT OLD.`discount_amount`
  OR NEW.`free_delivery` IS NOT OLD.`free_delivery`
  OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id`
  OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `products_checkout_authority_delete`
AFTER DELETE ON `products`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_authority_insert`
AFTER INSERT ON `product_variants`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_authority_update`
AFTER UPDATE ON `product_variants`
WHEN NEW.`product_id` IS NOT OLD.`product_id`
  OR NEW.`option_combination_key` IS NOT OLD.`option_combination_key`
  OR NEW.`image_id` IS NOT OLD.`image_id`
  OR NEW.`price` IS NOT OLD.`price`
  OR NEW.`is_default` IS NOT OLD.`is_default`
  OR NEW.`track_inventory` IS NOT OLD.`track_inventory`
  OR NEW.`allow_preorder` IS NOT OLD.`allow_preorder`
  OR NEW.`allow_backorder` IS NOT OLD.`allow_backorder`
  OR NEW.`backorder_limit` IS NOT OLD.`backorder_limit`
  OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id`
  OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version`
  OR NEW.`discount_percentage` IS NOT OLD.`discount_percentage`
  OR NEW.`discount_type` IS NOT OLD.`discount_type`
  OR NEW.`discount_amount` IS NOT OLD.`discount_amount`
  OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_authority_delete`
AFTER DELETE ON `product_variants`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_checkout_authority_insert`
AFTER INSERT ON `product_option_definitions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_checkout_authority_update`
AFTER UPDATE ON `product_option_definitions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_checkout_authority_delete`
AFTER DELETE ON `product_option_definitions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_checkout_authority_insert`
AFTER INSERT ON `product_option_values`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_checkout_authority_update`
AFTER UPDATE ON `product_option_values`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_checkout_authority_delete`
AFTER DELETE ON `product_option_values`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_checkout_authority_insert`
AFTER INSERT ON `product_variant_option_values`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_checkout_authority_update`
AFTER UPDATE ON `product_variant_option_values`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_checkout_authority_delete`
AFTER DELETE ON `product_variant_option_values`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_media_checkout_authority_insert`
AFTER INSERT ON `product_media`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_media_checkout_authority_update`
AFTER UPDATE ON `product_media`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `product_media_checkout_authority_delete`
AFTER DELETE ON `product_media`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `media_checkout_authority_update`
AFTER UPDATE ON `media`
WHEN NEW.`object_key` IS NOT OLD.`object_key`
  OR NEW.`kind` IS NOT OLD.`kind`
  OR NEW.`poster_media_id` IS NOT OLD.`poster_media_id`
  OR NEW.`status` IS NOT OLD.`status`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_locations_checkout_authority_insert`
AFTER INSERT ON `delivery_locations`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_locations_checkout_authority_update`
AFTER UPDATE ON `delivery_locations`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_locations_checkout_authority_delete`
AFTER DELETE ON `delivery_locations`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_checkout_authority_insert`
AFTER INSERT ON `shipping_methods`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_checkout_authority_update`
AFTER UPDATE ON `shipping_methods`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_checkout_authority_delete`
AFTER DELETE ON `shipping_methods`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_settings_checkout_authority_insert`
AFTER INSERT ON `tax_settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_settings_checkout_authority_update`
AFTER UPDATE ON `tax_settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_settings_checkout_authority_delete`
AFTER DELETE ON `tax_settings`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_classes_checkout_authority_insert`
AFTER INSERT ON `tax_classes`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_classes_checkout_authority_update`
AFTER UPDATE ON `tax_classes`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_classes_checkout_authority_delete`
AFTER DELETE ON `tax_classes`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_authority_insert`
AFTER INSERT ON `tax_rates`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_authority_update`
AFTER UPDATE ON `tax_rates`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_authority_delete`
AFTER DELETE ON `tax_rates`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
