-- A template switch never loses the merchant's theme work.
--
-- 1. Each template keeps its last design (`theme_template_designs`): the
--    whole draft as it was when the store switched away from that template,
--    one row per template, so switching back brings it back. Never live.
-- 2. A restore point records a template switch (reason 'template') and the
--    template it went to (`template`, also set for an app's template): the
--    table is rebuilt for the wider reason check (no foreign key or trigger
--    names it), its rows kept with no template.
CREATE TABLE `theme_template_designs` (
	`template` text PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_template_designs_template_shape" CHECK(length("theme_template_designs"."template") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX `theme_template_designs_updated_at_idx` ON `theme_template_designs` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `__new_theme_restore_points` (
	`id` text PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`reason` text NOT NULL,
	`template` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_restore_points_id_shape" CHECK(substr("__new_theme_restore_points"."id", 1, 8) = 'themerp_' AND length("__new_theme_restore_points"."id") BETWEEN 12 AND 40),
	CONSTRAINT "theme_restore_points_reason_check" CHECK("__new_theme_restore_points"."reason" IN ('restore', 'discard', 'app', 'template')),
	CONSTRAINT "theme_restore_points_draft_revision_positive" CHECK("__new_theme_restore_points"."draft_revision" >= 1),
	CONSTRAINT "theme_restore_points_template_shape" CHECK("__new_theme_restore_points"."template" IS NULL OR length("__new_theme_restore_points"."template") BETWEEN 1 AND 200)
);
--> statement-breakpoint
INSERT INTO `__new_theme_restore_points`("id", "theme", "draft_revision", "reason", "template", "created_by", "created_at") SELECT "id", "theme", "draft_revision", "reason", NULL, "created_by", "created_at" FROM `theme_restore_points`;
--> statement-breakpoint
DROP TABLE `theme_restore_points`;
--> statement-breakpoint
ALTER TABLE `__new_theme_restore_points` RENAME TO `theme_restore_points`;
--> statement-breakpoint
CREATE INDEX `theme_restore_points_created_at_idx` ON `theme_restore_points` (`created_at`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (214, '0214_theme_template_switch', 'd8941d138bd45dcb0ad4d5543925840f4413747c498afd80fbafbeaf7bf3407b');
