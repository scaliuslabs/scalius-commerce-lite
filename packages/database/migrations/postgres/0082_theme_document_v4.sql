-- Theme documents are now version 4: a template, tokens, one variant per
-- block and page sections (see packages/shared/src/storefront-theme.md).
-- Every stored row that is not a version 4 document is deleted, so the store
-- renders the default theme (the Department mall template, which renders
-- today's classic look) and a missing published row reads as the defaults
-- at revision 0. When the published theme is not version 4, its drafts,
-- history and preview sessions go with it so revisions restart cleanly.
DELETE FROM "theme_preview_sessions"
WHERE "theme" NOT LIKE '{"version":4,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":4,%');
--> statement-breakpoint
DELETE FROM "theme_settings_drafts"
WHERE "theme" NOT LIKE '{"version":4,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":4,%');
--> statement-breakpoint
DELETE FROM "theme_settings_versions"
WHERE "theme" NOT LIKE '{"version":4,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":4,%');
--> statement-breakpoint
DELETE FROM "theme_settings"
WHERE "colors" NOT LIKE '{"version":4,%';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (82, '0082_theme_document_v4', '3edcdcf0fe41c442226db15d6f130d4f70517ed2a0527ae280943e07d4f40e4f');
