PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_analytics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`use_partytown` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`location` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "analytics_revision_positive" CHECK("revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_analytics`("id", "name", "type", "is_active", "use_partytown", "config", "location", "revision", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "type", "is_active", "use_partytown", "config", "location", 1, "created_at", "updated_at", NULL FROM `analytics`;--> statement-breakpoint
DROP TABLE `analytics`;--> statement-breakpoint
ALTER TABLE `__new_analytics` RENAME TO `analytics`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `analytics_type_idx` ON `analytics` (`type`);--> statement-breakpoint
CREATE INDEX `analytics_deleted_updated_idx` ON `analytics` (`deleted_at`,`updated_at`);
