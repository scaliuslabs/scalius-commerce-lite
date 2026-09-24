-- Theme documents now carry a required layout block and are read strictly.
-- Documents saved before it (no "layout" object) are deleted so the store
-- falls back to the default theme; a missing published row reads as the
-- defaults at revision 0. When the published theme is old, its drafts,
-- history and preview sessions go with it so revisions restart cleanly.
DELETE FROM "theme_preview_sessions"
WHERE "theme" NOT LIKE '%"layout":{%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '%"layout":{%');
--> statement-breakpoint
DELETE FROM "theme_settings_drafts"
WHERE "theme" NOT LIKE '%"layout":{%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '%"layout":{%');
--> statement-breakpoint
DELETE FROM "theme_settings_versions"
WHERE "theme" NOT LIKE '%"layout":{%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '%"layout":{%');
--> statement-breakpoint
DELETE FROM "theme_settings"
WHERE "colors" NOT LIKE '%"layout":{%';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (75, '0075_theme_layout_reset', '0fa004dc4ff1f70f010f91526b9a9f571ad2b8af382277503613fc445d933597');
