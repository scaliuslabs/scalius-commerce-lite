ALTER TABLE `customer_auth_otp_challenges` ADD `delivery_target_encrypted` text;
--> statement-breakpoint
ALTER TABLE `customer_auth_otp_challenges` ADD `delivery_name_encrypted` text;
--> statement-breakpoint
ALTER TABLE `order_payment_recovery_challenges` ADD `delivery_target_encrypted` text;
--> statement-breakpoint
ALTER TABLE `order_payment_recovery_challenges` ADD `delivery_name_encrypted` text;
