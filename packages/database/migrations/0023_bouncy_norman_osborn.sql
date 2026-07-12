PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hero_sliders` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`images` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "hero_sliders_revision_positive" CHECK("revision" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_hero_sliders`("id", "type", "images", "is_active", "revision", "created_at", "updated_at", "deleted_at") SELECT "id", "type", "images", "is_active", 1, "created_at", "updated_at", "deleted_at" FROM `hero_sliders`;--> statement-breakpoint
DROP TABLE `hero_sliders`;--> statement-breakpoint
ALTER TABLE `__new_hero_sliders` RENAME TO `hero_sliders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
UPDATE `hero_sliders`
SET `is_active` = 0,
    `deleted_at` = unixepoch(),
    `updated_at` = unixepoch(),
    `revision` = `revision` + 1
WHERE `deleted_at` IS NULL
  AND EXISTS (
    SELECT 1
    FROM `hero_sliders` AS `newer`
    WHERE `newer`.`type` = `hero_sliders`.`type`
      AND `newer`.`deleted_at` IS NULL
      AND (
        `newer`.`updated_at` > `hero_sliders`.`updated_at`
        OR (
          `newer`.`updated_at` = `hero_sliders`.`updated_at`
          AND `newer`.`id` > `hero_sliders`.`id`
        )
      )
  );--> statement-breakpoint
CREATE UNIQUE INDEX `hero_sliders_active_type_unique` ON `hero_sliders` (`type`) WHERE "hero_sliders"."deleted_at" IS NULL;
