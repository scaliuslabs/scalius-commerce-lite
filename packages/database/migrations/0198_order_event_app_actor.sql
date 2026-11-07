-- An app's line on the order timeline (its comment, its typed entry) names
-- the app: actor_id references a staff account, so the app's id has its
-- own column. Expand-only: the column is added in place, so order_events
-- is not rebuilt; older lines read as before (null).
ALTER TABLE `order_events` ADD `actor_app_id` text;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (198, '0198_order_event_app_actor', '7e197c9e8e4fa96b60436dbe9c4ba6afe995744965e28b0a46d8000a774e4b70');
