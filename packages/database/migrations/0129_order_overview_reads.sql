-- Cover the order-detail buyer review lookup and the overview's date-scoped
-- money/line/refund reads. Guest/customer history probes start at their
-- identity, not at every historical order. Index-only; replayable DDL.
CREATE INDEX IF NOT EXISTS `order_items_sales_idx` ON `order_items` (`order_id`,`id`,`quantity`,`line_subtotal_minor`,`discount_amount_minor`,`tax_amount_minor`,`fulfillment_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_payments_refund_sum_idx` ON `order_payments` (`order_id`,`payment_type`,`status`,`amount_minor`) WHERE "order_payments"."payment_type" = 'refund' AND "order_payments"."status" = 'refunded';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_overview_idx` ON `orders` (`deleted_at`,`shop_currency`,`created_at`,`id`,`status`,`payment_method`,`channel`,`channel_source`,`city_name`,`fulfillment_location_id`,`shipping_method_id`,`shipping_method_kind`,`requires_shipping`,`customer_id`,`customer_phone`,`prices_include_tax`,`shipping_amount_minor`,`discount_amount_minor`,`tax_amount_minor`,`currency_code`,`currency_decimal_places`,`fx_rate`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_customer_sales_idx` ON `orders` (`customer_id`,`deleted_at`,`created_at`,`status`) WHERE "orders"."customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_guest_sales_idx` ON `orders` (`customer_phone`,`deleted_at`,`created_at`,`status`) WHERE "orders"."customer_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_reviews_reviewer_product_idx` ON `product_reviews` (`reviewer_key`,`product_id`,`status`);
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (129, '0129_order_overview_reads', '4f41144a82c1af38c4f424420a934349dadee48fb1bd499b0911f5991d2a2f65');
