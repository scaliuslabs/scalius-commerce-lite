CREATE TABLE `admin_setup_claims` (
  `singleton_key` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'processing' NOT NULL,
  `claim_id` text,
  `claim_expires_at` integer,
  `completed_user_id` text,
  `last_error` text,
  `created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  `updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  FOREIGN KEY (`completed_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);

CREATE INDEX `admin_setup_claims_status_claim_idx`
  ON `admin_setup_claims` (`status`, `claim_expires_at`);

CREATE TABLE `admin_setup_rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `window_expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  `updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);

CREATE INDEX `admin_setup_rate_limits_window_idx`
  ON `admin_setup_rate_limits` (`window_expires_at`);
