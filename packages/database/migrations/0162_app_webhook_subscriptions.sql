-- App-owned webhook subscriptions (the stable app API's `write_webhooks`): the
-- app that created a subscription, null for the store's own. An app reaches
-- only its own; they deliver while the app is active and within its grant, and
-- uninstalling it deletes them. Private operational state: no public read
-- touches it.
ALTER TABLE `webhook_subscriptions` ADD `plugin_id` text;
--> statement-breakpoint
CREATE INDEX `webhook_subscriptions_plugin_idx` ON `webhook_subscriptions` (`plugin_id`);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (162, '0162_app_webhook_subscriptions', '20cd4a55be96f3933649d106b6439506723616fa79198ab97b8876268ddba373');
