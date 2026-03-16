-- Migration 0024: Singleton guards + collection enum fix + missing updatedAt columns
--
-- 1. Add singleton_key to site_settings and meta_conversions_settings
--    to prevent multiple-row bugs (UNIQUE index ensures at most one row).
-- 2. Rename collection type enum values from opaque names to semantic ones.
-- 3. Add missing updatedAt column to permissions table.

ALTER TABLE site_settings ADD COLUMN singleton_key TEXT NOT NULL DEFAULT 'default';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS site_settings_singleton_idx ON site_settings(singleton_key);--> statement-breakpoint

ALTER TABLE meta_conversions_settings ADD COLUMN singleton_key TEXT NOT NULL DEFAULT 'default';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS meta_conversions_singleton_idx ON meta_conversions_settings(singleton_key);--> statement-breakpoint

UPDATE collections SET type = 'manual' WHERE type = 'collection1';--> statement-breakpoint
UPDATE collections SET type = 'dynamic' WHERE type = 'collection2';--> statement-breakpoint

ALTER TABLE permissions ADD COLUMN updated_at INTEGER;
