-- All pre-release media is disposable demo data. Rebuild the old image-only
-- library so copied public URLs and the unused parent-folder model do not leak
-- into the stable authority.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `media_upload_parts`;--> statement-breakpoint
DROP TABLE IF EXISTS `media_upload_sessions`;--> statement-breakpoint
DROP TABLE IF EXISTS `media`;--> statement-breakpoint
DROP TABLE IF EXISTS `media_folders`;--> statement-breakpoint
CREATE TABLE `media_folders` (
	`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "media_folders_name_valid" CHECK("name" = trim("name") AND "name" <> '' AND length("name") <= 100),
	CONSTRAINT "media_folders_version_positive" CHECK("version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX `media_folders_active_name_uidx` ON `media_folders` (lower(trim(`name`))) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `media_folders_active_name_idx` ON `media_folders` (`deleted_at`,`name`,`id`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL, `filename` text NOT NULL,
	`kind` text NOT NULL, `object_key` text NOT NULL,
	`size` integer NOT NULL, `mime_type` text NOT NULL,
	`alt_text` text, `caption` text, `width` integer, `height` integer,
	`duration_ms` integer, `poster_media_id` text, `folder_id` text,
	`status` text DEFAULT 'ready' NOT NULL, `version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`trashed_at` integer, `deleted_at` integer,
	FOREIGN KEY (`poster_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`folder_id`) REFERENCES `media_folders`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_filename_valid" CHECK("filename" = trim("filename") AND "filename" <> '' AND length("filename") <= 255),
	CONSTRAINT "media_kind_valid" CHECK("kind" IN ('image', 'video')),
	CONSTRAINT "media_kind_mime_coherent" CHECK(("kind" = 'image' AND "mime_type" IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif')) OR ("kind" = 'video' AND "mime_type" IN ('video/mp4', 'video/webm'))),
	CONSTRAINT "media_object_key_valid" CHECK(trim("object_key") <> '' AND length("object_key") <= 512),
	CONSTRAINT "media_size_positive" CHECK("size" > 0),
	CONSTRAINT "media_dimensions_positive" CHECK(("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
	CONSTRAINT "media_duration_positive" CHECK("duration_ms" IS NULL OR "duration_ms" > 0),
	CONSTRAINT "media_status_valid" CHECK("status" IN ('ready', 'trashed', 'deleting', 'deleted')),
	CONSTRAINT "media_lifecycle_timestamps_valid" CHECK(("status" = 'ready' AND "trashed_at" IS NULL AND "deleted_at" IS NULL) OR ("status" IN ('trashed', 'deleting') AND "trashed_at" IS NOT NULL AND "deleted_at" IS NULL) OR ("status" = 'deleted' AND "trashed_at" IS NOT NULL AND "deleted_at" IS NOT NULL)),
	CONSTRAINT "media_version_positive" CHECK("version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX `media_object_key_unique` ON `media` (`object_key`);--> statement-breakpoint
CREATE INDEX `media_folder_id_idx` ON `media` (`folder_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_status_newest_idx` ON `media` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_kind_newest_idx` ON `media` (`kind`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_poster_id_idx` ON `media` (`poster_media_id`);--> statement-breakpoint
CREATE TABLE `media_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL, `media_id` text NOT NULL,
	`object_key` text NOT NULL, `upload_id` text,
	`filename` text NOT NULL, `kind` text NOT NULL, `mime_type` text NOT NULL,
	`size` integer NOT NULL, `expected_parts` integer NOT NULL, `folder_id` text,
	`state` text DEFAULT 'initializing' NOT NULL, `version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL, `r2_completed_at` integer, `committed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `media_folders`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_upload_filename_valid" CHECK("filename" = trim("filename") AND "filename" <> '' AND length("filename") <= 255),
	CONSTRAINT "media_upload_kind_valid" CHECK("kind" IN ('image', 'video')),
	CONSTRAINT "media_upload_kind_mime_coherent" CHECK(("kind" = 'image' AND "mime_type" IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif')) OR ("kind" = 'video' AND "mime_type" IN ('video/mp4', 'video/webm'))),
	CONSTRAINT "media_upload_size_positive" CHECK("size" > 0),
	CONSTRAINT "media_upload_expected_parts_valid" CHECK("expected_parts" >= 1 AND "expected_parts" <= 20),
	CONSTRAINT "media_upload_state_valid" CHECK("state" IN ('initializing', 'initiated', 'uploading', 'completing', 'committed', 'aborting', 'aborted', 'expired', 'failed')),
	CONSTRAINT "media_upload_handle_valid" CHECK(("state" IN ('initializing', 'failed') AND "upload_id" IS NULL) OR ("state" NOT IN ('initializing', 'failed') AND "upload_id" IS NOT NULL) OR ("state" = 'failed' AND "upload_id" IS NOT NULL)),
	CONSTRAINT "media_upload_completion_timestamps_valid" CHECK(("state" = 'committed' AND "r2_completed_at" IS NOT NULL AND "committed_at" IS NOT NULL) OR ("state" <> 'committed' AND "committed_at" IS NULL)),
	CONSTRAINT "media_upload_version_positive" CHECK("version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX `media_upload_sessions_media_id_unique` ON `media_upload_sessions` (`media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_upload_sessions_object_key_unique` ON `media_upload_sessions` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_upload_sessions_upload_id_unique` ON `media_upload_sessions` (`upload_id`);--> statement-breakpoint
CREATE INDEX `media_upload_state_expiry_idx` ON `media_upload_sessions` (`state`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_upload_created_idx` ON `media_upload_sessions` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `media_upload_parts` (
	`session_id` text NOT NULL, `part_number` integer NOT NULL,
	`etag` text NOT NULL, `size` integer NOT NULL,
	`signature_verified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`session_id`, `part_number`),
	FOREIGN KEY (`session_id`) REFERENCES `media_upload_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_upload_part_number_valid" CHECK("part_number" >= 1 AND "part_number" <= 20),
	CONSTRAINT "media_upload_part_size_valid" CHECK("size" >= 1 AND "size" <= 5242880),
	CONSTRAINT "media_upload_part_etag_valid" CHECK("etag" <> '' AND length("etag") <= 256)
);--> statement-breakpoint
CREATE INDEX `media_upload_parts_session_idx` ON `media_upload_parts` (`session_id`,`part_number`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
