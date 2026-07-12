ALTER TABLE `order_items` ADD `product_image_media_id` text REFERENCES media(id);--> statement-breakpoint
CREATE INDEX `order_items_product_image_media_id_idx` ON `order_items` (`product_image_media_id`);
--> statement-breakpoint
CREATE TRIGGER `order_items_product_image_media_insert_guard`
BEFORE INSERT ON `order_items`
WHEN NEW.`product_image_media_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `media`
    WHERE `id` = NEW.`product_image_media_id`
      AND `kind` = 'image'
      AND `status` IN ('ready', 'trashed')
  )
BEGIN
  SELECT RAISE(ABORT, 'order item image snapshot must reference a retained image');
END;
--> statement-breakpoint
CREATE TRIGGER `order_items_product_image_media_update_guard`
BEFORE UPDATE OF `product_image_media_id` ON `order_items`
WHEN NEW.`product_image_media_id` IS NOT OLD.`product_image_media_id`
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ORDER_ITEM_IMAGE_SNAPSHOT');
END;
