-- Integer money: every stored amount becomes exactly one INTEGER column in
-- minor units (paisa for BDT). Order-scoped amounts use the order's own
-- currency decimals; catalog and shipping amounts use the store
-- currency. REAL columns and redundant *_minor twins are dropped. Existing
-- nullable *_minor columns become NOT NULL through rename/add/copy/drop so
-- no referenced table has to be rebuilt. Percentage discounts become integer
-- basis points.
CREATE TABLE `_integer_money_store` (`code` text NOT NULL, `places` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `_integer_money_store` (`code`, `places`)
SELECT store.code,
  CASE
    WHEN store.code IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
    WHEN store.code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
    ELSE 2
  END
FROM (
  SELECT coalesce(nullif(upper(trim((
    SELECT json_extract(`value`, '$.currencyCode') FROM `settings`
    WHERE `category` = 'currency' AND `key` = 'document' AND json_valid(`value`)
    LIMIT 1
  ))), ''), 'BDT') AS code
) AS store;
--> statement-breakpoint
-- orders
ALTER TABLE `orders` RENAME COLUMN `currency_code` TO `_old_currency_code`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `currency_decimal_places` TO `_old_currency_decimal_places`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `subtotal_amount_minor` TO `_old_subtotal_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `shipping_amount_minor` TO `_old_shipping_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `discount_amount_minor` TO `_old_discount_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` RENAME COLUMN `total_amount_minor` TO `_old_total_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` ADD `currency_code` text DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `currency_decimal_places` integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `subtotal_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `shipping_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `total_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `paid_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `balance_due_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `orders` SET
  `_old_currency_code` = coalesce(`_old_currency_code`, (SELECT `code` FROM `_integer_money_store`)),
  `_old_currency_decimal_places` = coalesce(`_old_currency_decimal_places`, (SELECT `places` FROM `_integer_money_store`));
--> statement-breakpoint
UPDATE `orders` SET
  `currency_code` = `_old_currency_code`,
  `currency_decimal_places` = `_old_currency_decimal_places`,
  `subtotal_amount_minor` = coalesce(`_old_subtotal_amount_minor`, (
    SELECT CAST(round(sum(item.`price` * item.`quantity`) * (CASE `orders`.`_old_currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END)) AS integer)
    FROM `order_items` AS item WHERE item.`order_id` = `orders`.`id`
  ), 0),
  `shipping_amount_minor` = coalesce(`_old_shipping_amount_minor`, CAST(round(`shipping_charge` * (CASE `_old_currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END)) AS integer)),
  `discount_amount_minor` = coalesce(`_old_discount_amount_minor`, CAST(round(coalesce(`discount_amount`, 0) * (CASE `_old_currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END)) AS integer)),
  `total_amount_minor` = coalesce(`_old_total_amount_minor`, CAST(round(`total_amount` * (CASE `_old_currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END)) AS integer)),
  `paid_amount_minor` = CAST(round(`paid_amount` * (CASE `_old_currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END)) AS integer),
  `balance_due_minor` = CAST(round(`balance_due` * (CASE `_old_currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END)) AS integer);
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_currency_code`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_currency_decimal_places`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_subtotal_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_shipping_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_discount_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `_old_total_amount_minor`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `total_amount`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `shipping_charge`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `discount_amount`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `paid_amount`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `balance_due`;
--> statement-breakpoint
-- order_items
ALTER TABLE `order_items` RENAME COLUMN `unit_price_minor` TO `_old_unit_price_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` RENAME COLUMN `line_subtotal_minor` TO `_old_line_subtotal_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` RENAME COLUMN `discount_amount_minor` TO `_old_discount_amount_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` RENAME COLUMN `taxable_amount_minor` TO `_old_taxable_amount_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `unit_price_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `line_subtotal_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `discount_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `taxable_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `order_items` SET `_old_unit_price_minor` = coalesce(`_old_unit_price_minor`, CAST(round(`price` * (
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `order_items`.`order_id`
)) AS integer), 0);
--> statement-breakpoint
UPDATE `order_items` SET
  `unit_price_minor` = `_old_unit_price_minor`,
  `line_subtotal_minor` = coalesce(`_old_line_subtotal_minor`, `_old_unit_price_minor` * `quantity`),
  `discount_amount_minor` = coalesce(`_old_discount_amount_minor`, 0),
  `taxable_amount_minor` = coalesce(`_old_taxable_amount_minor`, max(0, coalesce(`_old_line_subtotal_minor`, `_old_unit_price_minor` * `quantity`) - coalesce(`_old_discount_amount_minor`, 0)));
--> statement-breakpoint
ALTER TABLE `order_items` DROP COLUMN `_old_unit_price_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` DROP COLUMN `_old_line_subtotal_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` DROP COLUMN `_old_discount_amount_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` DROP COLUMN `_old_taxable_amount_minor`;
--> statement-breakpoint
ALTER TABLE `order_items` DROP COLUMN `price`;
--> statement-breakpoint
-- order-scoped amounts converted with the parent order's decimals
ALTER TABLE `checkout_attempts` ADD `total_amount_minor` integer;
--> statement-breakpoint
UPDATE `checkout_attempts` SET `total_amount_minor` = CAST(round(`total_amount` * coalesce((
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `checkout_attempts`.`order_id`
), 100)) AS integer) WHERE `total_amount` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `checkout_attempts` DROP COLUMN `total_amount`;
--> statement-breakpoint
ALTER TABLE `order_payments` ADD `amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `order_payments` SET `amount_minor` = CAST(round(`amount` * (
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `order_payments`.`order_id`
)) AS integer);
--> statement-breakpoint
ALTER TABLE `order_payments` DROP COLUMN `amount`;
--> statement-breakpoint
ALTER TABLE `payment_session_attempts` ADD `amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `payment_session_attempts` SET `amount_minor` = CAST(round(`amount` * (
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `payment_session_attempts`.`order_id`
)) AS integer);
--> statement-breakpoint
ALTER TABLE `payment_session_attempts` DROP COLUMN `amount`;
--> statement-breakpoint
ALTER TABLE `refund_attempts` ADD `amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `refund_attempts` SET `amount_minor` = CAST(round(`amount` * (
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `refund_attempts`.`order_id`
)) AS integer);
--> statement-breakpoint
ALTER TABLE `refund_attempts` DROP COLUMN `amount`;
--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `total_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `deposit_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `balance_due_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `payment_plans` SET
  `total_amount_minor` = CAST(round(`total_amount` * (SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `payment_plans`.`order_id`)) AS integer),
  `deposit_amount_minor` = CAST(round(`deposit_amount` * (SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `payment_plans`.`order_id`)) AS integer),
  `balance_due_minor` = CAST(round(`balance_due` * (SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `payment_plans`.`order_id`)) AS integer);
--> statement-breakpoint
ALTER TABLE `payment_plans` DROP COLUMN `total_amount`;
--> statement-breakpoint
ALTER TABLE `payment_plans` DROP COLUMN `deposit_amount`;
--> statement-breakpoint
ALTER TABLE `payment_plans` DROP COLUMN `balance_due`;
--> statement-breakpoint
ALTER TABLE `cod_tracking` ADD `collected_amount_minor` integer;
--> statement-breakpoint
UPDATE `cod_tracking` SET `collected_amount_minor` = CAST(round(`collected_amount` * (
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `cod_tracking`.`order_id`
)) AS integer) WHERE `collected_amount` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `cod_tracking` DROP COLUMN `collected_amount`;
--> statement-breakpoint
ALTER TABLE `delivery_shipments` ADD `shipment_amount_minor` integer;
--> statement-breakpoint
UPDATE `delivery_shipments` SET `shipment_amount_minor` = CAST(round(`shipment_amount` * (
  SELECT CASE o.`currency_decimal_places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `orders` AS o WHERE o.`id` = `delivery_shipments`.`order_id`
)) AS integer) WHERE `shipment_amount` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `delivery_shipments` DROP COLUMN `shipment_amount`;
--> statement-breakpoint
-- tax snapshots keep the rules; their amount copies duplicated orders/order_items
CREATE TABLE `__new_order_tax_snapshots` (
	`order_id` text PRIMARY KEY NOT NULL,
	`currency_code` text NOT NULL,
	`decimal_places` integer NOT NULL,
	`display_label` text NOT NULL,
	`prices_include_tax` integer NOT NULL,
	`shipping_taxed` integer NOT NULL,
	`settings_version` integer NOT NULL,
	`calculation_version` text NOT NULL,
	`destination_snapshot` text NOT NULL,
	`rate_snapshot` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_tax_snapshots_decimal_places_range" CHECK("__new_order_tax_snapshots"."decimal_places" BETWEEN 0 AND 3),
	CONSTRAINT "order_tax_snapshots_display_label_length" CHECK(length("__new_order_tax_snapshots"."display_label") BETWEEN 1 AND 80),
	CONSTRAINT "order_tax_snapshots_settings_version_nonnegative" CHECK("__new_order_tax_snapshots"."settings_version" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_order_tax_snapshots` (`order_id`, `currency_code`, `decimal_places`, `display_label`, `prices_include_tax`, `shipping_taxed`, `settings_version`, `calculation_version`, `destination_snapshot`, `rate_snapshot`, `created_at`)
SELECT `order_id`, `currency_code`, `decimal_places`, `display_label`, `prices_include_tax`, `shipping_taxed`, `settings_version`, `calculation_version`, `destination_snapshot`, `rate_snapshot`, `created_at` FROM `order_tax_snapshots`;
--> statement-breakpoint
DROP TABLE `order_tax_snapshots`;
--> statement-breakpoint
ALTER TABLE `__new_order_tax_snapshots` RENAME TO `order_tax_snapshots`;
--> statement-breakpoint
CREATE INDEX `order_tax_snapshots_created_idx` ON `order_tax_snapshots` (`created_at`);
--> statement-breakpoint
CREATE TABLE `__new_order_item_tax_snapshots` (
	`order_item_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`tax_class_id` text,
	`tax_class_name` text,
	`prices_include_tax` integer NOT NULL,
	`rate_snapshot` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_item_tax_snapshots` (`order_item_id`, `order_id`, `tax_class_id`, `tax_class_name`, `prices_include_tax`, `rate_snapshot`, `created_at`)
SELECT `order_item_id`, `order_id`, `tax_class_id`, `tax_class_name`, `prices_include_tax`, `rate_snapshot`, `created_at` FROM `order_item_tax_snapshots`;
--> statement-breakpoint
DROP TABLE `order_item_tax_snapshots`;
--> statement-breakpoint
ALTER TABLE `__new_order_item_tax_snapshots` RENAME TO `order_item_tax_snapshots`;
--> statement-breakpoint
CREATE INDEX `order_item_tax_snapshots_order_idx` ON `order_item_tax_snapshots` (`order_id`);
--> statement-breakpoint
-- customers.total_spent duplicated SUM(orders.paid_amount_minor); readers already derive it.
ALTER TABLE `customers` DROP COLUMN `total_spent`;
--> statement-breakpoint
-- store-currency amounts
ALTER TABLE `shipping_methods` ADD `fee_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `shipping_methods` SET `fee_minor` = CAST(round(`fee` * (
  SELECT CASE `places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `_integer_money_store`
)) AS integer);
--> statement-breakpoint
ALTER TABLE `shipping_methods` DROP COLUMN `fee`;
--> statement-breakpoint
DROP TRIGGER `products_checkout_authority_update`;
--> statement-breakpoint
ALTER TABLE `products` ADD `price_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `discount_bps` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `discount_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `products` SET
  `price_minor` = CAST(round(`price` * (SELECT CASE `places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `_integer_money_store`)) AS integer),
  `discount_bps` = min(10000, max(0, CAST(round(coalesce(`discount_percentage`, 0) * 100) AS integer))),
  `discount_amount_minor` = max(0, CAST(round(coalesce(`discount_amount`, 0) * (SELECT CASE `places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `_integer_money_store`)) AS integer));
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `price`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `discount_percentage`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `discount_amount`;
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
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
DROP TRIGGER `product_variants_checkout_authority_update`;
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `price_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `discount_bps` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `product_variants` ADD `discount_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `product_variants` SET
  `price_minor` = CAST(round(`price` * (SELECT CASE `places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `_integer_money_store`)) AS integer),
  `discount_bps` = min(10000, max(0, CAST(round(coalesce(`discount_percentage`, 0) * 100) AS integer))),
  `discount_amount_minor` = max(0, CAST(round(coalesce(`discount_amount`, 0) * (SELECT CASE `places` WHEN 0 THEN 1 WHEN 3 THEN 1000 ELSE 100 END FROM `_integer_money_store`)) AS integer));
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `price`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `discount_percentage`;
--> statement-breakpoint
ALTER TABLE `product_variants` DROP COLUMN `discount_amount`;
--> statement-breakpoint
CREATE TRIGGER `product_variants_checkout_authority_update`
AFTER UPDATE ON `product_variants`
WHEN NEW.`product_id` IS NOT OLD.`product_id`
  OR NEW.`option_combination_key` IS NOT OLD.`option_combination_key`
  OR NEW.`image_id` IS NOT OLD.`image_id`
  OR NEW.`price_minor` IS NOT OLD.`price_minor`
  OR NEW.`is_default` IS NOT OLD.`is_default`
  OR NEW.`track_inventory` IS NOT OLD.`track_inventory`
  OR NEW.`allow_preorder` IS NOT OLD.`allow_preorder`
  OR NEW.`allow_backorder` IS NOT OLD.`allow_backorder`
  OR NEW.`backorder_limit` IS NOT OLD.`backorder_limit`
  OR NEW.`tax_class_id` IS NOT OLD.`tax_class_id`
  OR NEW.`tax_classification_version` IS NOT OLD.`tax_classification_version`
  OR NEW.`discount_bps` IS NOT OLD.`discount_bps`
  OR NEW.`discount_type` IS NOT OLD.`discount_type`
  OR NEW.`discount_amount_minor` IS NOT OLD.`discount_amount_minor`
  OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
DROP TABLE `_integer_money_store`;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (69, '0069_integer_money', '852add8cc9569b0f85a12fefb59f2e0d863bca2fb4c248768de79f9d2b274737');
