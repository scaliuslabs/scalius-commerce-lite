CREATE TABLE `theme_preview_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`base_published_revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_preview_sessions_draft_revision_positive" CHECK("theme_preview_sessions"."draft_revision" >= 1),
	CONSTRAINT "theme_preview_sessions_base_revision_nonnegative" CHECK("theme_preview_sessions"."base_published_revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX `theme_preview_sessions_expires_at_idx` ON `theme_preview_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `theme_settings_drafts` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`theme` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`base_published_revision` integer NOT NULL,
	`updated_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_settings_drafts_singleton" CHECK("theme_settings_drafts"."id" = 'default'),
	CONSTRAINT "theme_settings_drafts_revision_positive" CHECK("theme_settings_drafts"."revision" >= 1),
	CONSTRAINT "theme_settings_drafts_base_revision_nonnegative" CHECK("theme_settings_drafts"."base_published_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `theme_settings_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`published_revision` integer NOT NULL,
	`theme` text NOT NULL,
	`source` text NOT NULL,
	`source_revision` integer,
	`published_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_settings_versions_revision_positive" CHECK("theme_settings_versions"."published_revision" >= 1),
	CONSTRAINT "theme_settings_versions_source_revision_positive" CHECK("theme_settings_versions"."source_revision" IS NULL OR "theme_settings_versions"."source_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `theme_settings_versions_published_revision_unique` ON `theme_settings_versions` (`published_revision`);--> statement-breakpoint
INSERT INTO `theme_settings_versions` (
	`id`,
	`published_revision`,
	`theme`,
	`source`,
	`source_revision`,
	`published_by`,
	`created_at`
)
SELECT
	'themev_migration_' || CAST(`revision` AS text),
	`revision`,
	`colors`,
	'migration',
	NULL,
	NULL,
	`updated_at`
FROM `theme_settings`;--> statement-breakpoint
INSERT INTO `theme_settings_drafts` (
	`id`,
	`theme`,
	`revision`,
	`base_published_revision`,
	`updated_by`,
	`created_at`,
	`updated_at`
)
SELECT
	'default',
	`colors`,
	1,
	`revision`,
	NULL,
	`updated_at`,
	`updated_at`
FROM `theme_settings`;
