DROP INDEX IF EXISTS `idx_order_payments_polar_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `order_payments_polar_checkout_idx`;
--> statement-breakpoint
ALTER TABLE `order_payments` DROP COLUMN `polar_checkout_id`;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `variant_width` integer CONSTRAINT `media_variant_width_valid` CHECK (`variant_width` IS NULL OR (`kind` = 'image' AND `variant_width` BETWEEN 1 AND 2400));
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (63, '0063_media_variants_drop_polar', 'c5b1317a03ab33940205e39cbd6217552e5322aef9291beea5fdad18ca93211e');
