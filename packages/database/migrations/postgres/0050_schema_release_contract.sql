CREATE TABLE "scalius_schema_migrations" (
	"version" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_sha256" text NOT NULL,
	"applied_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "scalius_schema_migrations_version_positive" CHECK("scalius_schema_migrations"."version" >= 1),
	CONSTRAINT "scalius_schema_migrations_source_sha256" CHECK(length("scalius_schema_migrations"."source_sha256") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scalius_schema_migrations_name_unique" ON "scalius_schema_migrations" ("name");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (50, '0050_schema_release_contract', '4b7e98071b3874f0a1e512b3bac3a188fdfb087f9cb118df9cd0fd8a77205194');
