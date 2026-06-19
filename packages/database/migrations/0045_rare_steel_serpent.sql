CREATE TABLE `auth_otp_delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_key` text NOT NULL,
	`purpose` text DEFAULT 'customer_login' NOT NULL,
	`method` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`identifier_hash` text NOT NULL,
	`identifier_masked` text,
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
	`otp_expires_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_otp_delivery_receipts_delivery_key_unique` ON `auth_otp_delivery_receipts` (`delivery_key`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_identifier_created_idx` ON `auth_otp_delivery_receipts` (`identifier_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_pending_idx` ON `auth_otp_delivery_receipts` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_claim_idx` ON `auth_otp_delivery_receipts` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_otp_delivery_receipts_provider_message_idx` ON `auth_otp_delivery_receipts` (`provider`,`provider_message_id`);