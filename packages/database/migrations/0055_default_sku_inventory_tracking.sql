ALTER TABLE `product_variants` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variants` ADD `track_inventory` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `inventory_tracked` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `order_items` SET `inventory_tracked` = false WHERE `variant_id` IS NULL;--> statement-breakpoint
INSERT INTO `product_variants` (
  `id`,
  `product_id`,
  `size`,
  `color`,
  `weight`,
  `sku`,
  `price`,
  `stock`,
  `reserved_stock`,
  `preorder_stock`,
  `is_default`,
  `track_inventory`,
  `version`,
  `stock_version`,
  `allow_preorder`,
  `allow_backorder`,
  `backorder_limit`,
  `discount_percentage`,
  `discount_type`,
  `discount_amount`,
  `color_sort_order`,
  `size_sort_order`,
  `created_at`,
  `updated_at`,
  `deleted_at`
)
SELECT
  'var_default_' || lower(hex(randomblob(12))),
  p.`id`,
  NULL,
  NULL,
  NULL,
  'SIMPLE-' || p.`id` || '-' || lower(substr(hex(randomblob(4)), 1, 8)),
  p.`price`,
  0,
  0,
  0,
  true,
  false,
  1,
  1,
  false,
  false,
  0,
  0,
  'percentage',
  0,
  0,
  0,
  unixepoch(),
  unixepoch(),
  NULL
FROM `products` p
WHERE p.`deleted_at` IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `product_variants` pv
    WHERE pv.`product_id` = p.`id`
      AND pv.`deleted_at` IS NULL
  );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_variants_default_idx` ON `product_variants` (`product_id`, `is_default`, `deleted_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_variants_track_inventory_idx` ON `product_variants` (`track_inventory`, `deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `product_variants_one_default_per_product_idx`
ON `product_variants` (`product_id`)
WHERE `is_default` = true AND `deleted_at` IS NULL;
