-- Billing addresses (docs/MARKETS-DESIGN.md D7, Shopify's rule). Orders gain
-- the billing-address snapshot: the canonical fields of the shipping snapshot
-- with a billing_ prefix (no Bangladesh City/Thana/Area adapter: couriers do
-- not use a billing address), and billing_same_as_shipping, true when the
-- shipping address is the billing address (the billing columns then stay
-- null). Nothing is backfilled: an order placed before 0119 has no billing
-- address (flag 0, columns null). order_tax_snapshots gains address_source:
-- the address taxed (shipping, billing or origin; null before 0119). The
-- customer address book gains is_default_billing, one per customer. The event
-- triggers of orders and of the address book are re-created with the new
-- columns (packages/database/scripts/event-outbox-triggers.ts). Orders, tax
-- snapshots and the address book are private: no cache dependency.
ALTER TABLE `orders` ADD `billing_same_as_shipping` integer DEFAULT false NOT NULL CONSTRAINT `orders_billing_same_as_shipping_flag` CHECK (`billing_same_as_shipping` IN (0, 1));
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_name` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_company` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_address` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_address_line2` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_country_code` text CONSTRAINT `orders_billing_country_shape` CHECK (`billing_country_code` IS NULL OR (length(`billing_country_code`) = 2 AND `billing_country_code` NOT GLOB '*[^A-Z]*'));
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_dependent_locality` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_locality` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_admin_area` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_postal_code` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_phone` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `billing_validation_skipped` integer DEFAULT false NOT NULL CONSTRAINT `orders_billing_validation_skipped_flag` CHECK (`billing_validation_skipped` IN (0, 1));
--> statement-breakpoint
ALTER TABLE `order_tax_snapshots` ADD `address_source` text CONSTRAINT `order_tax_snapshots_address_source_check` CHECK (`address_source` IS NULL OR `address_source` IN ('shipping', 'billing', 'origin'));
--> statement-breakpoint
ALTER TABLE `customer_addresses` ADD `is_default_billing` integer DEFAULT false NOT NULL CONSTRAINT `customer_addresses_default_billing_flag` CHECK (`is_default_billing` IN (0, 1));
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_addresses_default_billing_unique` ON `customer_addresses` (`customer_id`) WHERE "customer_addresses"."is_default_billing" = 1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `evt_orders_updated`;
--> statement-breakpoint
CREATE TRIGGER `evt_orders_updated` AFTER UPDATE ON `orders`
WHEN (OLD.`status` <> 'incomplete' AND NEW.`status` <> 'incomplete' AND (OLD.`status` IS NOT NEW.`status` OR OLD.`payment_status` IS NOT NEW.`payment_status` OR OLD.`fulfillment_status` IS NOT NEW.`fulfillment_status` OR OLD.`payment_method` IS NOT NEW.`payment_method` OR OLD.`paid_amount_minor` IS NOT NEW.`paid_amount_minor` OR OLD.`balance_due_minor` IS NOT NEW.`balance_due_minor` OR OLD.`subtotal_amount_minor` IS NOT NEW.`subtotal_amount_minor` OR OLD.`shipping_amount_minor` IS NOT NEW.`shipping_amount_minor` OR OLD.`discount_amount_minor` IS NOT NEW.`discount_amount_minor` OR OLD.`tax_amount_minor` IS NOT NEW.`tax_amount_minor` OR OLD.`total_amount_minor` IS NOT NEW.`total_amount_minor` OR OLD.`customer_name` IS NOT NEW.`customer_name` OR OLD.`customer_phone` IS NOT NEW.`customer_phone` OR OLD.`customer_email` IS NOT NEW.`customer_email` OR OLD.`customer_whatsapp` IS NOT NEW.`customer_whatsapp` OR OLD.`shipping_address` IS NOT NEW.`shipping_address` OR OLD.`shipping_address_line2` IS NOT NEW.`shipping_address_line2` OR OLD.`shipping_country_code` IS NOT NEW.`shipping_country_code` OR OLD.`shipping_dependent_locality` IS NOT NEW.`shipping_dependent_locality` OR OLD.`shipping_locality` IS NOT NEW.`shipping_locality` OR OLD.`shipping_admin_area` IS NOT NEW.`shipping_admin_area` OR OLD.`shipping_postal_code` IS NOT NEW.`shipping_postal_code` OR OLD.`shipping_company` IS NOT NEW.`shipping_company` OR OLD.`shipping_name` IS NOT NEW.`shipping_name` OR OLD.`shipping_phone` IS NOT NEW.`shipping_phone` OR OLD.`shipping_validation_skipped` IS NOT NEW.`shipping_validation_skipped` OR OLD.`city` IS NOT NEW.`city` OR OLD.`zone` IS NOT NEW.`zone` OR OLD.`area` IS NOT NEW.`area` OR OLD.`billing_same_as_shipping` IS NOT NEW.`billing_same_as_shipping` OR OLD.`billing_name` IS NOT NEW.`billing_name` OR OLD.`billing_company` IS NOT NEW.`billing_company` OR OLD.`billing_address` IS NOT NEW.`billing_address` OR OLD.`billing_address_line2` IS NOT NEW.`billing_address_line2` OR OLD.`billing_country_code` IS NOT NEW.`billing_country_code` OR OLD.`billing_dependent_locality` IS NOT NEW.`billing_dependent_locality` OR OLD.`billing_locality` IS NOT NEW.`billing_locality` OR OLD.`billing_admin_area` IS NOT NEW.`billing_admin_area` OR OLD.`billing_postal_code` IS NOT NEW.`billing_postal_code` OR OLD.`billing_phone` IS NOT NEW.`billing_phone` OR OLD.`billing_validation_skipped` IS NOT NEW.`billing_validation_skipped` OR OLD.`notes` IS NOT NEW.`notes` OR OLD.`shipping_method_id` IS NOT NEW.`shipping_method_id` OR OLD.`pickup_ready_at` IS NOT NEW.`pickup_ready_at` OR OLD.`expected_delivery` IS NOT NEW.`expected_delivery` OR OLD.`customer_id` IS NOT NEW.`customer_id` OR OLD.`channel_source` IS NOT NEW.`channel_source` OR OLD.`invoice_number` IS NOT NEW.`invoice_number` OR OLD.`archived_at` IS NOT NEW.`archived_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'order.updated', 'order', NEW.`id`, json_object('orderId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'previousPaymentStatus', OLD.`payment_status`, 'paymentStatus', NEW.`payment_status`, 'previousFulfillmentStatus', OLD.`fulfillment_status`, 'fulfillmentStatus', NEW.`fulfillment_status`));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `evt_customer_addresses_changed`;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_addresses_changed` AFTER UPDATE ON `customer_addresses`
WHEN (OLD.`customer_id` IS NOT NEW.`customer_id` OR OLD.`is_default` IS NOT NEW.`is_default` OR OLD.`is_default_billing` IS NOT NEW.`is_default_billing` OR OLD.`country_code` IS NOT NEW.`country_code` OR OLD.`name` IS NOT NEW.`name` OR OLD.`company` IS NOT NEW.`company` OR OLD.`line1` IS NOT NEW.`line1` OR OLD.`line2` IS NOT NEW.`line2` OR OLD.`dependent_locality` IS NOT NEW.`dependent_locality` OR OLD.`locality` IS NOT NEW.`locality` OR OLD.`admin_area` IS NOT NEW.`admin_area` OR OLD.`postal_code` IS NOT NEW.`postal_code` OR OLD.`phone_e164` IS NOT NEW.`phone_e164` OR OLD.`phone_raw` IS NOT NEW.`phone_raw` OR OLD.`city` IS NOT NEW.`city` OR OLD.`zone` IS NOT NEW.`zone` OR OLD.`area` IS NOT NEW.`area` OR OLD.`city_name` IS NOT NEW.`city_name` OR OLD.`zone_name` IS NOT NEW.`zone_name` OR OLD.`area_name` IS NOT NEW.`area_name` OR OLD.`validation_skipped` IS NOT NEW.`validation_skipped`)
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', NEW.`customer_id`, json_object('customerId', NEW.`customer_id`));
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (119, '0119_billing_addresses', 'bb8841b6bea9fc52dc1cbb7f01a3285128e3dfb3eb988447a97512b7af025c8a');
