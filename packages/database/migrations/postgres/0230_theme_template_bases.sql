-- A theme app's update reaches stores already on its template: see
-- ../0230_theme_template_bases.sql. Each template key's base release.
CREATE TABLE "theme_template_bases" (
	"template" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"app_version" text NOT NULL,
	"theme_version" integer NOT NULL,
	"theme" text NOT NULL,
	"source" text NOT NULL,
	"recorded_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "theme_template_bases_template_shape" CHECK(length("theme_template_bases"."template") BETWEEN 3 AND 200 AND instr("theme_template_bases"."template", '/') > 1),
	CONSTRAINT "theme_template_bases_source_check" CHECK("theme_template_bases"."source" IN ('apply', 'review', 'update')),
	CONSTRAINT "theme_template_bases_theme_json" CHECK(json_valid("theme_template_bases"."theme") AND json_type("theme_template_bases"."theme") = 'object' AND length("theme_template_bases"."theme") <= 262144),
	CONSTRAINT "theme_template_bases_version_shape" CHECK(length("theme_template_bases"."app_version") BETWEEN 1 AND 80 AND "theme_template_bases"."theme_version" >= 1)
);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (230, '0230_theme_template_bases', '39d369848574fe15aafbda081ec9432ce16d20075b9038ce7d051e44ee29e0db');
