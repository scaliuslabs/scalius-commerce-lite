-- Apps write the theme and the menus (the stable app API's theme.* and
-- menus.* operations), and templates name catalogue content by handle.
--
-- 1. Theme writes get their own sensitive permission, settings.theme.edit
--    (the Sensitive write_themes app scope confers it; settings.general.edit
--    would also open business, countries and media settings). Every role,
--    direct grant and agent grant that could edit general settings keeps
--    editing the theme: no staff member loses access.
-- 2. A restore point records an app's template applied over the draft
--    (reason 'app'): the table is rebuilt for the wider reason check.
-- 3. Collections get a handle (slug), unique in the store with trashed ones,
--    backfilled from the name (an ASCII reading; else collection-<id>, and a
--    repeated handle takes the id as its suffix). It is a visible column, so
--    its update trigger is reinstalled with it.
ALTER TABLE "theme_restore_points" DROP CONSTRAINT "theme_restore_points_reason_check";
--> statement-breakpoint
ALTER TABLE "theme_restore_points" ADD CONSTRAINT "theme_restore_points_reason_check" CHECK ("reason" IN ('restore', 'discard', 'app'));
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "slug" text COLLATE "C";
--> statement-breakpoint
UPDATE "collections" SET "slug" = trim(both '-' from substr(trim(both '-' from replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim("name")), ' ', '-'), chr(9), '-'), '_', '-'), '/', '-'), '.', '-'), ',', '-'), '&', '-'), '''', '-'), '(', '-'), ')', '-'), '[', '-'), ']', '-'), ':', '-'), ';', '-'), '!', '-'), '?', '-'), '+', '-'), '#', '-'), '@', '-'), '%', '-'), '*', '-'), '=', '-'), '|', '-'), '~', '-'), '^', '-'), '$', '-'), '<', '-'), '>', '-'), '{', '-'), '}', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-')), 1, 100));
--> statement-breakpoint
UPDATE "collections" SET "slug" = trim(both '-' from substr(trim(both '-' from replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim('collection-' || "id")), ' ', '-'), chr(9), '-'), '_', '-'), '/', '-'), '.', '-'), ',', '-'), '&', '-'), '''', '-'), '(', '-'), ')', '-'), '[', '-'), ']', '-'), ':', '-'), ';', '-'), '!', '-'), '?', '-'), '+', '-'), '#', '-'), '@', '-'), '%', '-'), '*', '-'), '=', '-'), '|', '-'), '~', '-'), '^', '-'), '$', '-'), '<', '-'), '>', '-'), '{', '-'), '}', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-')), 1, 100))
WHERE length("slug") < 3 OR "slug" ~ '[^a-z0-9-]';
--> statement-breakpoint
UPDATE "collections" SET "slug" = trim(both '-' from substr("slug", 1, 60)) || '-' || trim(both '-' from substr(trim(both '-' from replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim("id")), ' ', '-'), chr(9), '-'), '_', '-'), '/', '-'), '.', '-'), ',', '-'), '&', '-'), '''', '-'), '(', '-'), ')', '-'), '[', '-'), ']', '-'), ':', '-'), ';', '-'), '!', '-'), '?', '-'), '+', '-'), '#', '-'), '@', '-'), '%', '-'), '*', '-'), '=', '-'), '|', '-'), '~', '-'), '^', '-'), '$', '-'), '<', '-'), '>', '-'), '{', '-'), '}', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-')), 1, 100))
WHERE EXISTS (SELECT 1 FROM "collections" AS "earlier" WHERE "earlier"."slug" = "collections"."slug" AND "earlier"."id" < "collections"."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "collections_slug_idx" ON "collections" ("slug");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_collections_upd" ON "collections";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_collections_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['col:' || NEW."id", 'col:*', 't:collections']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_collections_upd"
AFTER UPDATE ON "collections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."slug" IS DISTINCT FROM NEW."slug" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."content" IS DISTINCT FROM NEW."content" OR OLD."presentation" IS DISTINCT FROM NEW."presentation" OR OLD."config" IS DISTINCT FROM NEW."config" OR OLD."sort_order" IS DISTINCT FROM NEW."sort_order" OR OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."meta_title" IS DISTINCT FROM NEW."meta_title" OR OLD."meta_description" IS DISTINCT FROM NEW."meta_description" OR OLD."canonical_path" IS DISTINCT FROM NEW."canonical_path" OR OLD."no_index" IS DISTINCT FROM NEW."no_index" OR OLD."exclude_from_sitemap" IS DISTINCT FROM NEW."exclude_from_sitemap" OR OLD."listing_template" IS DISTINCT FROM NEW."listing_template" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"))
EXECUTE FUNCTION scalius_compat."cdep_collections_upd_fn"();
--> statement-breakpoint
INSERT INTO "permissions" ("id", "name", "display_name", "description", "resource", "action", "category", "is_sensitive")
SELECT 'perm_settings_theme_edit', 'settings.theme.edit', 'Edit Theme', 'Edit, restore and publish the storefront theme', 'settings', 'theme.edit', 'Settings', 1
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "name" = 'settings.theme.edit');
--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT 'rpm_theme_edit_' || "granted"."role_id", "granted"."role_id", "theme"."id"
FROM "role_permissions" AS "granted"
JOIN "permissions" AS "general" ON "general"."id" = "granted"."permission_id" AND "general"."name" = 'settings.general.edit'
JOIN "permissions" AS "theme" ON "theme"."name" = 'settings.theme.edit'
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" AS "existing"
  WHERE "existing"."role_id" = "granted"."role_id" AND "existing"."permission_id" = "theme"."id"
);
--> statement-breakpoint
INSERT INTO "user_permissions" ("id", "user_id", "permission_id", "granted", "assigned_by")
SELECT 'upm_theme_edit_' || "direct"."user_id", "direct"."user_id", "theme"."id", "direct"."granted", "direct"."assigned_by"
FROM "user_permissions" AS "direct"
JOIN "permissions" AS "general" ON "general"."id" = "direct"."permission_id" AND "general"."name" = 'settings.general.edit'
JOIN "permissions" AS "theme" ON "theme"."name" = 'settings.theme.edit'
WHERE NOT EXISTS (
  SELECT 1 FROM "user_permissions" AS "existing"
  WHERE "existing"."user_id" = "direct"."user_id" AND "existing"."permission_id" = "theme"."id"
);
--> statement-breakpoint
-- A list that names settings.general.edit is a non-empty JSON array: append before its closing bracket.
UPDATE "agent_grants"
SET "permissions_json" = substr(rtrim("permissions_json"), 1, length(rtrim("permissions_json")) - 1) || ',"settings.theme.edit"]'
WHERE instr("permissions_json", '"settings.general.edit"') > 0 AND instr("permissions_json", '"settings.theme.edit"') = 0;
--> statement-breakpoint
UPDATE "agent_device_authorizations"
SET "requested_permissions_json" = substr(rtrim("requested_permissions_json"), 1, length(rtrim("requested_permissions_json")) - 1) || ',"settings.theme.edit"]'
WHERE instr("requested_permissions_json", '"settings.general.edit"') > 0 AND instr("requested_permissions_json", '"settings.theme.edit"') = 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (170, '0170_collection_slugs_and_theme_permission', 'd392d4f5489fb732bf8193dc3e01c6a048464950d9160839787d722d942cfa8a');
