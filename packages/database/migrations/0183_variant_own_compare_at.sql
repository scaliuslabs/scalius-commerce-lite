-- A product with options keeps no product-level discount (buyer QA B1): each
-- SKU carries its own price and compare-at price as its own base price and
-- discount. Before this, a compare-at price typed on the product became a
-- product discount that reached every variant without one, so a variant the
-- merchant priced on its own sold below that price. Every live option SKU that
-- had no discount of its own takes the product's (buyers pay exactly what they
-- paid before), then the product's is cleared. A flat amount never exceeds the
-- SKU price, as when it was applied.
UPDATE `product_variants`
SET `discount_type` = (SELECT `p`.`discount_type` FROM `products` AS `p` WHERE `p`.`id` = `product_variants`.`product_id`),
    `discount_bps` = (SELECT CASE WHEN `p`.`discount_type` = 'percentage' THEN `p`.`discount_bps` ELSE 0 END FROM `products` AS `p` WHERE `p`.`id` = `product_variants`.`product_id`),
    `discount_amount_minor` = (SELECT CASE WHEN `p`.`discount_type` = 'flat' THEN MIN(`p`.`discount_amount_minor`, `product_variants`.`price_minor`) ELSE 0 END FROM `products` AS `p` WHERE `p`.`id` = `product_variants`.`product_id`),
    `updated_at` = unixepoch()
WHERE `is_default` = 0
  AND `deleted_at` IS NULL
  AND NOT ((`discount_type` = 'flat' AND `discount_amount_minor` > 0) OR (`discount_type` = 'percentage' AND `discount_bps` > 0))
  AND EXISTS (
    SELECT 1 FROM `products` AS `p`
    WHERE `p`.`id` = `product_variants`.`product_id`
      AND ((`p`.`discount_type` = 'flat' AND `p`.`discount_amount_minor` > 0) OR (`p`.`discount_type` = 'percentage' AND `p`.`discount_bps` > 0))
  );
--> statement-breakpoint
UPDATE `products`
SET `discount_type` = 'percentage', `discount_bps` = 0, `discount_amount_minor` = 0, `updated_at` = unixepoch()
WHERE (`discount_bps` <> 0 OR `discount_amount_minor` <> 0)
  AND EXISTS (
    SELECT 1 FROM `product_variants` AS `v`
    WHERE `v`.`product_id` = `products`.`id` AND `v`.`is_default` = 0 AND `v`.`deleted_at` IS NULL
  );
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (183, '0183_variant_own_compare_at', '2438cdbdd6d5223523c0e720e68be252f3fb35469916e8aff9357d2a6d49569d');
