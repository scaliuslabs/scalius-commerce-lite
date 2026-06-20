CREATE TABLE `payment_session_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_key` text NOT NULL,
	`order_id` text NOT NULL,
	`gateway` text NOT NULL,
	`payment_type` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`provider_session_id` text,
	`provider_correlation_id` text,
	`response_payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_session_attempts_attempt_key_unique` ON `payment_session_attempts` (`attempt_key`);--> statement-breakpoint
CREATE INDEX `payment_session_attempts_order_id_idx` ON `payment_session_attempts` (`order_id`);--> statement-breakpoint
CREATE INDEX `payment_session_attempts_status_claim_idx` ON `payment_session_attempts` (`status`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `payment_session_attempts_provider_session_idx` ON `payment_session_attempts` (`gateway`,`provider_session_id`);
