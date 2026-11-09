-- A template switch never loses the merchant's theme work: see
-- ../0214_theme_template_switch.sql. Each template's last design, and a
-- restore point's 'template' reason and the template a switch went to.
CREATE TABLE "theme_template_designs" (
	"template" text PRIMARY KEY NOT NULL,
	"theme" text NOT NULL,
	"updated_by" text,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "theme_template_designs_template_shape" CHECK(length("theme_template_designs"."template") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "theme_template_designs_updated_at_idx" ON "theme_template_designs" ("updated_at");
--> statement-breakpoint
ALTER TABLE "theme_restore_points" ADD COLUMN "template" text;
--> statement-breakpoint
ALTER TABLE "theme_restore_points" DROP CONSTRAINT "theme_restore_points_reason_check";
--> statement-breakpoint
ALTER TABLE "theme_restore_points" ADD CONSTRAINT "theme_restore_points_reason_check" CHECK ("reason" IN ('restore', 'discard', 'app', 'template'));
--> statement-breakpoint
ALTER TABLE "theme_restore_points" ADD CONSTRAINT "theme_restore_points_template_shape" CHECK ("template" IS NULL OR length("template") BETWEEN 1 AND 200);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (214, '0214_theme_template_switch', 'd8941d138bd45dcb0ad4d5543925840f4413747c498afd80fbafbeaf7bf3407b');
