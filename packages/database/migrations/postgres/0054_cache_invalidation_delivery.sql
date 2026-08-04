CREATE TABLE "cache_invalidation_state" (
	"group_name" text PRIMARY KEY NOT NULL,
	"requested_generation" integer DEFAULT 1 NOT NULL,
	"applied_generation" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"applied_at" bigint,
	CONSTRAINT "cache_invalidation_state_requested_positive" CHECK("cache_invalidation_state"."requested_generation" >= 1),
	CONSTRAINT "cache_invalidation_state_applied_nonnegative" CHECK("cache_invalidation_state"."applied_generation" >= 0),
	CONSTRAINT "cache_invalidation_state_generation_order" CHECK("cache_invalidation_state"."applied_generation" <= "cache_invalidation_state"."requested_generation"),
	CONSTRAINT "cache_invalidation_state_attempts_nonnegative" CHECK("cache_invalidation_state"."attempt_count" >= 0)
);--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (54, '0054_cache_invalidation_delivery', '79be02aabbc23a8df2d1d249411c3940ae3389d12981b2a0ff81dad7b15476fa');
