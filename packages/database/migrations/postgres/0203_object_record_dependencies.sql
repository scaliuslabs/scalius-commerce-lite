-- A filtered public object read (an app component's reviews of the product
-- on the page) depends on its type's own row and on the records its filter
-- string leads, not on every record of the type: a published record also
-- advances obj:<type_id>:<lead> for each index slot led by a string (the
-- slot's first tuple component, index-encoding.ts), and a public type also
-- advances obj:<id>:type. The type's indexes are visible now (a filtered
-- read finds its slot by them). Triggers only, generated from
-- packages/shared/src/cache-deps.ts by packages/database/scripts/cache-dep-triggers.ts.
DROP TRIGGER IF EXISTS "cdep_object_types_ins" ON "object_types";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."id", 'obj:' || NEW."id" || ':type', 't:object_types']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_types_ins"
AFTER INSERT ON "object_types"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."storefront" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_types_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_types_del" ON "object_types";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."id", 'obj:' || OLD."id" || ':type', 't:object_types']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_types_del"
AFTER DELETE ON "object_types"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."storefront" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_types_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_types_upd" ON "object_types";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."id", 'obj:' || NEW."id" || ':type', 't:object_types']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_types_upd"
AFTER UPDATE ON "object_types"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."namespace" IS DISTINCT FROM NEW."namespace" OR OLD."type" IS DISTINCT FROM NEW."type" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."fields_json" IS DISTINCT FROM NEW."fields_json" OR OLD."indexes_json" IS DISTINCT FROM NEW."indexes_json" OR OLD."display_field" IS DISTINCT FROM NEW."display_field" OR OLD."storefront" IS DISTINCT FROM NEW."storefront" OR OLD."handle" IS DISTINCT FROM NEW."handle") AND NEW."storefront" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_types_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_types_upd_old" ON "object_types";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."id", 'obj:' || OLD."id" || ':type', 't:object_types']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_types_upd_old"
AFTER UPDATE ON "object_types"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."storefront" IS DISTINCT FROM NEW."storefront") AND OLD."storefront" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_types_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_records_ins" ON "object_records";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."type_id", 'obj:' || NEW."type_id" || ':' || substr(NEW."k1", nullif(strpos(substr(NEW."k1", 1, 2), '05'), 0), strpos(NEW."k1", '0001') + 3), 'obj:' || NEW."type_id" || ':' || substr(NEW."k2", nullif(strpos(substr(NEW."k2", 1, 2), '05'), 0), strpos(NEW."k2", '0001') + 3), 'obj:' || NEW."type_id" || ':' || substr(NEW."k3", nullif(strpos(substr(NEW."k3", 1, 2), '05'), 0), strpos(NEW."k3", '0001') + 3), 'obj:' || NEW."type_id" || ':' || substr(NEW."k4", nullif(strpos(substr(NEW."k4", 1, 2), '05'), 0), strpos(NEW."k4", '0001') + 3), 't:object_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_records_ins"
AFTER INSERT ON "object_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."pub" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_records_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_records_del" ON "object_records";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."type_id", 'obj:' || OLD."type_id" || ':' || substr(OLD."k1", nullif(strpos(substr(OLD."k1", 1, 2), '05'), 0), strpos(OLD."k1", '0001') + 3), 'obj:' || OLD."type_id" || ':' || substr(OLD."k2", nullif(strpos(substr(OLD."k2", 1, 2), '05'), 0), strpos(OLD."k2", '0001') + 3), 'obj:' || OLD."type_id" || ':' || substr(OLD."k3", nullif(strpos(substr(OLD."k3", 1, 2), '05'), 0), strpos(OLD."k3", '0001') + 3), 'obj:' || OLD."type_id" || ':' || substr(OLD."k4", nullif(strpos(substr(OLD."k4", 1, 2), '05'), 0), strpos(OLD."k4", '0001') + 3), 't:object_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_records_del"
AFTER DELETE ON "object_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."pub" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_records_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_records_upd" ON "object_records";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."type_id", 'obj:' || NEW."type_id" || ':' || substr(NEW."k1", nullif(strpos(substr(NEW."k1", 1, 2), '05'), 0), strpos(NEW."k1", '0001') + 3), 'obj:' || NEW."type_id" || ':' || substr(NEW."k2", nullif(strpos(substr(NEW."k2", 1, 2), '05'), 0), strpos(NEW."k2", '0001') + 3), 'obj:' || NEW."type_id" || ':' || substr(NEW."k3", nullif(strpos(substr(NEW."k3", 1, 2), '05'), 0), strpos(NEW."k3", '0001') + 3), 'obj:' || NEW."type_id" || ':' || substr(NEW."k4", nullif(strpos(substr(NEW."k4", 1, 2), '05'), 0), strpos(NEW."k4", '0001') + 3), 't:object_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_records_upd"
AFTER UPDATE ON "object_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."type_id" IS DISTINCT FROM NEW."type_id" OR OLD."id" IS DISTINCT FROM NEW."id" OR OLD."handle" IS DISTINCT FROM NEW."handle" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."data_json" IS DISTINCT FROM NEW."data_json" OR OLD."k1" IS DISTINCT FROM NEW."k1" OR OLD."k2" IS DISTINCT FROM NEW."k2" OR OLD."k3" IS DISTINCT FROM NEW."k3" OR OLD."k4" IS DISTINCT FROM NEW."k4" OR OLD."pub" IS DISTINCT FROM NEW."pub" OR OLD."position" IS DISTINCT FROM NEW."position") AND NEW."pub" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_records_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_object_records_upd_old" ON "object_records";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."type_id", 'obj:' || OLD."type_id" || ':' || substr(OLD."k1", nullif(strpos(substr(OLD."k1", 1, 2), '05'), 0), strpos(OLD."k1", '0001') + 3), 'obj:' || OLD."type_id" || ':' || substr(OLD."k2", nullif(strpos(substr(OLD."k2", 1, 2), '05'), 0), strpos(OLD."k2", '0001') + 3), 'obj:' || OLD."type_id" || ':' || substr(OLD."k3", nullif(strpos(substr(OLD."k3", 1, 2), '05'), 0), strpos(OLD."k3", '0001') + 3), 'obj:' || OLD."type_id" || ':' || substr(OLD."k4", nullif(strpos(substr(OLD."k4", 1, 2), '05'), 0), strpos(OLD."k4", '0001') + 3), 't:object_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_records_upd_old"
AFTER UPDATE ON "object_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."type_id" IS DISTINCT FROM NEW."type_id" OR OLD."k1" IS DISTINCT FROM NEW."k1" OR OLD."k2" IS DISTINCT FROM NEW."k2" OR OLD."k3" IS DISTINCT FROM NEW."k3" OR OLD."k4" IS DISTINCT FROM NEW."k4" OR OLD."pub" IS DISTINCT FROM NEW."pub") AND OLD."pub" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_records_upd_old_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (203, '0203_object_record_dependencies', '02900ac329e9a6086cda801280cb24568bba60afd8b2aecd4f694b88f5d5ee32');
