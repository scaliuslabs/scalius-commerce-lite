-- Payout reversals and apps' own chat channels: see ../0206_payout_reversals_custom_channels.sql.
CREATE TABLE "payout_reversals" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"payout_id" text COLLATE "C" NOT NULL,
	"app_id" text COLLATE "C" NOT NULL,
	"provider_id" text COLLATE "C" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text COLLATE "C" NOT NULL,
	"reason" text COLLATE "C",
	"status" text COLLATE "C" DEFAULT 'pending' NOT NULL,
	"provider_ref" text COLLATE "C",
	"failure_code" text COLLATE "C",
	"failure_message" text COLLATE "C",
	"idempotency_key" text COLLATE "C" NOT NULL,
	"request_hash" text COLLATE "C" NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"settled_at" bigint,
	FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "payout_reversals_id_shape" CHECK(substr("payout_reversals"."id", 1, 4) = 'pyr_' AND length("payout_reversals"."id") BETWEEN 12 AND 68),
	CONSTRAINT "payout_reversals_amount_positive" CHECK("payout_reversals"."amount_minor" > 0),
	CONSTRAINT "payout_reversals_currency_shape" CHECK(length("payout_reversals"."currency") = 3 AND upper("payout_reversals"."currency") = "payout_reversals"."currency"),
	CONSTRAINT "payout_reversals_reason_length" CHECK("payout_reversals"."reason" IS NULL OR length("payout_reversals"."reason") BETWEEN 1 AND 200),
	CONSTRAINT "payout_reversals_status_check" CHECK("payout_reversals"."status" IN ('pending', 'processing', 'reversed', 'failed')),
	CONSTRAINT "payout_reversals_provider_ref_length" CHECK("payout_reversals"."provider_ref" IS NULL OR length("payout_reversals"."provider_ref") BETWEEN 1 AND 256),
	CONSTRAINT "payout_reversals_failure_shape" CHECK(("payout_reversals"."status" = 'failed') = ("payout_reversals"."failure_code" IS NOT NULL) AND ("payout_reversals"."failure_code" IS NULL OR length("payout_reversals"."failure_code") BETWEEN 1 AND 64) AND ("payout_reversals"."failure_message" IS NULL OR length("payout_reversals"."failure_message") BETWEEN 1 AND 300)),
	CONSTRAINT "payout_reversals_settled_shape" CHECK(("payout_reversals"."status" IN ('reversed', 'failed')) = ("payout_reversals"."settled_at" IS NOT NULL)),
	CONSTRAINT "payout_reversals_key_length" CHECK(length("payout_reversals"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "payout_reversals_request_hash_shape" CHECK(length("payout_reversals"."request_hash") = 64),
	CONSTRAINT "payout_reversals_version_positive" CHECK("payout_reversals"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payout_reversals_app_key_unique" ON "payout_reversals" ("app_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payout_reversals_provider_ref_unique" ON "payout_reversals" ("provider_id","provider_ref") WHERE "payout_reversals"."provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payout_reversals_payout_idx" ON "payout_reversals" ("payout_id","created_at","id");
--> statement-breakpoint
ALTER TABLE "conversation_channel_contacts" DROP CONSTRAINT "conversation_channel_contacts_channel_check";
--> statement-breakpoint
ALTER TABLE "conversation_channel_contacts" ADD CONSTRAINT "conversation_channel_contacts_channel_check" CHECK("conversation_channel_contacts"."channel" IN ('whatsapp', 'messenger', 'instagram', 'telegram', 'viber') OR (position(':' IN "conversation_channel_contacts"."channel") > 1 AND length("conversation_channel_contacts"."channel") <= 64 AND substr("conversation_channel_contacts"."channel", 1, CAST(position(':' IN "conversation_channel_contacts"."channel") AS smallint)) = substr("conversation_channel_contacts"."provider_id", 1, CAST(position(':' IN "conversation_channel_contacts"."provider_id") AS smallint))));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payout_reversals_payout_paid_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payouts"
    WHERE "id" = NEW."payout_id" AND "app_id" = NEW."app_id" AND "provider_id" = NEW."provider_id"
      AND "currency" = NEW."currency" AND "status" = 'paid'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_REVERSAL_NOT_PAID';
  END IF;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_payout_paid"
BEFORE INSERT ON "payout_reversals"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payout_reversals_payout_paid_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payout_reversals_within_payout_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF (SELECT count(*) FROM "payout_reversals" WHERE "payout_id" = NEW."payout_id") >= 20
    OR NEW."amount_minor" + (
      SELECT coalesce(sum("amount_minor"), 0) FROM "payout_reversals"
      WHERE "payout_id" = NEW."payout_id" AND "status" <> 'failed'
    ) > (SELECT "amount_minor" FROM "payouts" WHERE "id" = NEW."payout_id") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_REVERSAL_EXCEEDS_PAYOUT';
  END IF;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_within_payout"
BEFORE INSERT ON "payout_reversals"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payout_reversals_within_payout_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payout_reversals_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."payout_id" IS DISTINCT FROM OLD."payout_id" OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
    OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id" OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."provider_ref" IS NOT NULL AND NEW."provider_ref" IS DISTINCT FROM OLD."provider_ref") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_REVERSAL_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_identity_immutable"
BEFORE UPDATE ON "payout_reversals"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payout_reversals_identity_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payout_reversals_status_forward_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status" IN ('reversed', 'failed') OR NEW."status" = 'pending') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_REVERSAL_STATUS_FINAL';
  END IF;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_status_forward"
BEFORE UPDATE OF "status" ON "payout_reversals"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payout_reversals_status_forward_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payout_reversals_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_REVERSAL_DELETE_BLOCKED';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_delete_blocked"
BEFORE DELETE ON "payout_reversals"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payout_reversals_delete_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payout_reversals_touch_payout_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "payouts" SET "version" = "version" + 1, "updated_at" = GREATEST("updated_at", cast(strftime('%s','now') as bigint)) WHERE "id" = NEW."payout_id";
  RETURN NULL;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_touch_payout_insert"
AFTER INSERT ON "payout_reversals"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payout_reversals_touch_payout_fn"();
--> statement-breakpoint
CREATE TRIGGER "payout_reversals_touch_payout_status"
AFTER UPDATE OF "status" ON "payout_reversals"
FOR EACH ROW
WHEN (NEW."status" IS DISTINCT FROM OLD."status")
EXECUTE FUNCTION scalius_compat."payout_reversals_touch_payout_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_payout_reversals_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.reversal_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'payout.reversal_updated', 'payout', NEW."payout_id", jsonb_build_object('payoutId', NEW."payout_id", 'appId', NEW."app_id", 'reversalId', NEW."id", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_payout_reversals_insert"
AFTER INSERT ON "payout_reversals"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_payout_reversals_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_payout_reversals_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.reversal_updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'payout.reversal_updated', 'payout', NEW."payout_id", jsonb_build_object('payoutId', NEW."payout_id", 'appId', NEW."app_id", 'reversalId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_payout_reversals_update"
AFTER UPDATE ON "payout_reversals"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_payout_reversals_update_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (206, '0206_payout_reversals_custom_channels', '62d7be2d72b1bdd668459884a87136939f5c59eb2778581ce08757f380bfd233');
