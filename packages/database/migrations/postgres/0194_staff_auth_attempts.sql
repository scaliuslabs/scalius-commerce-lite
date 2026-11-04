-- Staff password and code attempts move out of Better Auth's rate_limit table (see ../0194_staff_auth_attempts.sql).
CREATE TABLE "staff_auth_attempts" (
	"key" text COLLATE "C" PRIMARY KEY NOT NULL,
	"attempts" bigint NOT NULL,
	"window_started_at" bigint NOT NULL
);
--> statement-breakpoint
DELETE FROM "rate_limit" WHERE "key" >= 'scalius:' AND "key" < 'scalius;';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (194, '0194_staff_auth_attempts', '34fae90c1a5c7b813a1f2a090f1603f5e7fbb0322084d923a3da9cc20c4c8d28');
