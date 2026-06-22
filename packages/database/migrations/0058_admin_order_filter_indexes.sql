CREATE INDEX IF NOT EXISTS `orders_payment_queue_idx` ON `orders` (`deleted_at`, `payment_method`, `payment_status`, `updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_fulfillment_queue_idx` ON `orders` (`deleted_at`, `fulfillment_status`, `payment_status`, `updated_at`);
