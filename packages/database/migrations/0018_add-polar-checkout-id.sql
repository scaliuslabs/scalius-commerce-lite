ALTER TABLE `order_payments` ADD `polar_checkout_id` text;--> statement-breakpoint
CREATE INDEX `order_payments_polar_checkout_idx` ON `order_payments` (`polar_checkout_id`);