-- Contract v1 (K1): app theme slots became skins. Stored rows are
-- transformed in place, never reset, so a store keeps its look:
--   S1 theme documents move `apps.header`, `apps.footer` and `apps.productCard`
--      to `apps.skins.header`, `apps.skins.footer` and
--      `apps.skins."product-card"` (the published document, the shared draft,
--      the version history (bare or in its `{ meta, theme }` envelope) and the
--      restore points). The draft's revision advances, so an editor holding the
--      old shape reloads instead of saving it back.
--   S2 installed app manifests move `storefront.slots` to `storefront.skins`,
--      each `slot` becoming its `target` (the same unit names); the
--      installation's revision advances. Every stored manifest carries the
--      (often empty) list, so every row moves.
-- Only valid JSON rows are touched; a row that is not valid JSON was already
-- unreadable and stays as it is. Re-running changes nothing.
UPDATE `theme_settings` SET `colors` = json_remove(json_set(`colors`, '$.apps.skins.header', json(json_extract(`colors`, '$.apps.header'))), '$.apps.header')
WHERE json_valid(`colors`) AND json_type(`colors`, '$.apps.header') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings` SET `colors` = json_remove(json_set(`colors`, '$.apps.skins.footer', json(json_extract(`colors`, '$.apps.footer'))), '$.apps.footer')
WHERE json_valid(`colors`) AND json_type(`colors`, '$.apps.footer') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings` SET `colors` = json_remove(json_set(`colors`, '$.apps.skins."product-card"', json(json_extract(`colors`, '$.apps.productCard'))), '$.apps.productCard')
WHERE json_valid(`colors`) AND json_type(`colors`, '$.apps.productCard') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_drafts` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins.header', json(json_extract(`theme`, '$.apps.header'))), '$.apps.header'), `revision` = `revision` + 1
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.header') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_drafts` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins.footer', json(json_extract(`theme`, '$.apps.footer'))), '$.apps.footer'), `revision` = `revision` + 1
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.footer') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_drafts` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins."product-card"', json(json_extract(`theme`, '$.apps.productCard'))), '$.apps.productCard'), `revision` = `revision` + 1
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.productCard') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_versions` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins.header', json(json_extract(`theme`, '$.apps.header'))), '$.apps.header')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.header') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_versions` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins.footer', json(json_extract(`theme`, '$.apps.footer'))), '$.apps.footer')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.footer') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_versions` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins."product-card"', json(json_extract(`theme`, '$.apps.productCard'))), '$.apps.productCard')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.productCard') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_versions` SET `theme` = json_remove(json_set(`theme`, '$.theme.apps.skins.header', json(json_extract(`theme`, '$.theme.apps.header'))), '$.theme.apps.header')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.theme.apps.header') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_versions` SET `theme` = json_remove(json_set(`theme`, '$.theme.apps.skins.footer', json(json_extract(`theme`, '$.theme.apps.footer'))), '$.theme.apps.footer')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.theme.apps.footer') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_settings_versions` SET `theme` = json_remove(json_set(`theme`, '$.theme.apps.skins."product-card"', json(json_extract(`theme`, '$.theme.apps.productCard'))), '$.theme.apps.productCard')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.theme.apps.productCard') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_restore_points` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins.header', json(json_extract(`theme`, '$.apps.header'))), '$.apps.header')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.header') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_restore_points` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins.footer', json(json_extract(`theme`, '$.apps.footer'))), '$.apps.footer')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.footer') IS NOT NULL;
--> statement-breakpoint
UPDATE `theme_restore_points` SET `theme` = json_remove(json_set(`theme`, '$.apps.skins."product-card"', json(json_extract(`theme`, '$.apps.productCard'))), '$.apps.productCard')
WHERE json_valid(`theme`) AND json_type(`theme`, '$.apps.productCard') IS NOT NULL;
--> statement-breakpoint
UPDATE `plugin_installations` SET `manifest_json` = json_remove(json_set(`manifest_json`, '$.storefront.skins', json((SELECT json_group_array(json_remove(json_set(`slot`.`value`, '$.target', json_extract(`slot`.`value`, '$.slot')), '$.slot')) FROM json_each(`plugin_installations`.`manifest_json`, '$.storefront.slots') AS `slot`))), '$.storefront.slots'), `revision` = `revision` + 1
WHERE json_valid(`manifest_json`) AND json_type(`manifest_json`, '$.storefront.slots') = 'array';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (153, '0153_theme_skins', 'd0be879752ec302b137e897dea2cd1bd0c1778240d556dbd9ab5e310f5f8ed02');
