-- Chat channels in the inbox, and payouts: see ../0199_channel_inbox_payouts.sql.
CREATE TABLE "conversation_channel_contacts" (
	"conversation_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"channel" text COLLATE "C" NOT NULL,
	"contact_key" text COLLATE "C" NOT NULL,
	"contact_name" text COLLATE "C",
	"provider_id" text COLLATE "C" NOT NULL,
	"last_inbound_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "conversation_channel_contacts_channel_check" CHECK("conversation_channel_contacts"."channel" IN ('whatsapp', 'messenger', 'instagram', 'telegram', 'viber')),
	CONSTRAINT "conversation_channel_contacts_key_length" CHECK(length("conversation_channel_contacts"."contact_key") BETWEEN 1 AND 128),
	CONSTRAINT "conversation_channel_contacts_name_length" CHECK("conversation_channel_contacts"."contact_name" IS NULL OR length("conversation_channel_contacts"."contact_name") BETWEEN 1 AND 200),
	CONSTRAINT "conversation_channel_contacts_provider_shape" CHECK(instr("conversation_channel_contacts"."provider_id", ':') > 1 AND length("conversation_channel_contacts"."provider_id") <= 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_channel_contacts_contact_unique" ON "conversation_channel_contacts" ("channel","contact_key");
--> statement-breakpoint
CREATE TABLE "conversation_channel_messages" (
	"message_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"conversation_id" text COLLATE "C" NOT NULL,
	"direction" text COLLATE "C" NOT NULL,
	"provider_id" text COLLATE "C" NOT NULL,
	"provider_message_id" text COLLATE "C",
	"status" text COLLATE "C" NOT NULL,
	"attachments" text COLLATE "C",
	"failure" text COLLATE "C",
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("message_id") REFERENCES "conversation_messages"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "conversation_channel_messages_direction_check" CHECK("conversation_channel_messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "conversation_channel_messages_status_shape" CHECK(("conversation_channel_messages"."direction" = 'inbound' AND "conversation_channel_messages"."status" = 'received' AND "conversation_channel_messages"."provider_message_id" IS NOT NULL) OR ("conversation_channel_messages"."direction" = 'outbound' AND "conversation_channel_messages"."status" IN ('pending', 'sent', 'delivered', 'read', 'failed'))),
	CONSTRAINT "conversation_channel_messages_provider_message_length" CHECK("conversation_channel_messages"."provider_message_id" IS NULL OR length("conversation_channel_messages"."provider_message_id") BETWEEN 1 AND 256),
	CONSTRAINT "conversation_channel_messages_attachments_check" CHECK("conversation_channel_messages"."attachments" IS NULL OR (json_valid("conversation_channel_messages"."attachments") AND length("conversation_channel_messages"."attachments") <= 8000)),
	CONSTRAINT "conversation_channel_messages_failure_length" CHECK("conversation_channel_messages"."failure" IS NULL OR length("conversation_channel_messages"."failure") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_channel_messages_provider_unique" ON "conversation_channel_messages" ("provider_id","provider_message_id") WHERE "conversation_channel_messages"."provider_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "conversation_channel_messages_conversation_idx" ON "conversation_channel_messages" ("conversation_id");
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"app_id" text COLLATE "C" NOT NULL,
	"provider_id" text COLLATE "C" NOT NULL,
	"payee_ref" text COLLATE "C" NOT NULL,
	"payee_account_ref" text COLLATE "C",
	"amount_minor" bigint NOT NULL,
	"currency" text COLLATE "C" NOT NULL,
	"description" text COLLATE "C",
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
	CONSTRAINT "payouts_id_shape" CHECK(substr("payouts"."id", 1, 4) = 'pyt_' AND length("payouts"."id") BETWEEN 12 AND 68),
	CONSTRAINT "payouts_app_id_length" CHECK(length("payouts"."app_id") BETWEEN 3 AND 100),
	CONSTRAINT "payouts_provider_shape" CHECK(instr("payouts"."provider_id", ':') > 1 AND length("payouts"."provider_id") <= 160),
	CONSTRAINT "payouts_payee_ref_length" CHECK(length("payouts"."payee_ref") BETWEEN 1 AND 128),
	CONSTRAINT "payouts_payee_account_ref_length" CHECK("payouts"."payee_account_ref" IS NULL OR length("payouts"."payee_account_ref") BETWEEN 1 AND 256),
	CONSTRAINT "payouts_amount_positive" CHECK("payouts"."amount_minor" > 0),
	CONSTRAINT "payouts_currency_shape" CHECK(length("payouts"."currency") = 3 AND upper("payouts"."currency") = "payouts"."currency"),
	CONSTRAINT "payouts_description_length" CHECK("payouts"."description" IS NULL OR length("payouts"."description") BETWEEN 1 AND 200),
	CONSTRAINT "payouts_status_check" CHECK("payouts"."status" IN ('pending', 'processing', 'paid', 'failed')),
	CONSTRAINT "payouts_provider_ref_length" CHECK("payouts"."provider_ref" IS NULL OR length("payouts"."provider_ref") BETWEEN 1 AND 256),
	CONSTRAINT "payouts_failure_shape" CHECK(("payouts"."status" = 'failed') = ("payouts"."failure_code" IS NOT NULL) AND ("payouts"."failure_code" IS NULL OR length("payouts"."failure_code") BETWEEN 1 AND 64) AND ("payouts"."failure_message" IS NULL OR length("payouts"."failure_message") BETWEEN 1 AND 300)),
	CONSTRAINT "payouts_settled_shape" CHECK(("payouts"."status" IN ('paid', 'failed')) = ("payouts"."settled_at" IS NOT NULL)),
	CONSTRAINT "payouts_key_length" CHECK(length("payouts"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "payouts_request_hash_shape" CHECK(length("payouts"."request_hash") = 64),
	CONSTRAINT "payouts_version_positive" CHECK("payouts"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_app_key_unique" ON "payouts" ("app_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_ref_unique" ON "payouts" ("provider_id","provider_ref") WHERE "payouts"."provider_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payouts_app_updated_idx" ON "payouts" ("app_id","updated_at","id");
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "author_app_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel" text COLLATE "C";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payouts_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."app_id" IS DISTINCT FROM OLD."app_id" OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id"
    OR NEW."payee_ref" IS DISTINCT FROM OLD."payee_ref" OR NEW."payee_account_ref" IS DISTINCT FROM OLD."payee_account_ref"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."description" IS DISTINCT FROM OLD."description" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."provider_ref" IS NOT NULL AND NEW."provider_ref" IS DISTINCT FROM OLD."provider_ref") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payouts_identity_immutable"
BEFORE UPDATE ON "payouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payouts_identity_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payouts_status_forward_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status" IN ('paid', 'failed') OR NEW."status" = 'pending') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_STATUS_FINAL';
  END IF;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payouts_status_forward"
BEFORE UPDATE OF "status" ON "payouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payouts_status_forward_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."payouts_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAYOUT_DELETE_BLOCKED';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "payouts_delete_blocked"
BEFORE DELETE ON "payouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."payouts_delete_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_conversation_messages_received_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'conversation.*', 'conversation.message_received')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'conversation.message_received', 'conversation', NEW."conversation_id", jsonb_build_object('conversationId', NEW."conversation_id", 'messageId', NEW."id", 'seq', NEW."seq", 'channel', (SELECT "channel" FROM "conversations" WHERE "id" = NEW."conversation_id"))::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_conversation_messages_received"
AFTER INSERT ON "conversation_messages"
FOR EACH ROW
WHEN ((NEW."kind" = 'message' AND NEW."author_type" IN ('customer', 'guest_receipt')))
EXECUTE FUNCTION scalius_compat."evt_conversation_messages_received_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_payouts_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.created')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'payout.created', 'payout', NEW."id", jsonb_build_object('payoutId', NEW."id", 'appId', NEW."app_id", 'previousStatus', NULL, 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_payouts_insert"
AFTER INSERT ON "payouts"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_payouts_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_payouts_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'payout.*', 'payout.updated')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'payout.updated', 'payout', NEW."id", jsonb_build_object('payoutId', NEW."id", 'appId', NEW."app_id", 'previousStatus', OLD."status", 'status', NEW."status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_payouts_update"
AFTER UPDATE ON "payouts"
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."evt_payouts_update_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (199, '0199_channel_inbox_payouts', 'ec56959f4179fb753557083b23eecb873fe23cd0329cdc67a8bacd6846b4b61c');
