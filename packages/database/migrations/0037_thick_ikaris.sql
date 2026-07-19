PRAGMA foreign_keys=OFF;--> statement-breakpoint
UPDATE `navigation_placements`
SET `position` = 0
WHERE `surface` = 'header' AND `slot` = 'primary';--> statement-breakpoint
WITH ranked_footer_placements AS (
	SELECT
		`id`,
		row_number() OVER (ORDER BY `position`, `id`) AS `rank`
	FROM `navigation_placements`
	WHERE `surface` = 'footer' AND `slot` = 'column'
)
DELETE FROM `navigation_placements`
WHERE `id` IN (
	SELECT `id` FROM ranked_footer_placements WHERE `rank` > 4
);--> statement-breakpoint
WITH ranked_footer_placements AS (
	SELECT
		`id`,
		row_number() OVER (ORDER BY `position`, `id`) AS `rank`
	FROM `navigation_placements`
	WHERE `surface` = 'footer' AND `slot` = 'column'
)
UPDATE `navigation_placements`
SET `position` = -(SELECT `rank` FROM ranked_footer_placements WHERE ranked_footer_placements.`id` = navigation_placements.`id`)
WHERE `id` IN (SELECT `id` FROM ranked_footer_placements);--> statement-breakpoint
UPDATE `navigation_placements`
SET `position` = -`position` - 1
WHERE `surface` = 'footer' AND `slot` = 'column';--> statement-breakpoint
CREATE TABLE `__new_navigation_placements` (
	`id` text PRIMARY KEY NOT NULL,
	`surface` text NOT NULL,
	`slot` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`menu_id` text NOT NULL,
	`label_override` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`menu_id`) REFERENCES `navigation_menus`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "navigation_placements_surface_present" CHECK(length(trim("surface")) BETWEEN 1 AND 80),
	CONSTRAINT "navigation_placements_slot_present" CHECK(length(trim("slot")) BETWEEN 1 AND 80),
	CONSTRAINT "navigation_placements_supported_location" CHECK((
            ("surface" = 'header' AND "slot" = 'primary' AND "position" = 0)
            OR
            ("surface" = 'footer' AND "slot" = 'column' AND "position" BETWEEN 0 AND 3)
        )),
	CONSTRAINT "navigation_placements_revision_positive" CHECK("revision" >= 1),
	CONSTRAINT "navigation_placements_label_override_length" CHECK("label_override" IS NULL OR length(trim("label_override")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
INSERT INTO `__new_navigation_placements`("id", "surface", "slot", "position", "menu_id", "label_override", "is_enabled", "revision", "created_at", "updated_at") SELECT "id", "surface", "slot", "position", "menu_id", "label_override", "is_enabled", "revision", "created_at", "updated_at" FROM `navigation_placements`;--> statement-breakpoint
DROP TABLE `navigation_placements`;--> statement-breakpoint
ALTER TABLE `__new_navigation_placements` RENAME TO `navigation_placements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `navigation_placements_active_slot_unique` ON `navigation_placements` (`surface`,`slot`,`position`) WHERE "navigation_placements"."is_enabled" = true;--> statement-breakpoint
CREATE INDEX `navigation_placements_menu_idx` ON `navigation_placements` (`menu_id`,`is_enabled`);
