CREATE TABLE `refund_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_key` text NOT NULL,
	`refund_group_id` text NOT NULL,
	`order_id` text NOT NULL,
	`source_payment_id` text NOT NULL,
	`refund_payment_id` text NOT NULL,
	`gateway` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'BDT' NOT NULL,
	`reason` text NOT NULL,
	`request_hash` text NOT NULL,
	`provider_idempotency_key` text NOT NULL,
	`refund_reference` text NOT NULL,
	`allocation_index` integer DEFAULT 0 NOT NULL,
	`allocation_count` integer DEFAULT 1 NOT NULL,
	`source_transaction_id` text,
	`provider_refund_id` text,
	`provider_correlation_id` text,
	`provider_status` text,
	`request_payload` text,
	`response_payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_probe_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_probe_at` integer,
	`last_error` text,
	`metadata` text,
	`refunded_at` integer,
	`failed_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`source_payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refund_payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_attempt_key_unique` ON `refund_attempts` (`attempt_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_provider_idempotency_key_unique` ON `refund_attempts` (`provider_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_reference_unique` ON `refund_attempts` (`refund_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_group_allocation_unique` ON `refund_attempts` (`refund_group_id`,`allocation_index`);--> statement-breakpoint
CREATE INDEX `refund_attempts_order_id_idx` ON `refund_attempts` (`order_id`);--> statement-breakpoint
CREATE INDEX `refund_attempts_order_status_idx` ON `refund_attempts` (`order_id`,`status`);--> statement-breakpoint
CREATE INDEX `refund_attempts_status_probe_idx` ON `refund_attempts` (`status`,`next_probe_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `refund_attempts_status_claim_idx` ON `refund_attempts` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `refund_attempts_source_payment_id_idx` ON `refund_attempts` (`source_payment_id`);--> statement-breakpoint
CREATE INDEX `refund_attempts_source_payment_status_idx` ON `refund_attempts` (`source_payment_id`,`status`);--> statement-breakpoint
CREATE INDEX `refund_attempts_refund_payment_id_idx` ON `refund_attempts` (`refund_payment_id`);--> statement-breakpoint
CREATE INDEX `refund_attempts_provider_refund_idx` ON `refund_attempts` (`gateway`,`provider_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_provider_refund_unique`
ON `refund_attempts` (`gateway`,`provider_refund_id`)
WHERE `provider_refund_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_attempts_live_source_payment_singleflight`
ON `refund_attempts` (`source_payment_id`)
WHERE `status` IN ('pending','processing','provider_unknown','reconcile_required');
