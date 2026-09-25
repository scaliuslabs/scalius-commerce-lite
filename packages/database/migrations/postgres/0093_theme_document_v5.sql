-- Theme documents are now version 5: blocks gain the shared navigation
-- source ("blocks.navigation") and the listing's filter style
-- ("blocks.listing.filters"), and listing layouts are result arrangements
-- only (grid, list, shelves, quick-grid). See
-- packages/shared/src/storefront-theme.md. Every stored row that is not a
-- version 5 document is deleted, so the store renders the default theme and
-- a missing published row reads as the defaults at revision 0. When the
-- published theme is not version 5, its drafts, history and preview
-- sessions go with it so revisions restart cleanly.
DELETE FROM "theme_preview_sessions"
WHERE "theme" NOT LIKE '{"version":5,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":5,%');
--> statement-breakpoint
DELETE FROM "theme_settings_drafts"
WHERE "theme" NOT LIKE '{"version":5,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":5,%');
--> statement-breakpoint
DELETE FROM "theme_settings_versions"
WHERE "theme" NOT LIKE '{"version":5,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":5,%');
--> statement-breakpoint
DELETE FROM "theme_settings"
WHERE "colors" NOT LIKE '{"version":5,%';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (93, '0093_theme_document_v5', '1d8c43a620127ad07a2d9dbb76747f4c5675e34d18757a268a4974dadac3c031');
