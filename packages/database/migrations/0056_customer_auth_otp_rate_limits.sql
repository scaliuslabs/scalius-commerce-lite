CREATE TABLE `customer_auth_otp_rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `scope` text DEFAULT 'ip' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `window_expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  `updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `customer_auth_otp_rate_limits_window_idx`
ON `customer_auth_otp_rate_limits` (`window_expires_at`);
