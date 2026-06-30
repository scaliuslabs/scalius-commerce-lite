CREATE INDEX `order_notification_delivery_receipts_provider_status_updated_idx`
ON `order_notification_delivery_receipts` (`channel`,`provider`,`status`,`updated_at`);
