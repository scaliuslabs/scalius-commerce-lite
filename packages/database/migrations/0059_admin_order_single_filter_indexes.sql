CREATE INDEX IF NOT EXISTS `orders_payment_status_list_idx` ON `orders` (`deleted_at`, `payment_status`, `updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_payment_method_list_idx` ON `orders` (`deleted_at`, `payment_method`, `updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_fulfillment_list_idx` ON `orders` (`deleted_at`, `fulfillment_status`, `updated_at`);
