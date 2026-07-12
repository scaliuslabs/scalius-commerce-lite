PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`presentation` text NOT NULL,
	`config` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`canonical_path` text,
	`no_index` integer DEFAULT false NOT NULL,
	`exclude_from_sitemap` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "collections_version_positive" CHECK("version" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_collections`("id", "name", "presentation", "config", "sort_order", "is_active", "version", "canonical_path", "no_index", "exclude_from_sitemap", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "presentation", "config", "sort_order", "is_active", 1, "canonical_path", "no_index", "exclude_from_sitemap", "created_at", "updated_at", "deleted_at" FROM `collections`;--> statement-breakpoint
DROP TABLE `collections`;--> statement-breakpoint
ALTER TABLE `__new_collections` RENAME TO `collections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `collections_deleted_at_idx` ON `collections` (`deleted_at`);
