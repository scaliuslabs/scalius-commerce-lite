CREATE INDEX `order_notification_outbox_queued_idx` ON `order_notification_outbox` (`status`, `queued_at`, `created_at`);
