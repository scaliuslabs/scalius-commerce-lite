-- A theme app's update reaches stores already on its template: each
-- template key keeps the release the store's theme was applied from (or
-- last reviewed an update of), as that release declared it, so the next
-- release merges against it (packages/shared/src/storefront-theme/template-update.ts).
-- A new, empty table: no row is rewritten.
CREATE TABLE `theme_template_bases` (
	`template` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`app_version` text NOT NULL,
	`theme_version` integer NOT NULL,
	`theme` text NOT NULL,
	`source` text NOT NULL,
	`recorded_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "theme_template_bases_template_shape" CHECK(length("theme_template_bases"."template") BETWEEN 3 AND 200 AND instr("theme_template_bases"."template", '/') > 1),
	CONSTRAINT "theme_template_bases_source_check" CHECK("theme_template_bases"."source" IN ('apply', 'review', 'update')),
	CONSTRAINT "theme_template_bases_theme_json" CHECK(json_valid("theme_template_bases"."theme") AND json_type("theme_template_bases"."theme") = 'object' AND length("theme_template_bases"."theme") <= 262144),
	CONSTRAINT "theme_template_bases_version_shape" CHECK(length("theme_template_bases"."app_version") BETWEEN 1 AND 80 AND "theme_template_bases"."theme_version" >= 1)
);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (228, '0228_theme_template_bases', '0a3b0a7c40dced0ef06e86ad6409935a7e687bc0978a9039fd4337ac3a7ea027');
