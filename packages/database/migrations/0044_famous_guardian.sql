CREATE TABLE `order_notification_delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_key` text NOT NULL,
	`outbox_id` text NOT NULL,
	`order_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`recipient_masked` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`provider_status` text,
	`raw_response` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`last_attempt_at` integer,
	`accepted_at` integer,
	`delivered_at` integer,
	`failed_at` integer,
	`skipped_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `order_notification_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_notification_delivery_receipts_receipt_key_unique` ON `order_notification_delivery_receipts` (`receipt_key`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_outbox_id_idx` ON `order_notification_delivery_receipts` (`outbox_id`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_outbox_status_idx` ON `order_notification_delivery_receipts` (`outbox_id`,`status`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_order_id_created_at_idx` ON `order_notification_delivery_receipts` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_pending_idx` ON `order_notification_delivery_receipts` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_claim_idx` ON `order_notification_delivery_receipts` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_notification_delivery_receipts_provider_message_idx` ON `order_notification_delivery_receipts` (`provider`,`provider_message_id`);