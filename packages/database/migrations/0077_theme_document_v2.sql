-- Theme documents are now the strict version 2 document (see
-- packages/shared/src/storefront-theme.md). Every stored row that is not a
-- version 2 document is deleted, so the store renders the default theme and
-- a missing published row reads as the defaults at revision 0. When the
-- published theme is not version 2, its drafts, history and preview
-- sessions go with it so revisions restart cleanly.
DELETE FROM `theme_preview_sessions`
WHERE `theme` NOT LIKE '{"version":2,%'
  OR NOT EXISTS (SELECT 1 FROM `theme_settings` WHERE `colors` LIKE '{"version":2,%');
--> statement-breakpoint
DELETE FROM `theme_settings_drafts`
WHERE `theme` NOT LIKE '{"version":2,%'
  OR NOT EXISTS (SELECT 1 FROM `theme_settings` WHERE `colors` LIKE '{"version":2,%');
--> statement-breakpoint
DELETE FROM `theme_settings_versions`
WHERE `theme` NOT LIKE '{"version":2,%'
  OR NOT EXISTS (SELECT 1 FROM `theme_settings` WHERE `colors` LIKE '{"version":2,%');
--> statement-breakpoint
DELETE FROM `theme_settings`
WHERE `colors` NOT LIKE '{"version":2,%';
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (77, '0077_theme_document_v2', 'f9097a979abd80378e94d9afec34363da94b31584f55bd71af717f2bdaafae1a');
