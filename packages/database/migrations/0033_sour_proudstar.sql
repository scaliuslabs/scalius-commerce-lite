PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_site_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton_key` text DEFAULT 'default' NOT NULL,
	`logo` text,
	`favicon` text,
	`site_name` text NOT NULL,
	`site_description` text,
	`header_config` text NOT NULL,
	`header_config_revision` integer DEFAULT 1 NOT NULL,
	`footer_config` text NOT NULL,
	`footer_config_revision` integer DEFAULT 1 NOT NULL,
	`social_links` text,
	`contact_info` text,
	`site_title` text,
	`homepage_title` text,
	`homepage_meta_description` text,
	`robots_txt` text,
	`storefront_url` text DEFAULT '/',
	`auth_verification_method` text DEFAULT 'email' NOT NULL,
	`guest_checkout_enabled` integer DEFAULT true NOT NULL,
	`checkout_mode` text DEFAULT 'all' NOT NULL,
	`partial_payment_enabled` integer DEFAULT false NOT NULL,
	`partial_payment_amount` real DEFAULT 0 NOT NULL,
	`checkout_flow_revision` integer DEFAULT 1 NOT NULL,
	`whatsapp_access_token` text,
	`whatsapp_phone_number_id` text,
	`whatsapp_template_name` text DEFAULT 'auth_otp',
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "site_settings_header_config_revision_positive" CHECK("__new_site_settings"."header_config_revision" >= 1),
	CONSTRAINT "site_settings_footer_config_revision_positive" CHECK("__new_site_settings"."footer_config_revision" >= 1),
	CONSTRAINT "site_settings_checkout_flow_revision_positive" CHECK("__new_site_settings"."checkout_flow_revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_site_settings`("id", "singleton_key", "logo", "favicon", "site_name", "site_description", "header_config", "header_config_revision", "footer_config", "footer_config_revision", "social_links", "contact_info", "site_title", "homepage_title", "homepage_meta_description", "robots_txt", "storefront_url", "auth_verification_method", "guest_checkout_enabled", "checkout_mode", "partial_payment_enabled", "partial_payment_amount", "checkout_flow_revision", "whatsapp_access_token", "whatsapp_phone_number_id", "whatsapp_template_name", "created_at", "updated_at") SELECT "id", "singleton_key", "logo", "favicon", "site_name", "site_description", "header_config", 1, "footer_config", 1, "social_links", "contact_info", "site_title", "homepage_title", "homepage_meta_description", "robots_txt", "storefront_url", "auth_verification_method", "guest_checkout_enabled", "checkout_mode", "partial_payment_enabled", "partial_payment_amount", "checkout_flow_revision", "whatsapp_access_token", "whatsapp_phone_number_id", "whatsapp_template_name", "created_at", "updated_at" FROM `site_settings`;--> statement-breakpoint
DROP TABLE `site_settings`;--> statement-breakpoint
ALTER TABLE `__new_site_settings` RENAME TO `site_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `site_settings_singleton_idx` ON `site_settings` (`singleton_key`);
