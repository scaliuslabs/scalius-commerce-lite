CREATE TABLE `theme_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`colors` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_settings_singleton" CHECK("theme_settings"."id" = 'default'),
	CONSTRAINT "theme_settings_revision_positive" CHECK("theme_settings"."revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `theme_settings` (`id`, `colors`, `revision`, `created_at`, `updated_at`)
SELECT 'default', `value`, 1, unixepoch(), unixepoch()
FROM `settings`
WHERE `category` = 'theme' AND `key` = 'storefront_colors'
LIMIT 1
ON CONFLICT (`id`) DO NOTHING;
