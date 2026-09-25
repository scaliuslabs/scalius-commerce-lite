-- Line-item properties (Wave A §3, §5.3). Expand-only. A product may ask the
-- buyer for inputs (`customization_schema`, validated by
-- packages/shared/src/line-properties.ts); a change to it fences in-flight
-- checkouts like any other price-relevant product column. An order line
-- freezes the resolved properties, their surcharge and its base unit price;
-- the snapshot is immutable (an amendment replaces the line). Historical
-- lines have no properties, so their base price is their unit price.
ALTER TABLE `products` ADD `customization_schema` text CONSTRAINT `products_customization_schema_check` CHECK (`customization_schema` IS NULL OR (json_valid(`customization_schema`) AND length(`customization_schema`) <= 4096));
--> statement-breakpoint
DROP TRIGGER `products_checkout_authority_update`;
--> statement-breakpoint
CREATE TRIGGER `products_checkout_authority_update`
AFTER UPDATE ON `products`
WHEN NEW.`name` IS NOT OLD.`name`
  OR NEW.`price_minor` IS NOT OLD.`price_minor`
  OR NEW.`category_id` IS NOT OLD.`category_id`
  OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
  OR NEW.`is_active` IS NOT OLD.`is_active`
  OR NEW.`discount_bps` IS NOT OLD.`discount_bps`
  OR NEW.`discount_type` IS NOT OLD.`discount_type`
  OR NEW.`discount_amount_minor` IS NOT OLD.`discount_amount_minor`
  OR NEW.`free_delivery` IS NOT OLD.`free_delivery`
  OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id`
  OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version`
  OR NEW.`is_gift_card` IS NOT OLD.`is_gift_card`
  OR NEW.`customization_schema` IS NOT OLD.`customization_schema`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `properties` text CONSTRAINT `order_items_properties_check` CHECK (`properties` IS NULL OR (json_valid(`properties`) AND length(`properties`) <= 65536));
--> statement-breakpoint
ALTER TABLE `order_items` ADD `properties_price_minor` integer DEFAULT 0 NOT NULL CONSTRAINT `order_items_properties_price_nonnegative` CHECK (`properties_price_minor` >= 0);
--> statement-breakpoint
ALTER TABLE `order_items` ADD `base_unit_price_minor` integer;
--> statement-breakpoint
UPDATE `order_items` SET `base_unit_price_minor` = `unit_price_minor`;
--> statement-breakpoint
CREATE TRIGGER `order_items_properties_immutable`
BEFORE UPDATE OF `properties`, `properties_price_minor` ON `order_items`
WHEN NEW.`properties` IS NOT OLD.`properties`
  OR NEW.`properties_price_minor` IS NOT OLD.`properties_price_minor`
BEGIN
  SELECT RAISE(ABORT, 'order line properties are immutable');
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (84, '0084_line_item_properties', '1f42c2521eea8cde9cf60290b46498b3f2e54099c8218dcd3781ee47c1da5aac');
