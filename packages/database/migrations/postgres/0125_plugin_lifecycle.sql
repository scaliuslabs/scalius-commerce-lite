-- The app lifecycle and safety layer (packages/plugin-sdk/docs/apps.md, "Registry",
-- "Quotas", "Data updates"). `plugin_migrations` records each data update an
-- app ran (one row per version, kept with its data on a keep-data uninstall).
-- The new `plugin_installations` columns are added in place, without a table
-- rebuild, so the generated cache dependency triggers stay: the newest data
-- update that ran, the key that verified the bundle, the measured storage and
-- the limit-breach window. None of them is buyer-visible, so none advances a
-- cache dependency (cache-deps.ts lists them as noise).
CREATE TABLE "plugin_migrations" (
	"plugin_id" text NOT NULL,
	"version" bigint NOT NULL,
	"plugin_version" text NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"applied_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("plugin_id", "version"),
	CONSTRAINT "plugin_migrations_plugin_id_shape" CHECK(length("plugin_migrations"."plugin_id") BETWEEN 3 AND 100 AND "plugin_migrations"."plugin_id" !~ '[^a-z0-9.-]' AND position('.' in "plugin_migrations"."plugin_id") > 1 AND position('.' in "plugin_migrations"."plugin_id") < length("plugin_migrations"."plugin_id")),
	CONSTRAINT "plugin_migrations_version_range" CHECK("plugin_migrations"."version" BETWEEN 1 AND 10000),
	CONSTRAINT "plugin_migrations_plugin_version_length" CHECK(length("plugin_migrations"."plugin_version") BETWEEN 5 AND 80),
	CONSTRAINT "plugin_migrations_duration" CHECK("plugin_migrations"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD COLUMN "migrated_version" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD COLUMN "signer_key_id" text;
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD COLUMN "storage_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD COLUMN "storage_measured_at" bigint;
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD COLUMN "breach_count" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD COLUMN "last_breach_at" bigint;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (125, '0125_plugin_lifecycle', 'b7db1cf080686c02603d68663907a68b828185e461033eb2f357a00ad3fdb6d0');
