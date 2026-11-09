-- An app refusing every checkout (plugin_registrations, `cart.validate`
-- rows): buyers' checkouts its rule refused since the last one it accepted
-- (counted at most once every five minutes), when that began and was last
-- counted, and the app's words for the latest. Home and the app's page warn
-- from these; an accepted checkout clears them. Expand-only: columns added
-- in place.
ALTER TABLE `plugin_registrations` ADD `refusal_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `refusing_since` integer;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `last_refusal_at` integer;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `last_refusal` text;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (212, '0212_app_refusals', 'd64cac5c8d9a0ed670704caed7313d8cd1cb87b40340aef1211a5dbc3cc5b9d9');
