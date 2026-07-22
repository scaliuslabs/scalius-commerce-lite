PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_rate_limit`("id", "key", "count", "last_request") SELECT lower(hex(randomblob(16))), "key", "count", "last_request" FROM `rate_limit`;--> statement-breakpoint
DROP TABLE `rate_limit`;--> statement-breakpoint
ALTER TABLE `__new_rate_limit` RENAME TO `rate_limit`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_uidx` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE INDEX `rate_limit_last_request_idx` ON `rate_limit` (`last_request`);--> statement-breakpoint
ALTER TABLE `two_factor` ADD `failed_verification_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `two_factor` ADD `locked_until` integer;
