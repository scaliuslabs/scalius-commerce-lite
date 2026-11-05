-- Staff password and code attempts move out of Better Auth's rate_limit table (see ../0194_staff_auth_attempts.sql).
CREATE TABLE "staff_auth_attempts" (
	"key" text COLLATE "C" PRIMARY KEY NOT NULL,
	"attempts" bigint NOT NULL,
	"window_started_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "staff_auth_attempts_window_idx" ON "staff_auth_attempts" ("window_started_at");
--> statement-breakpoint
DELETE FROM "rate_limit" WHERE "key" >= 'scalius:' AND "key" < 'scalius;';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (194, '0194_staff_auth_attempts', 'e70823b18e8320a9b048ca6c32c1314ef2cf4f5ff4b74b09528d06ac2898615b');
