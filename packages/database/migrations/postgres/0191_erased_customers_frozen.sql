-- An erased customer never regains personal data, from any writer (see the
-- SQLite migration). The repair scrubs any erased record that regained data;
-- the triggers then refuse it. A trigger WHEN clause here takes no subquery,
-- so the owner checks run inside each function.
UPDATE "customers" SET "name" = '[erased]', "email" = NULL, "phone" = '', "phone_verified_at" = NULL, "email_verified_at" = NULL, "last_authenticated_at" = NULL, "tax_exempt" = 0, "tax_exemption_id" = NULL, "deleted_at" = coalesce("deleted_at", unixepoch()), "updated_at" = unixepoch()
WHERE "erased_at" IS NOT NULL
  AND ("name" IS DISTINCT FROM '[erased]' OR "email" IS NOT NULL OR "phone" IS DISTINCT FROM '' OR "phone_verified_at" IS NOT NULL OR "email_verified_at" IS NOT NULL OR "last_authenticated_at" IS NOT NULL OR "tax_exemption_id" IS NOT NULL OR "deleted_at" IS NULL);
--> statement-breakpoint
UPDATE "customer_history" SET "name" = '[erased]', "email" = NULL, "phone" = ''
WHERE "customer_id" IN (SELECT "id" FROM "customers" WHERE "erased_at" IS NOT NULL)
  AND ("name" IS DISTINCT FROM '[erased]' OR "email" IS NOT NULL OR "phone" IS DISTINCT FROM '');
--> statement-breakpoint
DELETE FROM "customer_addresses" WHERE "customer_id" IN (SELECT "id" FROM "customers" WHERE "erased_at" IS NOT NULL);
--> statement-breakpoint
DELETE FROM "customer_identities" WHERE "customer_id" IN (SELECT "id" FROM "customers" WHERE "erased_at" IS NOT NULL);
--> statement-breakpoint
DELETE FROM "customer_marketing_consents" WHERE "customer_id" IN (SELECT "id" FROM "customers" WHERE "erased_at" IS NOT NULL);
--> statement-breakpoint
DELETE FROM "customer_marketing_consent_events" WHERE "customer_id" IN (SELECT "id" FROM "customers" WHERE "erased_at" IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customers_erased_frozen_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CUSTOMER_ERASED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customers_erased_frozen"
BEFORE UPDATE ON "customers"
FOR EACH ROW
WHEN (OLD."erased_at" IS NOT NULL
  AND (NEW."erased_at" IS NULL OR NEW."deleted_at" IS NULL OR NEW."name" IS DISTINCT FROM '[erased]' OR NEW."email" IS NOT NULL OR NEW."phone" IS DISTINCT FROM ''
    OR NEW."phone_verified_at" IS NOT NULL OR NEW."email_verified_at" IS NOT NULL OR NEW."last_authenticated_at" IS NOT NULL OR NEW."tax_exemption_id" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."customers_erased_frozen_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_erased_owner_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF EXISTS (SELECT 1 FROM "customers" WHERE "id" = NEW."customer_id" AND "erased_at" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CUSTOMER_ERASED';
  END IF;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_addresses_erased_owner_blocked"
BEFORE INSERT ON "customer_addresses"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_erased_owner_blocked_fn"();
CREATE TRIGGER "customer_identities_erased_owner_blocked"
BEFORE INSERT ON "customer_identities"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_erased_owner_blocked_fn"();
CREATE TRIGGER "customer_marketing_consents_erased_owner_blocked"
BEFORE INSERT ON "customer_marketing_consents"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_erased_owner_blocked_fn"();
CREATE TRIGGER "customer_marketing_consent_events_erased_owner_blocked"
BEFORE INSERT ON "customer_marketing_consent_events"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_erased_owner_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_history_erased_owner_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF EXISTS (SELECT 1 FROM "customers" WHERE "id" = NEW."customer_id" AND "erased_at" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CUSTOMER_ERASED';
  END IF;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_history_erased_owner_blocked"
BEFORE INSERT ON "customer_history"
FOR EACH ROW
WHEN (NEW."name" IS DISTINCT FROM '[erased]' OR NEW."email" IS NOT NULL OR NEW."phone" IS DISTINCT FROM '')
EXECUTE FUNCTION scalius_compat."customer_history_erased_owner_blocked_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (191, '0191_erased_customers_frozen', '956e9c8f86d24b652b8ea4170ee9a6efa450a2cc22d002092c3359fb41a269d5');
