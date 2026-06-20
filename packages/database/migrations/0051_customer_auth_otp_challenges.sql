CREATE TABLE `customer_auth_otp_challenges` (
	`otp_key` text PRIMARY KEY NOT NULL,
	`delivery_key` text NOT NULL,
	`method` text NOT NULL,
	`channel` text NOT NULL,
	`intent` text DEFAULT 'sign_in' NOT NULL,
	`identifier` text NOT NULL,
	`identifier_hash` text NOT NULL,
	`identifier_masked` text NOT NULL,
	`contact_email` text,
	`phone` text,
	`code_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`resend_available_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_auth_otp_challenges_delivery_key_unique`
ON `customer_auth_otp_challenges` (`delivery_key`);
--> statement-breakpoint
CREATE INDEX `customer_auth_otp_challenges_identifier_created_idx`
ON `customer_auth_otp_challenges` (`identifier_hash`,`created_at`);
--> statement-breakpoint
CREATE INDEX `customer_auth_otp_challenges_status_expires_idx`
ON `customer_auth_otp_challenges` (`status`,`expires_at`);
