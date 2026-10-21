-- Event demand counts every app with an approved grant, whatever its status: a stopped,
-- failed or update-waiting app keeps its events as held deliveries (audit I3; event-demand-triggers.ts).
DROP TRIGGER IF EXISTS demand_webhook_insert_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_webhook_insert_1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_webhook_update_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_webhook_update_1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_webhook_delete_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_webhook_delete_1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_plugin_insert_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_plugin_insert_1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_plugin_update_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_plugin_update_1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_plugin_delete_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_plugin_delete_1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_installation_status_0;
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_installation_status_1;
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
CREATE TRIGGER demand_webhook_insert_0 AFTER INSERT ON webhook_subscriptions
WHEN NEW.status = 'active'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_insert_1 AFTER INSERT ON webhook_subscriptions
WHEN NEW.status = 'active'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_update_0 AFTER UPDATE OF status, topics ON webhook_subscriptions
WHEN OLD.status IS NOT NEW.status OR OLD.topics IS NOT NEW.topics
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_update_1 AFTER UPDATE OF status, topics ON webhook_subscriptions
WHEN OLD.status IS NOT NEW.status OR OLD.topics IS NOT NEW.topics
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_delete_0 AFTER DELETE ON webhook_subscriptions
WHEN OLD.status = 'active'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_webhook_delete_1 AFTER DELETE ON webhook_subscriptions
WHEN OLD.status = 'active'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_insert_0 AFTER INSERT ON plugin_registrations
WHEN NEW.kind = 'event'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_insert_1 AFTER INSERT ON plugin_registrations
WHEN NEW.kind = 'event'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_update_0 AFTER UPDATE OF kind, name, plugin_id ON plugin_registrations
WHEN OLD.kind = 'event' OR NEW.kind = 'event'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_update_1 AFTER UPDATE OF kind, name, plugin_id ON plugin_registrations
WHEN OLD.kind = 'event' OR NEW.kind = 'event'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_delete_0 AFTER DELETE ON plugin_registrations
WHEN OLD.kind = 'event'
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_plugin_delete_1 AFTER DELETE ON plugin_registrations
WHEN OLD.kind = 'event'
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER demand_installation_grant_0 AFTER UPDATE OF grant_json ON plugin_installations
WHEN (OLD.grant_json IS NULL) IS NOT (NEW.grant_json IS NULL)
BEGIN
  INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER demand_installation_grant_1 AFTER UPDATE OF grant_json ON plugin_installations
WHEN (OLD.grant_json IS NULL) IS NOT (NEW.grant_json IS NULL)
BEGIN
  DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL);
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (176, '0176_event_demand_approved_apps', '19196f366606514a3213889964e963f677d6f823bbcc3c71cafd798adab9ac17');
