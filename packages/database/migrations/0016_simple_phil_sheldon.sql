PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image_url` text,
	`meta_title` text,
	`meta_description` text,
	`canonical_path` text,
	`no_index` integer DEFAULT false NOT NULL,
	`exclude_from_sitemap` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "categories_status_valid" CHECK("status" IN ('draft', 'published', 'internal')),
	CONSTRAINT "categories_revision_positive" CHECK("revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_categories`("id", "name", "slug", "description", "image_url", "meta_title", "meta_description", "canonical_path", "no_index", "exclude_from_sitemap", "status", "revision", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "slug", "description", "image_url", "meta_title", "meta_description", "canonical_path", "no_index", "exclude_from_sitemap", 'published', 1, "created_at", "updated_at", "deleted_at" FROM `categories`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_idx` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_deleted_at_idx` ON `categories` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `categories_public_idx` ON `categories` (`status`,`deleted_at`);--> statement-breakpoint
CREATE TRIGGER categories_fts_after_insert AFTER INSERT ON categories BEGIN
  INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_after_update AFTER UPDATE ON categories BEGIN
  INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_before_delete BEFORE DELETE ON categories BEGIN
  INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint
CREATE TRIGGER categories_fts_before_update BEFORE UPDATE ON categories BEGIN
  INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint
INSERT INTO categories_fts(categories_fts) VALUES('rebuild');
