-- Repair SKU-first simple-product invariants for legacy/demo rows.
-- Products are merchandising containers; product_variants are the only sellable
-- identities. A simple product must therefore have one hidden/default no-option
-- SKU, not a synthetic storefront-only "default" item.

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

UPDATE `product_variants`
SET
  `is_default` = true,
  `updated_at` = unixepoch()
WHERE `id` IN (
  SELECT pv.`id`
  FROM `product_variants` pv
  INNER JOIN `products` p ON p.`id` = pv.`product_id`
  WHERE p.`deleted_at` IS NULL
    AND pv.`deleted_at` IS NULL
    AND trim(coalesce(pv.`size`, '')) = ''
    AND trim(coalesce(pv.`color`, '')) = ''
    AND NOT EXISTS (
      SELECT 1
      FROM `product_variants` other
      WHERE other.`product_id` = pv.`product_id`
        AND other.`deleted_at` IS NULL
        AND other.`id` != pv.`id`
    )
)
  AND `is_default` = false;--> statement-breakpoint

UPDATE `product_variants`
SET
  `track_inventory` = false,
  `updated_at` = unixepoch()
WHERE `id` IN (
  SELECT pv.`id`
  FROM `product_variants` pv
  INNER JOIN `products` p ON p.`id` = pv.`product_id`
  WHERE p.`deleted_at` IS NULL
    AND pv.`deleted_at` IS NULL
    AND trim(coalesce(pv.`size`, '')) = ''
    AND trim(coalesce(pv.`color`, '')) = ''
    AND NOT EXISTS (
      SELECT 1
      FROM `product_variants` other
      WHERE other.`product_id` = pv.`product_id`
        AND other.`deleted_at` IS NULL
        AND other.`id` != pv.`id`
    )
)
  AND `track_inventory` = true
  AND `stock` = 0
  AND `reserved_stock` = 0
  AND `preorder_stock` = 0
  AND NOT EXISTS (
    SELECT 1
    FROM `inventory_movements` im
    WHERE im.`variant_id` = `product_variants`.`id`
  );
