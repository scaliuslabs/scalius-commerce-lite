ALTER TABLE `pages`
ADD COLUMN `content_type` text DEFAULT 'page' NOT NULL
CHECK (`content_type` IN ('page', 'article'));--> statement-breakpoint
ALTER TABLE `pages`
ADD COLUMN `excerpt` text
CHECK (`content_type` = 'article' OR `excerpt` IS NULL);--> statement-breakpoint
ALTER TABLE `pages`
ADD COLUMN `author` text
CHECK (`content_type` = 'article' OR `author` IS NULL);--> statement-breakpoint
ALTER TABLE `pages`
ADD COLUMN `tags` text DEFAULT '[]' NOT NULL
CHECK (
  json_valid(`tags`)
  AND json_type(`tags`) = 'array'
  AND (`content_type` = 'article' OR json_array_length(`tags`) = 0)
);--> statement-breakpoint
CREATE INDEX `pages_content_type_deleted_at_idx`
ON `pages` (`content_type`, `deleted_at`);--> statement-breakpoint
CREATE INDEX `pages_content_type_published_at_idx`
ON `pages` (`content_type`, `is_published`, `published_at`);
