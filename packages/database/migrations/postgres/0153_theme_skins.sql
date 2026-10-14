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
UPDATE "theme_settings" SET "colors" = (jsonb_set("colors"::jsonb, '{apps,skins}', coalesce("colors"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('header', "colors"::jsonb #> '{apps,header}')) #- '{apps,header}')::text
WHERE "colors" LIKE '{%' AND ("colors"::jsonb #> '{apps,header}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings" SET "colors" = (jsonb_set("colors"::jsonb, '{apps,skins}', coalesce("colors"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('footer', "colors"::jsonb #> '{apps,footer}')) #- '{apps,footer}')::text
WHERE "colors" LIKE '{%' AND ("colors"::jsonb #> '{apps,footer}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings" SET "colors" = (jsonb_set("colors"::jsonb, '{apps,skins}', coalesce("colors"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('product-card', "colors"::jsonb #> '{apps,productCard}')) #- '{apps,productCard}')::text
WHERE "colors" LIKE '{%' AND ("colors"::jsonb #> '{apps,productCard}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_drafts" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('header', "theme"::jsonb #> '{apps,header}')) #- '{apps,header}')::text, "revision" = "revision" + 1
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,header}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_drafts" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('footer', "theme"::jsonb #> '{apps,footer}')) #- '{apps,footer}')::text, "revision" = "revision" + 1
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,footer}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_drafts" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('product-card', "theme"::jsonb #> '{apps,productCard}')) #- '{apps,productCard}')::text, "revision" = "revision" + 1
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,productCard}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_versions" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('header', "theme"::jsonb #> '{apps,header}')) #- '{apps,header}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,header}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_versions" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('footer', "theme"::jsonb #> '{apps,footer}')) #- '{apps,footer}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,footer}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_versions" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('product-card', "theme"::jsonb #> '{apps,productCard}')) #- '{apps,productCard}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,productCard}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_versions" SET "theme" = (jsonb_set("theme"::jsonb, '{theme,apps,skins}', coalesce("theme"::jsonb #> '{theme,apps,skins}', '{}'::jsonb) || jsonb_build_object('header', "theme"::jsonb #> '{theme,apps,header}')) #- '{theme,apps,header}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{theme,apps,header}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_versions" SET "theme" = (jsonb_set("theme"::jsonb, '{theme,apps,skins}', coalesce("theme"::jsonb #> '{theme,apps,skins}', '{}'::jsonb) || jsonb_build_object('footer', "theme"::jsonb #> '{theme,apps,footer}')) #- '{theme,apps,footer}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{theme,apps,footer}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_settings_versions" SET "theme" = (jsonb_set("theme"::jsonb, '{theme,apps,skins}', coalesce("theme"::jsonb #> '{theme,apps,skins}', '{}'::jsonb) || jsonb_build_object('product-card', "theme"::jsonb #> '{theme,apps,productCard}')) #- '{theme,apps,productCard}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{theme,apps,productCard}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_restore_points" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('header', "theme"::jsonb #> '{apps,header}')) #- '{apps,header}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,header}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_restore_points" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('footer', "theme"::jsonb #> '{apps,footer}')) #- '{apps,footer}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,footer}') IS NOT NULL;
--> statement-breakpoint
UPDATE "theme_restore_points" SET "theme" = (jsonb_set("theme"::jsonb, '{apps,skins}', coalesce("theme"::jsonb #> '{apps,skins}', '{}'::jsonb) || jsonb_build_object('product-card', "theme"::jsonb #> '{apps,productCard}')) #- '{apps,productCard}')::text
WHERE "theme" LIKE '{%' AND ("theme"::jsonb #> '{apps,productCard}') IS NOT NULL;
--> statement-breakpoint
UPDATE "plugin_installations" SET "manifest_json" = (jsonb_set("manifest_json"::jsonb, '{storefront,skins}', coalesce((SELECT jsonb_agg(("slot"."value" - 'slot') || jsonb_build_object('target', "slot"."value" -> 'slot') ORDER BY "slot"."ordinality") FROM jsonb_array_elements("manifest_json"::jsonb #> '{storefront,slots}') WITH ORDINALITY AS "slot"("value", "ordinality")), '[]'::jsonb)) #- '{storefront,slots}')::text, "revision" = "revision" + 1
WHERE "manifest_json" LIKE '{%' AND jsonb_typeof("manifest_json"::jsonb #> '{storefront,slots}') = 'array';
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (153, '0153_theme_skins', 'd0be879752ec302b137e897dea2cd1bd0c1778240d556dbd9ab5e310f5f8ed02');
