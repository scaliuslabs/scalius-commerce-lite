-- An app's line on the order timeline names the app: see ../0198_order_event_app_actor.sql.
ALTER TABLE "order_events" ADD COLUMN "actor_app_id" text COLLATE "C";
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (198, '0198_order_event_app_actor', '7e197c9e8e4fa96b60436dbe9c4ba6afe995744965e28b0a46d8000a774e4b70');
