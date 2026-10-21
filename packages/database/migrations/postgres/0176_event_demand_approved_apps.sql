-- Event demand for approved apps: see ../0176_event_demand_approved_apps.sql.
DROP TRIGGER IF EXISTS "demand_webhook_insert_0" ON webhook_subscriptions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_webhook_insert_1" ON webhook_subscriptions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_webhook_update_0" ON webhook_subscriptions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_webhook_update_1" ON webhook_subscriptions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_webhook_delete_0" ON webhook_subscriptions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_webhook_delete_1" ON webhook_subscriptions;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_plugin_insert_0" ON plugin_registrations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_plugin_insert_1" ON plugin_registrations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_plugin_update_0" ON plugin_registrations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_plugin_update_1" ON plugin_registrations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_plugin_delete_0" ON plugin_registrations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_plugin_delete_1" ON plugin_registrations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_installation_status_0" ON plugin_installations;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demand_installation_status_1" ON plugin_installations;
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."demand_installation_status_0_fn"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS scalius_compat."demand_installation_status_1_fn"();
--> statement-breakpoint
INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
--> statement-breakpoint
DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_plugin_delete_1" AFTER DELETE ON plugin_registrations
FOR EACH ROW WHEN (OLD.kind = 'event') EXECUTE FUNCTION scalius_compat."demand_plugin_delete_1_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_installation_grant_0_fn"()
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_installation_grant_0" AFTER UPDATE OF grant_json ON plugin_installations
FOR EACH ROW WHEN ((OLD.grant_json IS NULL) IS DISTINCT FROM (NEW.grant_json IS NULL)) EXECUTE FUNCTION scalius_compat."demand_installation_grant_0_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."demand_installation_grant_1_fn"()
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
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "demand_installation_grant_1" AFTER UPDATE OF grant_json ON plugin_installations
FOR EACH ROW WHEN ((OLD.grant_json IS NULL) IS DISTINCT FROM (NEW.grant_json IS NULL)) EXECUTE FUNCTION scalius_compat."demand_installation_grant_1_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (176, '0176_event_demand_approved_apps', '19196f366606514a3213889964e963f677d6f823bbcc3c71cafd798adab9ac17');
