CREATE TABLE `scanner_token_claims` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `admin_id` text NOT NULL,
  `admin_name` text NOT NULL,
  `consumed_at` integer,
  `consumed_session_hash` text,
  `expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  `updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
  FOREIGN KEY (`admin_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `scanner_token_claims_expires_idx`
  ON `scanner_token_claims` (`expires_at`);

CREATE INDEX `scanner_token_claims_admin_created_idx`
  ON `scanner_token_claims` (`admin_id`, `created_at`);

CREATE UNIQUE INDEX `scanner_token_claims_consumed_session_hash_uq`
  ON `scanner_token_claims` (`consumed_session_hash`);
