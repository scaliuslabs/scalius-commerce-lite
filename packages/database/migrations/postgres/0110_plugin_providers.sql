-- Plugin platform, phase 3: provider ports, atomic app storage, risk holds.
-- - plugin_registrations admits the `provider` kind (one row per app and
--   provider port), so "who provides payment" is one index read that returns
--   nothing when no app does. Rebuilt with foreign keys on, every row kept.
-- - plugin_records.revision and plugin_kv.revision: the compare-and-set tokens
--   of app storage; existing rows start at 1.
-- - order_holds: an app's order.risk "hold" stops fulfilment until staff
--   release it (one row per order and app).
-- - Generated cache dependency triggers for plugin_installations,
--   plugin_registrations and plugin_records replace the keys the plugin
--   module used to advance in application code.
CREATE TABLE "order_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"app_name" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"released_at" bigint,
	"released_by" text,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("released_by") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_holds_id_shape" CHECK(length("order_holds"."id") = 36 AND substr("order_holds"."id", 1, 4) = 'ohd_'),
	CONSTRAINT "order_holds_app_name_length" CHECK(length("order_holds"."app_name") BETWEEN 1 AND 80),
	CONSTRAINT "order_holds_reason_length" CHECK(length("order_holds"."reason") BETWEEN 1 AND 1200),
	CONSTRAINT "order_holds_release_pair" CHECK(("order_holds"."released_at" IS NULL) OR ("order_holds"."released_at" >= "order_holds"."created_at"))
);
--> statement-breakpoint
CREATE INDEX "order_holds_open_idx" ON "order_holds" ("order_id") WHERE "order_holds"."released_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" DROP CONSTRAINT "plugin_registrations_kind_check", ADD CONSTRAINT "plugin_registrations_kind_check" CHECK("plugin_registrations"."kind" IN ('event', 'function', 'cron', 'provider'));
--> statement-breakpoint
ALTER TABLE "plugin_kv" ADD COLUMN "revision" bigint DEFAULT 1 NOT NULL CONSTRAINT "plugin_kv_revision_positive" CHECK ("revision" >= 1);
--> statement-breakpoint
ALTER TABLE "plugin_records" ADD COLUMN "revision" bigint DEFAULT 1 NOT NULL CONSTRAINT "plugin_records_revision_positive" CHECK ("revision" >= 1);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_installations_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || NEW."plugin_id", 'plg:*', 't:plugin_installations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_installations_ins"
AFTER INSERT ON "plugin_installations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_plugin_installations_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_installations_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || OLD."plugin_id", 'plg:*', 't:plugin_installations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_installations_del"
AFTER DELETE ON "plugin_installations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_plugin_installations_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_installations_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || NEW."plugin_id", 'plg:*', 't:plugin_installations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_installations_upd"
AFTER UPDATE ON "plugin_installations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id" OR OLD."version" IS DISTINCT FROM NEW."version" OR OLD."source" IS DISTINCT FROM NEW."source" OR OLD."bundle_sha256" IS DISTINCT FROM NEW."bundle_sha256" OR OLD."manifest_json" IS DISTINCT FROM NEW."manifest_json" OR OLD."grant_json" IS DISTINCT FROM NEW."grant_json" OR OLD."grant_key" IS DISTINCT FROM NEW."grant_key" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."settings_json" IS DISTINCT FROM NEW."settings_json"))
EXECUTE FUNCTION scalius_compat."cdep_plugin_installations_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_installations_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || OLD."plugin_id", 'plg:*', 't:plugin_installations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_installations_upd_old"
AFTER UPDATE ON "plugin_installations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id"))
EXECUTE FUNCTION scalius_compat."cdep_plugin_installations_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_registrations_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || NEW."plugin_id", 'plg:*', 't:plugin_registrations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_registrations_ins"
AFTER INSERT ON "plugin_registrations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_plugin_registrations_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_registrations_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || OLD."plugin_id", 'plg:*', 't:plugin_registrations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_registrations_del"
AFTER DELETE ON "plugin_registrations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_plugin_registrations_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_registrations_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || NEW."plugin_id", 'plg:*', 't:plugin_registrations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_registrations_upd"
AFTER UPDATE ON "plugin_registrations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id" OR OLD."priority" IS DISTINCT FROM NEW."priority"))
EXECUTE FUNCTION scalius_compat."cdep_plugin_registrations_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_registrations_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plg:' || OLD."plugin_id", 'plg:*', 't:plugin_registrations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_registrations_upd_old"
AFTER UPDATE ON "plugin_registrations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id"))
EXECUTE FUNCTION scalius_compat."cdep_plugin_registrations_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_records_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plgs:' || NEW."plugin_id" || ':' || NEW."collection", 't:plugin_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_records_ins"
AFTER INSERT ON "plugin_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_plugin_records_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_records_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plgs:' || OLD."plugin_id" || ':' || OLD."collection", 't:plugin_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_records_del"
AFTER DELETE ON "plugin_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_plugin_records_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_records_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plgs:' || NEW."plugin_id" || ':' || NEW."collection", 't:plugin_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_records_upd"
AFTER UPDATE ON "plugin_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id" OR OLD."collection" IS DISTINCT FROM NEW."collection" OR OLD."id" IS DISTINCT FROM NEW."id" OR OLD."data_json" IS DISTINCT FROM NEW."data_json"))
EXECUTE FUNCTION scalius_compat."cdep_plugin_records_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_plugin_records_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['plgs:' || OLD."plugin_id" || ':' || OLD."collection", 't:plugin_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_plugin_records_upd_old"
AFTER UPDATE ON "plugin_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id" OR OLD."collection" IS DISTINCT FROM NEW."collection"))
EXECUTE FUNCTION scalius_compat."cdep_plugin_records_upd_old_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (110, '0110_plugin_providers', '32b8eee16f47ec6363dd95a9ab710cfb6fcd8bcef8a2fbf86d9601aabe9c9dcd');
