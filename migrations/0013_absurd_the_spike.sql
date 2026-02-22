ALTER TABLE `site_settings` ADD `auth_verification_method` text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `guest_checkout_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `whatsapp_access_token` text;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `whatsapp_phone_number_id` text;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `whatsapp_template_name` text DEFAULT 'auth_otp';