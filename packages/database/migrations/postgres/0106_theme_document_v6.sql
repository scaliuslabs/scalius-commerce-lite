-- Theme documents are now version 6: the template is a label only. Every
-- behaviour a template used to switch on is a block, setting or token the
-- document states (the listing's surface, gutter, title band, phone bar,
-- link style, column cap, search filter placement and ruled rail; the
-- drawer's rows; the banded directory footer; the shelves' spacing; the
-- category tiles' styles, the collections carousel, the lookbook photo and
-- the compact phone hero), and options nothing rendered are gone (header
-- sub-brand row and trending queries, product questions, the desktop
-- info-column and side-rail sticky bars, the deal block's retired end date).
-- See packages/shared/src/storefront-theme.md. Every stored row that is not
-- a version 6 document is deleted, so the store renders the default theme
-- and a missing published row reads as the defaults at revision 0. When the
-- published theme is not version 6, its drafts, history and preview
-- sessions (which follow the saved draft and hold no theme of their own)
-- go with it so revisions restart cleanly.
--
-- The theme document is also the one draft for everything that shapes how
-- the storefront looks: the brand (logo, footer logo, tab icon), the
-- announcement, the footer's words, the hero's slides, the category tiles'
-- and collections sections' picks, and what "/" shows. The hero sliders
-- (and the unused legacy hero sections), and the homepage, header and
-- footer settings documents that held those choices are dropped; store
-- identity (name, phone, email, address, social profiles) is the business
-- document's. Data may reset: nothing is carried over.
-- >>> T1 theme document v6: reset stored theme rows
DELETE FROM "theme_preview_sessions"
WHERE NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":6,%');
--> statement-breakpoint
DELETE FROM "theme_settings_drafts"
WHERE "theme" NOT LIKE '{"version":6,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":6,%');
--> statement-breakpoint
DELETE FROM "theme_settings_versions"
WHERE "theme" NOT LIKE '{"version":6,%'
  OR NOT EXISTS (SELECT 1 FROM "theme_settings" WHERE "colors" LIKE '{"version":6,%');
--> statement-breakpoint
DELETE FROM "theme_settings"
WHERE "colors" NOT LIKE '{"version":6,%';
-- <<< T1
--> statement-breakpoint
-- >>> T2 the theme owns the look: retire hero sliders and the homepage, header and footer documents
DROP TABLE IF EXISTS "hero_sliders";
--> statement-breakpoint
DROP TABLE IF EXISTS "hero_sections";
--> statement-breakpoint
DELETE FROM "settings"
WHERE "category" IN ('homepage', 'header', 'footer');
--> statement-breakpoint
-- PostgreSQL keeps a dropped table's trigger functions: drop the hero sliders' too.
DROP FUNCTION IF EXISTS scalius_compat."cdep_hero_sliders_ins_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_hero_sliders_del_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_hero_sliders_upd_fn"();
-- <<< T2
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (106, '0106_theme_document_v6', '4a5b61c81ae7d43f42eb0df4a36ab3d80af1dd3feab350a5af3d0f3da34eef50');
