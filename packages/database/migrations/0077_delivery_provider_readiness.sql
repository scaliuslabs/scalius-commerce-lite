ALTER TABLE `delivery_providers` ADD `last_test_attempt_at` integer;
--> statement-breakpoint
ALTER TABLE `delivery_providers` ADD `last_test_success_at` integer;
--> statement-breakpoint
ALTER TABLE `delivery_providers` ADD `last_test_failure_at` integer;
--> statement-breakpoint
ALTER TABLE `delivery_providers` ADD `last_test_success_fingerprint` text;
