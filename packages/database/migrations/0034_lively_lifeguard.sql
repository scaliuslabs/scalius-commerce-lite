DROP INDEX `customer_history_customer_id_idx`;--> statement-breakpoint
CREATE INDEX `customer_history_customer_created_idx` ON `customer_history` (`customer_id`,`created_at`);--> statement-breakpoint
DROP INDEX `orders_customer_id_idx`;--> statement-breakpoint
CREATE INDEX `orders_customer_activity_idx` ON `orders` (`customer_id`,`deleted_at`,`created_at`);