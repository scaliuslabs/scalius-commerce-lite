-- A product with options sells only its option SKUs, so the server now keeps
-- its product-level price at the lowest live option SKU price (written with
-- every SKU change). Products saved before that rule are brought in line here.
UPDATE `products` SET `price_minor` = (
  SELECT MIN(`v`.`price_minor`) FROM `product_variants` AS `v`
  WHERE `v`.`product_id` = `products`.`id`
    AND `v`.`deleted_at` IS NULL
    AND `v`.`is_default` = 0
    AND trim(coalesce(`v`.`option_combination_key`, '')) <> ''
)
WHERE EXISTS (
  SELECT 1 FROM `product_variants` AS `v`
  WHERE `v`.`product_id` = `products`.`id`
    AND `v`.`deleted_at` IS NULL
    AND `v`.`is_default` = 0
    AND trim(coalesce(`v`.`option_combination_key`, '')) <> ''
);
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (77, '0077_optioned_product_price', '4e6fe06299dfaa5c0c4980454b308b76e158202a73327b375a31c1fdc83a33d0');
