-- A kit's availability counts its items' products: an item whose product is
-- deactivated, deleted, made a gift card or unpublished from the online store
-- stops the kit. Those writes now queue the kit for its projection refresh, as
-- a stock change of the item's SKU and a flip of its product's buyer state
-- already do (0224): the refresh moves the kit's band, which advances the
-- kit's own cache key. Before, a write to the item's product row alone left
-- the kit's cards and pages reading it as available.
CREATE TRIGGER `products_kit_items_queue`
AFTER UPDATE OF `is_active`, `deleted_at`, `is_gift_card` ON `products`
WHEN (OLD.`is_active` IS NOT NEW.`is_active` OR OLD.`deleted_at` IS NOT NEW.`deleted_at` OR OLD.`is_gift_card` IS NOT NEW.`is_gift_card`)
  AND EXISTS (
  SELECT 1 FROM `product_variants` AS queued_sku
  INNER JOIN `variant_components` AS queued_part ON queued_part.`component_variant_id` = queued_sku.`id`
  WHERE queued_sku.`product_id` = NEW.`id`
)
BEGIN
  INSERT INTO `system_kv` (`key`, `value`)
  SELECT 'catalog:kit-items:' || queued_sku.`id`, '1|' FROM `product_variants` AS queued_sku
  WHERE queued_sku.`product_id` = NEW.`id`
    AND EXISTS (SELECT 1 FROM `variant_components` AS queued_part WHERE queued_part.`component_variant_id` = queued_sku.`id`)
  ON CONFLICT (`key`) DO UPDATE SET `value` = (CAST(substr(`system_kv`.`value`, 1, instr(`system_kv`.`value`, '|') - 1) AS INTEGER) + 1) || '|';
END;
--> statement-breakpoint
CREATE TRIGGER `product_channel_publications_kit_items_queue_ins`
AFTER INSERT ON `product_channel_publications`
WHEN NEW.`channel_id` = 'sc_online_store' AND EXISTS (
  SELECT 1 FROM `product_variants` AS queued_sku
  INNER JOIN `variant_components` AS queued_part ON queued_part.`component_variant_id` = queued_sku.`id`
  WHERE queued_sku.`product_id` = NEW.`product_id`
)
BEGIN
  INSERT INTO `system_kv` (`key`, `value`)
  SELECT 'catalog:kit-items:' || queued_sku.`id`, '1|' FROM `product_variants` AS queued_sku
  WHERE queued_sku.`product_id` = NEW.`product_id`
    AND EXISTS (SELECT 1 FROM `variant_components` AS queued_part WHERE queued_part.`component_variant_id` = queued_sku.`id`)
  ON CONFLICT (`key`) DO UPDATE SET `value` = (CAST(substr(`system_kv`.`value`, 1, instr(`system_kv`.`value`, '|') - 1) AS INTEGER) + 1) || '|';
END;
--> statement-breakpoint
CREATE TRIGGER `product_channel_publications_kit_items_queue_upd`
AFTER UPDATE OF `unpublished_at` ON `product_channel_publications`
WHEN NEW.`channel_id` = 'sc_online_store' AND OLD.`unpublished_at` IS NOT NEW.`unpublished_at` AND EXISTS (
  SELECT 1 FROM `product_variants` AS queued_sku
  INNER JOIN `variant_components` AS queued_part ON queued_part.`component_variant_id` = queued_sku.`id`
  WHERE queued_sku.`product_id` = NEW.`product_id`
)
BEGIN
  INSERT INTO `system_kv` (`key`, `value`)
  SELECT 'catalog:kit-items:' || queued_sku.`id`, '1|' FROM `product_variants` AS queued_sku
  WHERE queued_sku.`product_id` = NEW.`product_id`
    AND EXISTS (SELECT 1 FROM `variant_components` AS queued_part WHERE queued_part.`component_variant_id` = queued_sku.`id`)
  ON CONFLICT (`key`) DO UPDATE SET `value` = (CAST(substr(`system_kv`.`value`, 1, instr(`system_kv`.`value`, '|') - 1) AS INTEGER) + 1) || '|';
END;
--> statement-breakpoint
CREATE TRIGGER `product_channel_publications_kit_items_queue_del`
AFTER DELETE ON `product_channel_publications`
WHEN OLD.`channel_id` = 'sc_online_store' AND EXISTS (
  SELECT 1 FROM `product_variants` AS queued_sku
  INNER JOIN `variant_components` AS queued_part ON queued_part.`component_variant_id` = queued_sku.`id`
  WHERE queued_sku.`product_id` = OLD.`product_id`
)
BEGIN
  INSERT INTO `system_kv` (`key`, `value`)
  SELECT 'catalog:kit-items:' || queued_sku.`id`, '1|' FROM `product_variants` AS queued_sku
  WHERE queued_sku.`product_id` = OLD.`product_id`
    AND EXISTS (SELECT 1 FROM `variant_components` AS queued_part WHERE queued_part.`component_variant_id` = queued_sku.`id`)
  ON CONFLICT (`key`) DO UPDATE SET `value` = (CAST(substr(`system_kv`.`value`, 1, instr(`system_kv`.`value`, '|') - 1) AS INTEGER) + 1) || '|';
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (229, '0229_kit_item_product_queue', '81248dd4d5544992cc618159062f4c10de1875ae960095ee202b8247ed329025');
