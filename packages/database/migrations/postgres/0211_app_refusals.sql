-- An app refusing every checkout: see ../0211_app_refusals.sql.
ALTER TABLE "plugin_registrations" ADD COLUMN "refusal_count" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "refusing_since" bigint;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "last_refusal_at" bigint;
--> statement-breakpoint
ALTER TABLE "plugin_registrations" ADD COLUMN "last_refusal" text COLLATE "C";
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (211, '0211_app_refusals', 'd64cac5c8d9a0ed670704caed7313d8cd1cb87b40340aef1211a5dbc3cc5b9d9');
