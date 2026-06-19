-- Ensure dashboard/order-list indexes declared in schema exist on migrated D1 databases.

CREATE INDEX IF NOT EXISTS `orders_deleted_at_idx` ON `orders` (`deleted_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `orders_dashboard_agg_idx` ON `orders` (`deleted_at`,`created_at`,`status`);--> statement-breakpoint
