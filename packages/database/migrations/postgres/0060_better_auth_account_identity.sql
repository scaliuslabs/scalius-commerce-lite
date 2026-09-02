DO $better_auth_account_identity_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "account"
		WHERE "provider_id" <> 'credential'
			OR "account_id" <> "user_id"
			OR BTRIM("account_id") = ''
			OR BTRIM("user_id") = ''
			OR "password" IS NULL
			OR BTRIM("password") = ''
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'BETTER_AUTH_CREDENTIAL_IDENTITY_REQUIRED';
	END IF;
END
$better_auth_account_identity_guard$;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "issuer" text;
--> statement-breakpoint
UPDATE "account" SET "issuer" = 'local:credential';
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_id_uidx" ON "account" ("issuer","account_id");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (60, '0060_better_auth_account_identity', 'ad85b0d511efec1d4b538f231cbb96503faf11f4844d36671c9c8b196aa318c8');
