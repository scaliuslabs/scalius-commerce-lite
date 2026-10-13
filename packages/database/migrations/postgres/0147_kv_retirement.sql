CREATE TABLE "system_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "system_kv_key_length" CHECK(length("system_kv"."key") BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE INDEX "system_kv_expires_idx" ON "system_kv" ("expires_at") WHERE "system_kv"."expires_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "scanner_token_claims" ADD "session_expires_at" bigint;
--> statement-breakpoint
UPDATE "scanner_token_claims" SET "session_expires_at" = "consumed_at" + 21600 WHERE "consumed_at" IS NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (147, '0147_kv_retirement', '786ba414dbaf965411cc75b99f79007253d2bdcf1e7bc1423e7d04dc23158dd7');
