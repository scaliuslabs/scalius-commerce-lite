CREATE TABLE "cache_generation" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"generation" text NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	CONSTRAINT "cache_generation_singleton" CHECK("cache_generation"."id" = 'default')
);
--> statement-breakpoint
DROP TABLE IF EXISTS "cache_invalidation_state";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (64, '0064_cache_generation', 'ee5ed733611d28c5b676b0e5e48d9eb3e0b9d1ed813b329814aaa0906bcca823');
