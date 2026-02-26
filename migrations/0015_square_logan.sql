ALTER TABLE `site_settings` ADD `checkout_mode` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `partial_payment_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `partial_payment_amount` real DEFAULT 0 NOT NULL;