DROP TABLE IF EXISTS "metaobject_entries";
--> statement-breakpoint
DROP TABLE IF EXISTS "metaobject_definitions";
--> statement-breakpoint
DROP TABLE IF EXISTS "plugin_records";
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_definitions_ins_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_definitions_del_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_definitions_upd_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_definitions_upd_old_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_entries_ins_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_entries_del_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_entries_upd_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_metaobject_entries_upd_old_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_plugin_records_ins_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_plugin_records_del_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_plugin_records_upd_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."cdep_plugin_records_upd_old_fn"();
--> statement-breakpoint
CREATE TABLE "event_demand" (
	"filter" text COLLATE "C" PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_types" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"namespace" text COLLATE "C" NOT NULL,
	"type" text COLLATE "C" NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"description" text COLLATE "C",
	"fields_json" text COLLATE "C" NOT NULL,
	"indexes_json" text COLLATE "C" DEFAULT '[]' NOT NULL,
	"unique_json" text COLLATE "C" DEFAULT '[]' NOT NULL,
	"display_field" text COLLATE "C",
	"storefront" bigint DEFAULT 0 NOT NULL,
	"admin" text COLLATE "C" DEFAULT 'none' NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"handle" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "object_types_id_shape" CHECK("object_types"."id" = 'oty_' || "object_types"."namespace" || '.' || "object_types"."type"),
	CONSTRAINT "object_types_namespace_shape" CHECK("object_types"."namespace" = 'custom' OR (length("object_types"."namespace") BETWEEN 3 AND 101 AND "object_types"."namespace" !~ '[^a-z0-9.-]' AND position('.' in "object_types"."namespace") > 1 AND position('.' in "object_types"."namespace") < length("object_types"."namespace"))),
	CONSTRAINT "object_types_type_shape" CHECK(length("object_types"."type") BETWEEN 2 AND 48 AND "object_types"."type" !~ '[^_a-z0-9]' AND substr("object_types"."type", 1, 1) ~ '^[a-z]$'),
	CONSTRAINT "object_types_name_valid" CHECK("object_types"."name" = trim("object_types"."name") AND length("object_types"."name") BETWEEN 1 AND 80),
	CONSTRAINT "object_types_description_length" CHECK("object_types"."description" IS NULL OR length("object_types"."description") <= 300),
	CONSTRAINT "object_types_fields_json" CHECK(json_valid("object_types"."fields_json") AND json_type("object_types"."fields_json") = 'array' AND length("object_types"."fields_json") <= 65536),
	CONSTRAINT "object_types_indexes_json" CHECK(json_valid("object_types"."indexes_json") AND json_type("object_types"."indexes_json") = 'array' AND length("object_types"."indexes_json") <= 2048),
	CONSTRAINT "object_types_unique_json" CHECK(json_valid("object_types"."unique_json") AND json_type("object_types"."unique_json") = 'array' AND length("object_types"."unique_json") <= 1024),
	CONSTRAINT "object_types_admin_check" CHECK("object_types"."admin" IN ('none', 'read', 'edit')),
	CONSTRAINT "object_types_flags" CHECK("object_types"."storefront" IN (0, 1) AND "object_types"."events" IN (0, 1) AND "object_types"."handle" IN (0, 1)),
	CONSTRAINT "object_types_revision_positive" CHECK("object_types"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "object_records" (
	"type_id" text COLLATE "C" NOT NULL,
	"id" text COLLATE "C" NOT NULL,
	"handle" text COLLATE "C",
	"status" text COLLATE "C" DEFAULT 'active' NOT NULL,
	"data_json" text COLLATE "C" NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"k1" text COLLATE "C",
	"k2" text COLLATE "C",
	"k3" text COLLATE "C",
	"k4" text COLLATE "C",
	"u1" text COLLATE "C",
	"u2" text COLLATE "C",
	"pub" bigint DEFAULT 0 NOT NULL,
	"ev" bigint DEFAULT 0 NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("type_id", "id"),
	FOREIGN KEY ("type_id") REFERENCES "object_types"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "object_records_id_length" CHECK(length("object_records"."id") BETWEEN 1 AND 128),
	CONSTRAINT "object_records_handle_shape" CHECK("object_records"."handle" IS NULL OR (length("object_records"."handle") BETWEEN 1 AND 100 AND "object_records"."handle" !~ '[^a-z0-9-]' AND substr("object_records"."handle", 1, 1) <> '-' AND substr("object_records"."handle", length("object_records"."handle"), 1) <> '-')),
	CONSTRAINT "object_records_status_check" CHECK("object_records"."status" IN ('active', 'draft', 'published')),
	CONSTRAINT "object_records_data_json" CHECK(json_valid("object_records"."data_json") AND json_type("object_records"."data_json") = 'object' AND length("object_records"."data_json") <= 65536),
	CONSTRAINT "object_records_revision_positive" CHECK("object_records"."revision" >= 1),
	CONSTRAINT "object_records_flags" CHECK("object_records"."pub" IN (0, 1) AND "object_records"."ev" IN (0, 1) AND ("object_records"."pub" = 0 OR "object_records"."status" = 'published')),
	CONSTRAINT "object_records_position_range" CHECK("object_records"."position" BETWEEN 0 AND 1000000),
	CONSTRAINT "object_records_k1_hex" CHECK("object_records"."k1" IS NULL OR (length("object_records"."k1") BETWEEN 2 AND 2048 AND "object_records"."k1" !~ '[^0-9a-f]')),
	CONSTRAINT "object_records_k2_hex" CHECK("object_records"."k2" IS NULL OR (length("object_records"."k2") BETWEEN 2 AND 2048 AND "object_records"."k2" !~ '[^0-9a-f]')),
	CONSTRAINT "object_records_k3_hex" CHECK("object_records"."k3" IS NULL OR (length("object_records"."k3") BETWEEN 2 AND 2048 AND "object_records"."k3" !~ '[^0-9a-f]')),
	CONSTRAINT "object_records_k4_hex" CHECK("object_records"."k4" IS NULL OR (length("object_records"."k4") BETWEEN 2 AND 2048 AND "object_records"."k4" !~ '[^0-9a-f]')),
	CONSTRAINT "object_records_u1_hex" CHECK("object_records"."u1" IS NULL OR (length("object_records"."u1") BETWEEN 2 AND 2048 AND "object_records"."u1" !~ '[^0-9a-f]')),
	CONSTRAINT "object_records_u2_hex" CHECK("object_records"."u2" IS NULL OR (length("object_records"."u2") BETWEEN 2 AND 2048 AND "object_records"."u2" !~ '[^0-9a-f]'))
);
--> statement-breakpoint
CREATE INDEX "object_records_k1" ON "object_records" ("type_id","k1","id") WHERE "object_records"."k1" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "object_records_k2" ON "object_records" ("type_id","k2","id") WHERE "object_records"."k2" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "object_records_k3" ON "object_records" ("type_id","k3","id") WHERE "object_records"."k3" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "object_records_k4" ON "object_records" ("type_id","k4","id") WHERE "object_records"."k4" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "object_records_u1" ON "object_records" ("type_id","u1") WHERE "object_records"."u1" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "object_records_u2" ON "object_records" ("type_id","u2") WHERE "object_records"."u2" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "object_records_handle" ON "object_records" ("type_id","handle") WHERE "object_records"."handle" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "object_records_public_position" ON "object_records" ("type_id","position","id") WHERE "object_records"."pub" = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "object_types_namespace_type_unique" ON "object_types" ("namespace","type");
--> statement-breakpoint
ALTER TABLE "abandoned_checkouts" ADD "abandoned_at" bigint;
--> statement-breakpoint
CREATE INDEX "abandoned_checkouts_pending_idx" ON "abandoned_checkouts" ("abandoned_at","updated_at","id");
--> statement-breakpoint
ALTER TABLE "orders" ADD "attributes" text COLLATE "C" DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD "rate_source" text COLLATE "C" DEFAULT 'flat' NOT NULL;
--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD "rate_service" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD "fallback_fee_minor" bigint;
--> statement-breakpoint
INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
--> statement-breakpoint
DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_webhook_insert_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_webhook_insert_0" AFTER INSERT ON webhook_subscriptions
FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION scalius_compat."demand_webhook_insert_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_webhook_insert_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_webhook_insert_1" AFTER INSERT ON webhook_subscriptions
FOR EACH ROW WHEN (NEW.status = 'active') EXECUTE FUNCTION scalius_compat."demand_webhook_insert_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_webhook_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_webhook_update_0" AFTER UPDATE OF status, topics ON webhook_subscriptions
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.topics IS DISTINCT FROM NEW.topics) EXECUTE FUNCTION scalius_compat."demand_webhook_update_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_webhook_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_webhook_update_1" AFTER UPDATE OF status, topics ON webhook_subscriptions
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.topics IS DISTINCT FROM NEW.topics) EXECUTE FUNCTION scalius_compat."demand_webhook_update_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_webhook_delete_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_webhook_delete_0" AFTER DELETE ON webhook_subscriptions
FOR EACH ROW WHEN (OLD.status = 'active') EXECUTE FUNCTION scalius_compat."demand_webhook_delete_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_webhook_delete_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_webhook_delete_1" AFTER DELETE ON webhook_subscriptions
FOR EACH ROW WHEN (OLD.status = 'active') EXECUTE FUNCTION scalius_compat."demand_webhook_delete_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_plugin_insert_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_insert_0" AFTER INSERT ON plugin_registrations
FOR EACH ROW WHEN (NEW.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_insert_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_plugin_insert_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_insert_1" AFTER INSERT ON plugin_registrations
FOR EACH ROW WHEN (NEW.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_insert_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_plugin_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_update_0" AFTER UPDATE OF kind, name, plugin_id ON plugin_registrations
FOR EACH ROW WHEN (OLD.kind = 'event' OR NEW.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_update_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_plugin_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_update_1" AFTER UPDATE OF kind, name, plugin_id ON plugin_registrations
FOR EACH ROW WHEN (OLD.kind = 'event' OR NEW.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_update_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_plugin_delete_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_delete_0" AFTER DELETE ON plugin_registrations
FOR EACH ROW WHEN (OLD.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_delete_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_plugin_delete_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_delete_1" AFTER DELETE ON plugin_registrations
FOR EACH ROW WHEN (OLD.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_delete_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_installation_status_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_installation_status_0" AFTER UPDATE OF status ON plugin_installations
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION scalius_compat."demand_installation_status_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_installation_status_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_installation_status_1" AFTER UPDATE OF status ON plugin_installations
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION scalius_compat."demand_installation_status_1_fn"();
--> statement-breakpoint
UPDATE permissions SET name = 'objects.view', resource = 'objects', display_name = 'View objects' WHERE name = 'metaobjects.view';
--> statement-breakpoint
UPDATE permissions SET name = 'objects.edit', resource = 'objects', display_name = 'Edit objects' WHERE name = 'metaobjects.edit';
--> statement-breakpoint
UPDATE agent_grants SET permissions_json = replace(replace(permissions_json, '"metaobjects.view"', '"objects.view"'), '"metaobjects.edit"', '"objects.edit"') WHERE position('"metaobjects.' in permissions_json) > 0;
--> statement-breakpoint
UPDATE agent_device_authorizations SET requested_permissions_json = replace(replace(requested_permissions_json, '"metaobjects.view"', '"objects.view"'), '"metaobjects.edit"', '"objects.edit"') WHERE position('"metaobjects.' in requested_permissions_json) > 0;
--> statement-breakpoint
DELETE FROM theme_preview_sessions;
--> statement-breakpoint
DELETE FROM theme_restore_points;
--> statement-breakpoint
DELETE FROM theme_settings_versions;
--> statement-breakpoint
DELETE FROM theme_settings_drafts;
--> statement-breakpoint
DELETE FROM theme_settings;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_shipping_methods_upd" ON "shipping_methods";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_shipping_methods_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['ship', 't:shipping_methods']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_shipping_methods_upd"
AFTER UPDATE ON "shipping_methods"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."fee_minor" IS DISTINCT FROM NEW."fee_minor" OR OLD."rate_source" IS DISTINCT FROM NEW."rate_source" OR OLD."rate_service" IS DISTINCT FROM NEW."rate_service" OR OLD."fallback_fee_minor" IS DISTINCT FROM NEW."fallback_fee_minor" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."sort_order" IS DISTINCT FROM NEW."sort_order" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at" OR OLD."zone_id" IS DISTINCT FROM NEW."zone_id" OR OLD."free_over_minor" IS DISTINCT FROM NEW."free_over_minor" OR OLD."pickup_address" IS DISTINCT FROM NEW."pickup_address" OR OLD."pickup_hours" IS DISTINCT FROM NEW."pickup_hours" OR OLD."kind" IS DISTINCT FROM NEW."kind"))
EXECUTE FUNCTION scalius_compat."cdep_shipping_methods_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."id", 't:object_types']::text[]) AS key_list(value)));
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
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."id", 't:object_types']::text[]) AS key_list(value)));
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
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."id", 't:object_types']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_types_upd"
AFTER UPDATE ON "object_types"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."namespace" IS DISTINCT FROM NEW."namespace" OR OLD."type" IS DISTINCT FROM NEW."type" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."fields_json" IS DISTINCT FROM NEW."fields_json" OR OLD."display_field" IS DISTINCT FROM NEW."display_field" OR OLD."storefront" IS DISTINCT FROM NEW."storefront" OR OLD."handle" IS DISTINCT FROM NEW."handle") AND NEW."storefront" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_types_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_types_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."id", 't:object_types']::text[]) AS key_list(value)));
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
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."type_id", 't:object_records']::text[]) AS key_list(value)));
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
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."type_id", 't:object_records']::text[]) AS key_list(value)));
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
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || NEW."type_id", 't:object_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_records_upd"
AFTER UPDATE ON "object_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."type_id" IS DISTINCT FROM NEW."type_id" OR OLD."id" IS DISTINCT FROM NEW."id" OR OLD."handle" IS DISTINCT FROM NEW."handle" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."data_json" IS DISTINCT FROM NEW."data_json" OR OLD."pub" IS DISTINCT FROM NEW."pub" OR OLD."position" IS DISTINCT FROM NEW."position") AND NEW."pub" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_records_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_object_records_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['obj:' || OLD."type_id", 't:object_records']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_object_records_upd_old"
AFTER UPDATE ON "object_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."type_id" IS DISTINCT FROM NEW."type_id" OR OLD."pub" IS DISTINCT FROM NEW."pub") AND OLD."pub" = 1)
EXECUTE FUNCTION scalius_compat."cdep_object_records_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_created" ON "orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_created_from_incomplete" ON "orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_updated" ON "orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_paid_insert" ON "orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_paid" ON "orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_cancelled" ON "orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_order_fulfillments_created" ON "order_fulfillments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_order_payments_refunded_insert" ON "order_payments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_order_payments_refunded" ON "order_payments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_order_returns_created" ON "order_returns";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_order_returns_status" ON "order_returns";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_products_created" ON "products";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_products_updated" ON "products";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_products_trashed" ON "products";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_products_deleted" ON "products";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_product_channel_publications_published" ON "product_channel_publications";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_product_channel_publications_republished" ON "product_channel_publications";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_product_channel_publications_unpublished" ON "product_channel_publications";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_product_channel_publications_removed" ON "product_channel_publications";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_inventory_movements_stock" ON "inventory_movements";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_inventory_movements_reverted" ON "inventory_movements";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_purchase_orders_created" ON "purchase_orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_purchase_orders_changed" ON "purchase_orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_purchase_orders_deleted" ON "purchase_orders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_inventory_transfers_created" ON "inventory_transfers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_inventory_transfers_changed" ON "inventory_transfers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_inventory_transfers_deleted" ON "inventory_transfers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customers_created" ON "customers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customers_updated" ON "customers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_addresses_created" ON "customer_addresses";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_addresses_changed" ON "customer_addresses";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_addresses_deleted" ON "customer_addresses";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_marketing_consents_created" ON "customer_marketing_consents";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_marketing_consents_changed" ON "customer_marketing_consents";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_fulfillments_created" ON "order_fulfillments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_fulfillments_voided" ON "order_fulfillments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_shipments_status" ON "delivery_shipments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_payments_insert" ON "order_payments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_payments_update" ON "order_payments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_checkouts_abandoned" ON "abandoned_checkouts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_promotions_created" ON "promotions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_promotions_updated" ON "promotions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_promotions_trashed" ON "promotions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_promotions_deleted" ON "promotions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_promotions_redeemed" ON "promotion_redemptions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_reviews_insert" ON "product_reviews";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_reviews_update" ON "product_reviews";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_gift_cards_insert" ON "gift_cards";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_gift_cards_update" ON "gift_cards";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_gift_card_transactions_created" ON "gift_card_transactions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_objects_insert" ON "object_records";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_objects_update" ON "object_records";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_objects_delete" ON "object_records";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.created', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'status', NEW."status", 'paymentStatus', NEW."payment_status", 'channel', NEW."channel")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_created"
AFTER INSERT ON "orders"
FOR EACH ROW
WHEN (NEW."status" <> 'incomplete')
EXECUTE FUNCTION scalius_compat."evt_orders_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_created_from_incomplete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.created', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'status', NEW."status", 'paymentStatus', NEW."payment_status", 'channel', NEW."channel")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_created_from_incomplete"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((OLD."status" = 'incomplete' AND NEW."status" NOT IN ('incomplete', 'cancelled')))
EXECUTE FUNCTION scalius_compat."evt_orders_created_from_incomplete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.updated', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status", 'previousPaymentStatus', OLD."payment_status", 'paymentStatus', NEW."payment_status", 'previousFulfillmentStatus', OLD."fulfillment_status", 'fulfillmentStatus', NEW."fulfillment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_updated"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((OLD."status" <> 'incomplete' AND NEW."status" <> 'incomplete' AND (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."payment_status" IS DISTINCT FROM NEW."payment_status" OR OLD."fulfillment_status" IS DISTINCT FROM NEW."fulfillment_status" OR OLD."payment_method" IS DISTINCT FROM NEW."payment_method" OR OLD."paid_amount_minor" IS DISTINCT FROM NEW."paid_amount_minor" OR OLD."balance_due_minor" IS DISTINCT FROM NEW."balance_due_minor" OR OLD."subtotal_amount_minor" IS DISTINCT FROM NEW."subtotal_amount_minor" OR OLD."shipping_amount_minor" IS DISTINCT FROM NEW."shipping_amount_minor" OR OLD."discount_amount_minor" IS DISTINCT FROM NEW."discount_amount_minor" OR OLD."tax_amount_minor" IS DISTINCT FROM NEW."tax_amount_minor" OR OLD."total_amount_minor" IS DISTINCT FROM NEW."total_amount_minor" OR OLD."customer_name" IS DISTINCT FROM NEW."customer_name" OR OLD."customer_phone" IS DISTINCT FROM NEW."customer_phone" OR OLD."customer_email" IS DISTINCT FROM NEW."customer_email" OR OLD."customer_whatsapp" IS DISTINCT FROM NEW."customer_whatsapp" OR OLD."shipping_address" IS DISTINCT FROM NEW."shipping_address" OR OLD."shipping_address_line2" IS DISTINCT FROM NEW."shipping_address_line2" OR OLD."shipping_country_code" IS DISTINCT FROM NEW."shipping_country_code" OR OLD."shipping_dependent_locality" IS DISTINCT FROM NEW."shipping_dependent_locality" OR OLD."shipping_locality" IS DISTINCT FROM NEW."shipping_locality" OR OLD."shipping_admin_area" IS DISTINCT FROM NEW."shipping_admin_area" OR OLD."shipping_postal_code" IS DISTINCT FROM NEW."shipping_postal_code" OR OLD."shipping_company" IS DISTINCT FROM NEW."shipping_company" OR OLD."shipping_name" IS DISTINCT FROM NEW."shipping_name" OR OLD."shipping_phone" IS DISTINCT FROM NEW."shipping_phone" OR OLD."shipping_validation_skipped" IS DISTINCT FROM NEW."shipping_validation_skipped" OR OLD."city" IS DISTINCT FROM NEW."city" OR OLD."zone" IS DISTINCT FROM NEW."zone" OR OLD."area" IS DISTINCT FROM NEW."area" OR OLD."billing_same_as_shipping" IS DISTINCT FROM NEW."billing_same_as_shipping" OR OLD."billing_name" IS DISTINCT FROM NEW."billing_name" OR OLD."billing_company" IS DISTINCT FROM NEW."billing_company" OR OLD."billing_address" IS DISTINCT FROM NEW."billing_address" OR OLD."billing_address_line2" IS DISTINCT FROM NEW."billing_address_line2" OR OLD."billing_country_code" IS DISTINCT FROM NEW."billing_country_code" OR OLD."billing_dependent_locality" IS DISTINCT FROM NEW."billing_dependent_locality" OR OLD."billing_locality" IS DISTINCT FROM NEW."billing_locality" OR OLD."billing_admin_area" IS DISTINCT FROM NEW."billing_admin_area" OR OLD."billing_postal_code" IS DISTINCT FROM NEW."billing_postal_code" OR OLD."billing_phone" IS DISTINCT FROM NEW."billing_phone" OR OLD."billing_validation_skipped" IS DISTINCT FROM NEW."billing_validation_skipped" OR OLD."notes" IS DISTINCT FROM NEW."notes" OR OLD."shipping_method_id" IS DISTINCT FROM NEW."shipping_method_id" OR OLD."pickup_ready_at" IS DISTINCT FROM NEW."pickup_ready_at" OR OLD."expected_delivery" IS DISTINCT FROM NEW."expected_delivery" OR OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."channel_source" IS DISTINCT FROM NEW."channel_source" OR OLD."invoice_number" IS DISTINCT FROM NEW."invoice_number" OR OLD."archived_at" IS DISTINCT FROM NEW."archived_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at")))
EXECUTE FUNCTION scalius_compat."evt_orders_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_paid_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.paid')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.paid', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousPaymentStatus', NULL, 'paymentStatus', NEW."payment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_paid_insert"
AFTER INSERT ON "orders"
FOR EACH ROW
WHEN ((NEW."payment_status" = 'paid' AND NEW."status" <> 'incomplete'))
EXECUTE FUNCTION scalius_compat."evt_orders_paid_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_paid_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.paid')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.paid', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousPaymentStatus', OLD."payment_status", 'paymentStatus', NEW."payment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_paid"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((NEW."payment_status" = 'paid' AND OLD."payment_status" IS DISTINCT FROM 'paid' AND NEW."status" <> 'incomplete'))
EXECUTE FUNCTION scalius_compat."evt_orders_paid_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_cancelled_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.cancelled')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.cancelled', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousStatus', OLD."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_cancelled"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((NEW."status" = 'cancelled' AND OLD."status" NOT IN ('cancelled', 'incomplete')))
EXECUTE FUNCTION scalius_compat."evt_orders_cancelled_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_fulfillments_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.fulfilled')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.fulfilled', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'fulfillmentId', NEW."id", 'kind', NEW."kind", 'locationId', NEW."location_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_fulfillments_created"
AFTER INSERT ON "order_fulfillments"
FOR EACH ROW
WHEN (NEW."status" = 'active')
EXECUTE FUNCTION scalius_compat."evt_order_fulfillments_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_payments_refunded_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.refunded')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.refunded', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'paymentId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_payments_refunded_insert"
AFTER INSERT ON "order_payments"
FOR EACH ROW
WHEN ((NEW."payment_type" = 'refund' AND NEW."status" = 'refunded'))
EXECUTE FUNCTION scalius_compat."evt_order_payments_refunded_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_payments_refunded_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'order.*', 'order.refunded')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.refunded', 'order', NEW."order_id", jsonb_build_object('orderId', NEW."order_id", 'paymentId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_payments_refunded"
AFTER UPDATE ON "order_payments"
FOR EACH ROW
WHEN ((NEW."payment_type" = 'refund' AND NEW."status" = 'refunded' AND OLD."status" IS DISTINCT FROM 'refunded'))
EXECUTE FUNCTION scalius_compat."evt_order_payments_refunded_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_returns_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'return.*', 'return.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'return.updated', 'return', NEW."id", jsonb_build_object('returnId', NEW."id", 'orderId', NEW."order_id", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_returns_created"
AFTER INSERT ON "order_returns"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_order_returns_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_order_returns_status_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'return.*', 'return.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'return.updated', 'return', NEW."id", jsonb_build_object('returnId', NEW."id", 'orderId', NEW."order_id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_order_returns_status"
AFTER UPDATE ON "order_returns"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_order_returns_status_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.created', 'product', NEW."id", jsonb_build_object('productId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_created"
AFTER INSERT ON "products"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_products_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.updated', 'product', NEW."id", jsonb_build_object('productId', NEW."id", 'revision', NEW."aggregate_revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_updated"
AFTER UPDATE ON "products"
FOR EACH ROW
WHEN ((NEW."deleted_at" IS NULL AND ((OLD."aggregate_revision" IS DISTINCT FROM NEW."aggregate_revision" OR OLD."tax_classification_version" IS DISTINCT FROM NEW."tax_classification_version") OR OLD."deleted_at" IS NOT NULL)))
EXECUTE FUNCTION scalius_compat."evt_products_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_trashed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.deleted')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.deleted', 'product', NEW."id", jsonb_build_object('productId', NEW."id", 'deletion', 'trashed')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_trashed"
AFTER UPDATE ON "products"
FOR EACH ROW
WHEN ((OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_products_trashed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_products_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.deleted')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.deleted', 'product', OLD."id", jsonb_build_object('productId', OLD."id", 'deletion', 'permanent')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_products_deleted"
AFTER DELETE ON "products"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_products_deleted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_published_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', NEW."product_id", jsonb_build_object('productId', NEW."product_id", 'channelId', NEW."channel_id", 'state', 'published')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_published"
AFTER INSERT ON "product_channel_publications"
FOR EACH ROW
WHEN (NEW."unpublished_at" IS NULL)
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_published_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_republished_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', NEW."product_id", jsonb_build_object('productId', NEW."product_id", 'channelId', NEW."channel_id", 'state', 'published')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_republished"
AFTER UPDATE ON "product_channel_publications"
FOR EACH ROW
WHEN ((OLD."unpublished_at" IS NOT NULL AND NEW."unpublished_at" IS NULL))
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_republished_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_unpublished_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', NEW."product_id", jsonb_build_object('productId', NEW."product_id", 'channelId', NEW."channel_id", 'state', 'unpublished')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_unpublished"
AFTER UPDATE ON "product_channel_publications"
FOR EACH ROW
WHEN ((OLD."unpublished_at" IS NULL AND NEW."unpublished_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_unpublished_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_removed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'product.*', 'product.publication_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', OLD."product_id", jsonb_build_object('productId', OLD."product_id", 'channelId', OLD."channel_id", 'state', 'unpublished')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_removed"
AFTER DELETE ON "product_channel_publications"
FOR EACH ROW
WHEN (OLD."unpublished_at" IS NULL)
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_removed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_movements_stock_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.level_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.level_changed', 'variant', NEW."variant_id", jsonb_build_object('variantId', NEW."variant_id", 'productId', (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."variant_id"), 'locationId', NEW."location_id", 'quantityDelta', NEW."stock_delta", 'movementId', NEW."id", 'movementType', NEW."type")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_movements_stock"
AFTER INSERT ON "inventory_movements"
FOR EACH ROW
WHEN (NEW."stock_delta" <> 0)
EXECUTE FUNCTION scalius_compat."evt_inventory_movements_stock_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_movements_reverted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.level_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.level_changed', 'variant', OLD."variant_id", jsonb_build_object('variantId', OLD."variant_id", 'productId', (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."variant_id"), 'locationId', OLD."location_id", 'quantityDelta', -OLD."stock_delta", 'movementId', OLD."id", 'movementType', 'reversal')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_movements_reverted"
AFTER DELETE ON "inventory_movements"
FOR EACH ROW
WHEN (OLD."stock_delta" <> 0)
EXECUTE FUNCTION scalius_compat."evt_inventory_movements_reverted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_purchase_orders_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.purchase_order_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.purchase_order_updated', 'purchase_order', NEW."id", jsonb_build_object('purchaseOrderId', NEW."id", 'previousStatus', NULL, 'status', NEW."status", 'revision', NEW."revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_purchase_orders_created"
AFTER INSERT ON "purchase_orders"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_purchase_orders_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_purchase_orders_changed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.purchase_order_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.purchase_order_updated', 'purchase_order', NEW."id", jsonb_build_object('purchaseOrderId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status", 'revision', NEW."revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_purchase_orders_changed"
AFTER UPDATE ON "purchase_orders"
FOR EACH ROW
WHEN ((OLD."revision" IS DISTINCT FROM NEW."revision"))
EXECUTE FUNCTION scalius_compat."evt_purchase_orders_changed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_purchase_orders_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.purchase_order_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.purchase_order_updated', 'purchase_order', OLD."id", jsonb_build_object('purchaseOrderId', OLD."id", 'previousStatus', OLD."status", 'status', 'deleted', 'revision', OLD."revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_purchase_orders_deleted"
AFTER DELETE ON "purchase_orders"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_purchase_orders_deleted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_transfers_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.transfer_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.transfer_updated', 'inventory_transfer', NEW."id", jsonb_build_object('transferId', NEW."id", 'previousStatus', NULL, 'status', NEW."status", 'revision', NEW."revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_transfers_created"
AFTER INSERT ON "inventory_transfers"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_inventory_transfers_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_transfers_changed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.transfer_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.transfer_updated', 'inventory_transfer', NEW."id", jsonb_build_object('transferId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status", 'revision', NEW."revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_transfers_changed"
AFTER UPDATE ON "inventory_transfers"
FOR EACH ROW
WHEN ((OLD."revision" IS DISTINCT FROM NEW."revision"))
EXECUTE FUNCTION scalius_compat."evt_inventory_transfers_changed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_inventory_transfers_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory.*', 'inventory.transfer_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'inventory.transfer_updated', 'inventory_transfer', OLD."id", jsonb_build_object('transferId', OLD."id", 'previousStatus', OLD."status", 'status', 'deleted', 'revision', OLD."revision")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_inventory_transfers_deleted"
AFTER DELETE ON "inventory_transfers"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_inventory_transfers_deleted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customers_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.created', 'customer', NEW."id", jsonb_build_object('customerId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customers_created"
AFTER INSERT ON "customers"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_customers_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customers_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', NEW."id", jsonb_build_object('customerId', NEW."id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customers_updated"
AFTER UPDATE ON "customers"
FOR EACH ROW
WHEN ((OLD."name" IS DISTINCT FROM NEW."name" OR OLD."email" IS DISTINCT FROM NEW."email" OR OLD."phone" IS DISTINCT FROM NEW."phone" OR OLD."account_claimed_at" IS DISTINCT FROM NEW."account_claimed_at" OR OLD."phone_verified_at" IS DISTINCT FROM NEW."phone_verified_at" OR OLD."email_verified_at" IS DISTINCT FROM NEW."email_verified_at" OR OLD."origin" IS DISTINCT FROM NEW."origin" OR OLD."merged_into_customer_id" IS DISTINCT FROM NEW."merged_into_customer_id" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"))
EXECUTE FUNCTION scalius_compat."evt_customers_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_addresses_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_addresses_created"
AFTER INSERT ON "customer_addresses"
FOR EACH ROW
WHEN (substr(NEW."id", 7) <> NEW."customer_id")
EXECUTE FUNCTION scalius_compat."evt_customer_addresses_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_addresses_changed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_addresses_changed"
AFTER UPDATE ON "customer_addresses"
FOR EACH ROW
WHEN ((OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."is_default" IS DISTINCT FROM NEW."is_default" OR OLD."is_default_billing" IS DISTINCT FROM NEW."is_default_billing" OR OLD."country_code" IS DISTINCT FROM NEW."country_code" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."company" IS DISTINCT FROM NEW."company" OR OLD."line1" IS DISTINCT FROM NEW."line1" OR OLD."line2" IS DISTINCT FROM NEW."line2" OR OLD."dependent_locality" IS DISTINCT FROM NEW."dependent_locality" OR OLD."locality" IS DISTINCT FROM NEW."locality" OR OLD."admin_area" IS DISTINCT FROM NEW."admin_area" OR OLD."postal_code" IS DISTINCT FROM NEW."postal_code" OR OLD."phone_e164" IS DISTINCT FROM NEW."phone_e164" OR OLD."phone_raw" IS DISTINCT FROM NEW."phone_raw" OR OLD."city" IS DISTINCT FROM NEW."city" OR OLD."zone" IS DISTINCT FROM NEW."zone" OR OLD."area" IS DISTINCT FROM NEW."area" OR OLD."city_name" IS DISTINCT FROM NEW."city_name" OR OLD."zone_name" IS DISTINCT FROM NEW."zone_name" OR OLD."area_name" IS DISTINCT FROM NEW."area_name" OR OLD."validation_skipped" IS DISTINCT FROM NEW."validation_skipped"))
EXECUTE FUNCTION scalius_compat."evt_customer_addresses_changed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_addresses_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT "id" FROM "customers" WHERE "id" = OLD."customer_id") IS NOT NULL), false) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', OLD."customer_id", jsonb_build_object('customerId', OLD."customer_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_addresses_deleted"
AFTER DELETE ON "customer_addresses"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_customer_addresses_deleted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_marketing_consents_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.consent_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.consent_changed', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id", 'channel', NEW."channel", 'previousState', NULL, 'state', NEW."state", 'source', NEW."source")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_marketing_consents_created"
AFTER INSERT ON "customer_marketing_consents"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_customer_marketing_consents_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_marketing_consents_changed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.consent_changed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.consent_changed', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id", 'channel', NEW."channel", 'previousState', OLD."state", 'state', NEW."state", 'source', NEW."source")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_marketing_consents_changed"
AFTER UPDATE ON "customer_marketing_consents"
FOR EACH ROW
WHEN ((OLD."state" IS DISTINCT FROM NEW."state"))
EXECUTE FUNCTION scalius_compat."evt_customer_marketing_consents_changed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_fulfillments_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'fulfillment.created', 'fulfillment', NEW."id", jsonb_build_object('fulfillmentId', NEW."id", 'orderId', NEW."order_id", 'kind', NEW."kind", 'locationId', NEW."location_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_fulfillments_created"
AFTER INSERT ON "order_fulfillments"
FOR EACH ROW
WHEN (NEW."status" = 'active')
EXECUTE FUNCTION scalius_compat."evt_fulfillments_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_fulfillments_voided_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'fulfillment.*', 'fulfillment.voided')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'fulfillment.voided', 'fulfillment', NEW."id", jsonb_build_object('fulfillmentId', NEW."id", 'orderId', NEW."order_id", 'kind', NEW."kind", 'locationId', NEW."location_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_fulfillments_voided"
AFTER UPDATE ON "order_fulfillments"
FOR EACH ROW
WHEN ((OLD."status" = 'active' AND NEW."status" = 'voided'))
EXECUTE FUNCTION scalius_compat."evt_fulfillments_voided_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_shipments_status_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'shipment.*', 'shipment.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'shipment.updated', 'shipment', NEW."id", jsonb_build_object('shipmentId', NEW."id", 'orderId', NEW."order_id", 'providerId', NEW."provider_id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_shipments_status"
AFTER UPDATE ON "delivery_shipments"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_shipments_status_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_payments_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payment.*', 'payment.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'payment.updated', 'payment', NEW."id", jsonb_build_object('paymentId', NEW."id", 'orderId', NEW."order_id", 'provider', NEW."payment_method", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_payments_insert"
AFTER INSERT ON "order_payments"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_payments_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_payments_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payment.*', 'payment.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'payment.updated', 'payment', NEW."id", jsonb_build_object('paymentId', NEW."id", 'orderId', NEW."order_id", 'provider', NEW."payment_method", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_payments_update"
AFTER UPDATE ON "order_payments"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_payments_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_checkouts_abandoned_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'checkout.*', 'checkout.abandoned')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'checkout.abandoned', 'checkout', NEW."id", jsonb_build_object('abandonedCheckoutId', NEW."id", 'checkoutId', NEW."checkout_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_checkouts_abandoned"
AFTER UPDATE ON "abandoned_checkouts"
FOR EACH ROW
WHEN ((OLD."abandoned_at" IS NULL AND NEW."abandoned_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_checkouts_abandoned_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_promotions_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'discount.created', 'discount', NEW."id", jsonb_build_object('promotionId', NEW."id", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_promotions_created"
AFTER INSERT ON "promotions"
FOR EACH ROW
WHEN (NEW."deleted_at" IS NULL)
EXECUTE FUNCTION scalius_compat."evt_promotions_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_promotions_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'discount.updated', 'discount', NEW."id", jsonb_build_object('promotionId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_promotions_updated"
AFTER UPDATE ON "promotions"
FOR EACH ROW
WHEN ((NEW."deleted_at" IS NULL AND (OLD."revision" IS DISTINCT FROM NEW."revision" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at")))
EXECUTE FUNCTION scalius_compat."evt_promotions_updated_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_promotions_trashed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.deleted')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'discount.deleted', 'discount', OLD."id", jsonb_build_object('promotionId', OLD."id", 'previousStatus', OLD."status", 'status', 'deleted')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_promotions_trashed"
AFTER UPDATE ON "promotions"
FOR EACH ROW
WHEN ((OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_promotions_trashed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_promotions_deleted_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.deleted')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'discount.deleted', 'discount', OLD."id", jsonb_build_object('promotionId', OLD."id", 'previousStatus', OLD."status", 'status', 'deleted')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_promotions_deleted"
AFTER DELETE ON "promotions"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_promotions_deleted_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_promotions_redeemed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'discount.*', 'discount.redeemed')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'discount.redeemed', 'discount', NEW."promotion_id", jsonb_build_object('promotionId', NEW."promotion_id", 'orderId', NEW."order_id", 'codeId', (SELECT "id" FROM "promotion_codes" WHERE "normalized_code" = NEW."promotion_code"))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_promotions_redeemed"
AFTER INSERT ON "promotion_redemptions"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_promotions_redeemed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_reviews_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'review.*', 'review.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'review.created', 'review', NEW."id", jsonb_build_object('reviewId', NEW."id", 'productId', NEW."product_id", 'previousStatus', NULL, 'status', NEW."status", 'rating', NEW."rating")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_reviews_insert"
AFTER INSERT ON "product_reviews"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_reviews_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_reviews_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'review.*', 'review.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'review.updated', 'review', NEW."id", jsonb_build_object('reviewId', NEW."id", 'productId', NEW."product_id", 'previousStatus', OLD."status", 'status', NEW."status", 'rating', NEW."rating")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_reviews_update"
AFTER UPDATE ON "product_reviews"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_reviews_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_gift_cards_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card.*', 'gift_card.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'gift_card.created', 'gift_card', NEW."id", jsonb_build_object('giftCardId', NEW."id", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_gift_cards_insert"
AFTER INSERT ON "gift_cards"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_gift_cards_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_gift_cards_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card.*', 'gift_card.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'gift_card.updated', 'gift_card', NEW."id", jsonb_build_object('giftCardId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_gift_cards_update"
AFTER UPDATE ON "gift_cards"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_gift_cards_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_gift_card_transactions_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card.*', 'gift_card.transaction')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'gift_card.transaction', 'transaction', NEW."id", jsonb_build_object('giftCardId', NEW."gift_card_id", 'transactionId', NEW."id", 'kind', NEW."kind", 'orderId', NEW."order_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_gift_card_transactions_created"
AFTER INSERT ON "gift_card_transactions"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_gift_card_transactions_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_objects_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'object.*', 'object.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'object.created', 'object', NEW."id", jsonb_build_object('objectType', NEW."type_id", 'objectId', NEW."id", 'revision', NEW."revision", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_objects_insert"
AFTER INSERT ON "object_records"
FOR EACH ROW
WHEN (NEW."ev" = 1)
EXECUTE FUNCTION scalius_compat."evt_objects_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_objects_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'object.*', 'object.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'object.updated', 'object', NEW."id", jsonb_build_object('objectType', NEW."type_id", 'objectId', NEW."id", 'revision', NEW."revision", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_objects_update"
AFTER UPDATE ON "object_records"
FOR EACH ROW
WHEN ((NEW."ev" = 1 AND (OLD."revision" IS DISTINCT FROM NEW."revision")))
EXECUTE FUNCTION scalius_compat."evt_objects_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_objects_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'object.*', 'object.deleted')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'object.deleted', 'object', OLD."id", jsonb_build_object('objectType', OLD."type_id", 'objectId', OLD."id", 'revision', OLD."revision", 'status', 'deleted')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_objects_delete"
AFTER DELETE ON "object_records"
FOR EACH ROW
WHEN (OLD."ev" = 1)
EXECUTE FUNCTION scalius_compat."evt_objects_delete_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (155, '0155_v2_beta_contract', '5c507b12e9e4f51c1124cf2d804b34e179e6c5eb755eef62ef7bb7a7342e5112');
