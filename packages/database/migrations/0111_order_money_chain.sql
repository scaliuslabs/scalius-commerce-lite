-- Markets step 1 (docs/MARKETS-DESIGN.md D2, D3): the order money chain and
-- payment settlement, as no-ops for a single-currency store.
-- orders: currency_code stays the presentment currency (what the buyer sees
-- and pays); shop_currency, fx_rate (a decimal string: shop units per
-- presentment unit), fx_source, fx_as_of and fx_locked_until snapshot the
-- conversion checkout locked, and the *_shop_minor columns are the totals in
-- the shop currency that analytics sum. Every existing order is a
-- same-currency order: rate '1', source 'same_currency', no quote times, shop
-- amounts equal to its presentment amounts.
-- order_payments: settlement_currency, settlement_amount_minor,
-- settlement_rate and exchange_adjustment_minor record what reached the
-- merchant. Every existing movement settled as presented: same currency, same
-- amount, rate '1', no adjustment. Refunds stay in the presentment currency.
-- The backfills touch only the new columns: no event, cache dependency,
-- customer-stat or address trigger fires (each watches other columns); the
-- order search index re-reads each order row unchanged.
ALTER TABLE `order_payments` ADD `settlement_currency` text DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_payments` ADD `settlement_amount_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_payments` ADD `settlement_rate` text DEFAULT '1' NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_payments` ADD `exchange_adjustment_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `shop_currency` text DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `fx_rate` text DEFAULT '1' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `fx_source` text DEFAULT 'same_currency' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `fx_as_of` integer;
--> statement-breakpoint
ALTER TABLE `orders` ADD `fx_locked_until` integer;
--> statement-breakpoint
ALTER TABLE `orders` ADD `subtotal_shop_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `shipping_shop_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_shop_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `tax_shop_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `total_shop_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `orders` SET
  `shop_currency` = `currency_code`,
  `subtotal_shop_minor` = `subtotal_amount_minor`,
  `shipping_shop_minor` = `shipping_amount_minor`,
  `discount_shop_minor` = `discount_amount_minor`,
  `tax_shop_minor` = `tax_amount_minor`,
  `total_shop_minor` = `total_amount_minor`;
--> statement-breakpoint
UPDATE `order_payments` SET
  `settlement_currency` = `currency`,
  `settlement_amount_minor` = `amount_minor`;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (111, '0111_order_money_chain', '19d1617b34d3c5f245a316505431358960578e214440de499ab3fb33f58f6833');
