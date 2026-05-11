CREATE TABLE `widget_placements` (
	`id` text PRIMARY KEY NOT NULL,
	`widget_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text,
	`slot` text NOT NULL,
	`anchor_type` text,
	`anchor_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`widget_id`) REFERENCES `widgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `widget_placements` (
	`id`,
	`widget_id`,
	`scope`,
	`scope_id`,
	`slot`,
	`anchor_type`,
	`anchor_id`,
	`sort_order`,
	`is_active`,
	`created_at`,
	`updated_at`,
	`deleted_at`
)
SELECT
	'wpl_' || `id`,
	`id`,
	'homepage',
	NULL,
	CASE `placement_rule`
		WHEN 'fixed_bottom_homepage' THEN 'bottom'
		WHEN 'before_collection' THEN 'before_collection'
		WHEN 'after_collection' THEN 'after_collection'
		ELSE 'top'
	END,
	CASE
		WHEN `placement_rule` IN ('before_collection', 'after_collection') THEN 'collection'
		ELSE NULL
	END,
	CASE
		WHEN `placement_rule` IN ('before_collection', 'after_collection') THEN `reference_collection_id`
		ELSE NULL
	END,
	`sort_order`,
	`is_active`,
	`created_at`,
	`updated_at`,
	`deleted_at`
FROM `widgets`
WHERE `placement_rule` != 'standalone';
--> statement-breakpoint
CREATE INDEX `widget_placements_widget_id_idx` ON `widget_placements` (`widget_id`);--> statement-breakpoint
CREATE INDEX `widget_placements_lookup_idx` ON `widget_placements` (`scope`,`scope_id`,`slot`,`is_active`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `widget_placements_anchor_idx` ON `widget_placements` (`anchor_type`,`anchor_id`);
