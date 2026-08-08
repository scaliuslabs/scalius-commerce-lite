ALTER TABLE "cache_invalidation_state"
  ALTER COLUMN "requested_generation" TYPE bigint,
  ALTER COLUMN "applied_generation" TYPE bigint,
  ALTER COLUMN "attempt_count" TYPE bigint;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (55, '0055_cache_invalidation_postgres_bigint', '1fef4f2d630a3dbd5de4255b37b9d4896e325f99f6975d3c486fd1252e47cda4');
