-- Theme documents are now version 3: the layout adds the navigation styles
-- (see packages/shared/src/storefront-theme.md). Every stored row that is not
-- a version 3 document is deleted, so the store renders the default theme and
-- a missing published row reads as the defaults at revision 0. When the
-- published theme is not version 3, its drafts, history and preview
-- sessions go with it so revisions restart cleanly.
DELETE FROM "theme_preview_sessions"
WHERE "theme" NOT LIKE '{"version":3,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":3,%');
--> statement-breakpoint
DELETE FROM "theme_settings_drafts"
WHERE "theme" NOT LIKE '{"version":3,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":3,%');
--> statement-breakpoint
DELETE FROM "theme_settings_versions"
WHERE "theme" NOT LIKE '{"version":3,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":3,%');
--> statement-breakpoint
DELETE FROM "theme_settings"
WHERE "colors" NOT LIKE '{"version":3,%';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (81, '0081_theme_document_v3', 'd99b5418ee7a5a49a20ad5bfbeaec54e8c9f8df6fc9efeedf27a4604c574fe2f');
