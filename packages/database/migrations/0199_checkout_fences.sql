-- The checkout fence (scripts/checkout-fence-triggers.ts; regenerate with --write).
-- checkout_authority was one store-wide revision that about 70 triggers
-- advanced, so any staff save (a push token, an analytics setting, another
-- product's price) sent every in-flight checkout back to its cart, and every
-- write serialized on that row. Each change now advances only its own scope:
-- the product, the settings document, or shipping, tax or markets. A checkout
-- reads the scopes it priced against and its commit refuses only when one of
-- them moved. A scope with no row is revision 0. Not buyer-visible.
DROP TRIGGER IF EXISTS `admin_fcm_tokens_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `admin_fcm_tokens_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `admin_fcm_tokens_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zone_locations_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zone_locations_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zone_locations_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zone_regions_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zone_regions_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zone_regions_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zones_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zones_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `delivery_zones_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `market_countries_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `market_countries_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `market_countries_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `markets_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `media_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `places_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `places_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `places_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `price_list_prices_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `price_list_prices_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `price_list_prices_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `price_lists_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `price_lists_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `price_lists_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_bundles_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_bundles_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_bundles_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_channel_publications_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_channel_publications_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_media_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_media_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_media_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_option_definitions_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_option_definitions_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_option_definitions_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_option_values_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_option_values_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_option_values_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variant_option_values_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variant_option_values_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variant_option_values_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `sales_channels_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `settings_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `settings_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `settings_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `shipping_methods_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `shipping_methods_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `shipping_methods_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_classes_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_classes_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_classes_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_rates_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_rates_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_rates_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_regions_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_regions_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_regions_checkout_authority_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_settings_checkout_authority_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_settings_checkout_authority_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tax_settings_checkout_authority_delete`;
--> statement-breakpoint
DROP TABLE `checkout_authority`;
--> statement-breakpoint
CREATE TABLE `checkout_fences` (
	`scope` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "checkout_fences_revision_positive" CHECK("checkout_fences"."revision" >= 1)
);
--> statement-breakpoint
CREATE TRIGGER `products_checkout_fence_update`
AFTER UPDATE ON `products`
WHEN NEW.`name` IS NOT OLD.`name` OR NEW.`price_minor` IS NOT OLD.`price_minor` OR NEW.`category_id` IS NOT OLD.`category_id` OR NEW.`deleted_at` IS NOT OLD.`deleted_at` OR NEW.`is_active` IS NOT OLD.`is_active` OR NEW.`discount_bps` IS NOT OLD.`discount_bps` OR NEW.`discount_type` IS NOT OLD.`discount_type` OR NEW.`discount_amount_minor` IS NOT OLD.`discount_amount_minor` OR NEW.`free_delivery` IS NOT OLD.`free_delivery` OR NEW.`shipping_profile_id` IS NOT OLD.`shipping_profile_id` OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id` OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version` OR NEW.`is_gift_card` IS NOT OLD.`is_gift_card` OR NEW.`customization_schema` IS NOT OLD.`customization_schema`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || NEW.`id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `products_checkout_fence_delete`
AFTER DELETE ON `products`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || OLD.`id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_fence_insert`
AFTER INSERT ON `product_variants`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || NEW.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_fence_update`
AFTER UPDATE ON `product_variants`
WHEN NEW.`product_id` IS NOT OLD.`product_id` OR NEW.`option_combination_key` IS NOT OLD.`option_combination_key` OR NEW.`image_id` IS NOT OLD.`image_id` OR NEW.`price_minor` IS NOT OLD.`price_minor` OR NEW.`weight` IS NOT OLD.`weight` OR NEW.`is_default` IS NOT OLD.`is_default` OR NEW.`track_inventory` IS NOT OLD.`track_inventory` OR NEW.`allow_preorder` IS NOT OLD.`allow_preorder` OR NEW.`allow_backorder` IS NOT OLD.`allow_backorder` OR NEW.`backorder_limit` IS NOT OLD.`backorder_limit` OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id` OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version` OR NEW.`discount_bps` IS NOT OLD.`discount_bps` OR NEW.`discount_type` IS NOT OLD.`discount_type` OR NEW.`discount_amount_minor` IS NOT OLD.`discount_amount_minor` OR NEW.`deleted_at` IS NOT OLD.`deleted_at` OR NEW.`fulfillment_kind` IS NOT OLD.`fulfillment_kind`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT `fence_scope`.`scope`, 1 FROM (SELECT 'product:' || NEW.`product_id` AS `scope` UNION SELECT 'product:' || OLD.`product_id`) AS `fence_scope` WHERE `fence_scope`.`scope` IS NOT NULL ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_fence_delete`
AFTER DELETE ON `product_variants`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || OLD.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_bundles_checkout_fence_insert`
AFTER INSERT ON `product_bundles`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || NEW.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_bundles_checkout_fence_update`
AFTER UPDATE ON `product_bundles`
WHEN NEW.`product_id` IS NOT OLD.`product_id` OR NEW.`quantity` IS NOT OLD.`quantity` OR NEW.`discount_type` IS NOT OLD.`discount_type` OR NEW.`discount_bps` IS NOT OLD.`discount_bps` OR NEW.`price_minor` IS NOT OLD.`price_minor` OR NEW.`is_active` IS NOT OLD.`is_active`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT `fence_scope`.`scope`, 1 FROM (SELECT 'product:' || NEW.`product_id` AS `scope` UNION SELECT 'product:' || OLD.`product_id`) AS `fence_scope` WHERE `fence_scope`.`scope` IS NOT NULL ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_bundles_checkout_fence_delete`
AFTER DELETE ON `product_bundles`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || OLD.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_channel_publications_checkout_fence_update`
AFTER UPDATE OF `unpublished_at`, `channel_id`, `product_id` ON `product_channel_publications`
WHEN OLD.`unpublished_at` IS NULL AND (NEW.`unpublished_at` IS NOT NULL OR NEW.`channel_id` IS NOT OLD.`channel_id` OR NEW.`product_id` IS NOT OLD.`product_id`)
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT `fence_scope`.`scope`, 1 FROM (SELECT 'product:' || NEW.`product_id` AS `scope` UNION SELECT 'product:' || OLD.`product_id`) AS `fence_scope` WHERE `fence_scope`.`scope` IS NOT NULL ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_channel_publications_checkout_fence_delete`
AFTER DELETE ON `product_channel_publications`
WHEN OLD.`unpublished_at` IS NULL
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || OLD.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_checkout_fence_insert`
AFTER INSERT ON `product_option_definitions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || NEW.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_checkout_fence_update`
AFTER UPDATE ON `product_option_definitions`
WHEN NEW.`product_id` IS NOT OLD.`product_id` OR NEW.`name` IS NOT OLD.`name` OR NEW.`normalized_name` IS NOT OLD.`normalized_name` OR NEW.`position` IS NOT OLD.`position` OR NEW.`standard_mapping` IS NOT OLD.`standard_mapping` OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT `fence_scope`.`scope`, 1 FROM (SELECT 'product:' || NEW.`product_id` AS `scope` UNION SELECT 'product:' || OLD.`product_id`) AS `fence_scope` WHERE `fence_scope`.`scope` IS NOT NULL ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_definitions_checkout_fence_delete`
AFTER DELETE ON `product_option_definitions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('product:' || OLD.`product_id`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_checkout_fence_insert`
AFTER INSERT ON `product_option_values`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_option_definitions` AS `fence_source` WHERE `fence_source`.`id` = NEW.`option_definition_id` ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_checkout_fence_update`
AFTER UPDATE ON `product_option_values`
WHEN NEW.`option_definition_id` IS NOT OLD.`option_definition_id` OR NEW.`value` IS NOT OLD.`value` OR NEW.`normalized_value` IS NOT OLD.`normalized_value` OR NEW.`position` IS NOT OLD.`position` OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_option_definitions` AS `fence_source` WHERE `fence_source`.`id` IN (NEW.`option_definition_id`, OLD.`option_definition_id`) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_option_values_checkout_fence_delete`
AFTER DELETE ON `product_option_values`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_option_definitions` AS `fence_source` WHERE `fence_source`.`id` = OLD.`option_definition_id` ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_checkout_fence_insert`
AFTER INSERT ON `product_variant_option_values`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_variants` AS `fence_source` WHERE `fence_source`.`id` = NEW.`variant_id` ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_checkout_fence_update`
AFTER UPDATE ON `product_variant_option_values`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_variants` AS `fence_source` WHERE `fence_source`.`id` IN (NEW.`variant_id`, OLD.`variant_id`) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_checkout_fence_delete`
AFTER DELETE ON `product_variant_option_values`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_variants` AS `fence_source` WHERE `fence_source`.`id` = OLD.`variant_id` ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `price_list_prices_checkout_fence_insert`
AFTER INSERT ON `price_list_prices`
WHEN EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` = NEW.`price_list_id` AND `price_lists`.`status` = 'active')
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_variants` AS `fence_source` WHERE `fence_source`.`id` = NEW.`variant_id` ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `price_list_prices_checkout_fence_update`
AFTER UPDATE ON `price_list_prices`
WHEN EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` IN (NEW.`price_list_id`, OLD.`price_list_id`) AND `price_lists`.`status` = 'active')
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_variants` AS `fence_source` WHERE `fence_source`.`id` IN (NEW.`variant_id`, OLD.`variant_id`) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `price_list_prices_checkout_fence_delete`
AFTER DELETE ON `price_list_prices`
WHEN EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` = OLD.`price_list_id` AND `price_lists`.`status` = 'active')
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT DISTINCT 'product:' || `fence_source`.`product_id`, 1 FROM `product_variants` AS `fence_source` WHERE `fence_source`.`id` = OLD.`variant_id` ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `settings_checkout_fence_insert`
AFTER INSERT ON `settings`
WHEN NEW.`key` = 'document'
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('settings:' || NEW.`category`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `settings_checkout_fence_update`
AFTER UPDATE ON `settings`
WHEN (NEW.`key` = 'document' OR OLD.`key` = 'document') AND (NEW.`key` IS NOT OLD.`key` OR NEW.`value` IS NOT OLD.`value` OR NEW.`type` IS NOT OLD.`type` OR NEW.`category` IS NOT OLD.`category` OR NEW.`expires_at` IS NOT OLD.`expires_at`)
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) SELECT `fence_scope`.`scope`, 1 FROM (SELECT 'settings:' || NEW.`category` AS `scope` UNION SELECT 'settings:' || OLD.`category`) AS `fence_scope` WHERE `fence_scope`.`scope` IS NOT NULL ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `settings_checkout_fence_delete`
AFTER DELETE ON `settings`
WHEN OLD.`key` = 'document'
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('settings:' || OLD.`category`, 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_checkout_fence_insert`
AFTER INSERT ON `shipping_methods`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_checkout_fence_update`
AFTER UPDATE ON `shipping_methods`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_checkout_fence_delete`
AFTER DELETE ON `shipping_methods`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zones_checkout_fence_insert`
AFTER INSERT ON `delivery_zones`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zones_checkout_fence_update`
AFTER UPDATE ON `delivery_zones`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zones_checkout_fence_delete`
AFTER DELETE ON `delivery_zones`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_regions_checkout_fence_insert`
AFTER INSERT ON `delivery_zone_regions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_regions_checkout_fence_update`
AFTER UPDATE ON `delivery_zone_regions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_regions_checkout_fence_delete`
AFTER DELETE ON `delivery_zone_regions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_locations_checkout_fence_insert`
AFTER INSERT ON `delivery_zone_locations`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_locations_checkout_fence_update`
AFTER UPDATE ON `delivery_zone_locations`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_locations_checkout_fence_delete`
AFTER DELETE ON `delivery_zone_locations`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_profiles_checkout_fence_insert`
AFTER INSERT ON `shipping_profiles`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_profiles_checkout_fence_update`
AFTER UPDATE ON `shipping_profiles`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_profiles_checkout_fence_delete`
AFTER DELETE ON `shipping_profiles`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_profile_rates_checkout_fence_insert`
AFTER INSERT ON `shipping_profile_rates`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_profile_rates_checkout_fence_update`
AFTER UPDATE ON `shipping_profile_rates`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_profile_rates_checkout_fence_delete`
AFTER DELETE ON `shipping_profile_rates`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `places_checkout_fence_insert`
AFTER INSERT ON `places`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `places_checkout_fence_update`
AFTER UPDATE ON `places`
WHEN NEW.`name` IS NOT OLD.`name` OR NEW.`parent_id` IS NOT OLD.`parent_id` OR NEW.`level` IS NOT OLD.`level` OR NEW.`country_code` IS NOT OLD.`country_code` OR NEW.`is_active` IS NOT OLD.`is_active` OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `places_checkout_fence_delete`
AFTER DELETE ON `places`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('shipping', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_classes_checkout_fence_insert`
AFTER INSERT ON `tax_classes`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_classes_checkout_fence_update`
AFTER UPDATE ON `tax_classes`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_classes_checkout_fence_delete`
AFTER DELETE ON `tax_classes`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_fence_insert`
AFTER INSERT ON `tax_rates`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_fence_update`
AFTER UPDATE ON `tax_rates`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_fence_delete`
AFTER DELETE ON `tax_rates`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_checkout_fence_insert`
AFTER INSERT ON `tax_regions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_checkout_fence_update`
AFTER UPDATE ON `tax_regions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_checkout_fence_delete`
AFTER DELETE ON `tax_regions`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_settings_checkout_fence_insert`
AFTER INSERT ON `tax_settings`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_settings_checkout_fence_update`
AFTER UPDATE ON `tax_settings`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tax_settings_checkout_fence_delete`
AFTER DELETE ON `tax_settings`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_locations_checkout_fence_insert`
AFTER INSERT ON `inventory_locations`
WHEN NEW.`is_default` = 1
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_locations_checkout_fence_update`
AFTER UPDATE ON `inventory_locations`
WHEN (NEW.`is_default` = 1 OR OLD.`is_default` = 1) AND (NEW.`country_code` IS NOT OLD.`country_code` OR NEW.`is_default` IS NOT OLD.`is_default` OR NEW.`status` IS NOT OLD.`status`)
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_locations_checkout_fence_delete`
AFTER DELETE ON `inventory_locations`
WHEN OLD.`is_default` = 1
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('tax', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `markets_checkout_fence_update`
AFTER UPDATE ON `markets`
WHEN NEW.`status` IS NOT OLD.`status` OR NEW.`is_backup` IS NOT OLD.`is_backup` OR NEW.`price_increment_minor` IS NOT OLD.`price_increment_minor` OR NEW.`prices_include_tax` IS NOT OLD.`prices_include_tax` OR NEW.`price_mode` IS NOT OLD.`price_mode` OR NEW.`fx_rate` IS NOT OLD.`fx_rate` OR NEW.`price_adjustment_bps` IS NOT OLD.`price_adjustment_bps` OR NEW.`price_rounding_minor` IS NOT OLD.`price_rounding_minor` OR NEW.`price_ending_minor` IS NOT OLD.`price_ending_minor` OR NEW.`currency_code` IS NOT OLD.`currency_code` OR NEW.`fx_lock_minutes` IS NOT OLD.`fx_lock_minutes`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `market_countries_checkout_fence_insert`
AFTER INSERT ON `market_countries`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `market_countries_checkout_fence_update`
AFTER UPDATE ON `market_countries`
WHEN NEW.`market_id` IS NOT OLD.`market_id` OR NEW.`country_code` IS NOT OLD.`country_code`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `market_countries_checkout_fence_delete`
AFTER DELETE ON `market_countries`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `price_lists_checkout_fence_insert`
AFTER INSERT ON `price_lists`
WHEN NEW.`status` = 'active'
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `price_lists_checkout_fence_update`
AFTER UPDATE ON `price_lists`
WHEN (OLD.`status` = 'active' OR NEW.`status` = 'active') AND (NEW.`status` IS NOT OLD.`status` OR NEW.`kind` IS NOT OLD.`kind` OR NEW.`market_id` IS NOT OLD.`market_id` OR NEW.`segment_id` IS NOT OLD.`segment_id` OR NEW.`starts_at` IS NOT OLD.`starts_at` OR NEW.`ends_at` IS NOT OLD.`ends_at` OR NEW.`priority` IS NOT OLD.`priority`)
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `price_lists_checkout_fence_delete`
AFTER DELETE ON `price_lists`
WHEN OLD.`status` = 'active'
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `sales_channels_checkout_fence_update`
AFTER UPDATE OF `status` ON `sales_channels`
WHEN NEW.`status` IS NOT OLD.`status`
BEGIN
  INSERT INTO `checkout_fences` (`scope`, `revision`) VALUES ('markets', 1) ON CONFLICT (`scope`) DO UPDATE SET `revision` = `checkout_fences`.`revision` + 1;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (199, '0199_checkout_fences', '290d8eaaa2c57d006e40947134d459508b9be4072bb3dd40fbfbfe090a3dbe7a');
