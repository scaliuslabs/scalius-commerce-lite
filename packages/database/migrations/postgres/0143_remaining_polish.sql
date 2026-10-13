CREATE TABLE "marketing_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"draft_revision" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"content_json" text NOT NULL,
	"audience_json" text NOT NULL,
	"segment_id" text NOT NULL,
	"segment_revision" bigint NOT NULL,
	"segment_name" text NOT NULL,
	"time_zone" text NOT NULL,
	"evaluated_at" bigint,
	"scheduled_at" bigint NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"enroll_cursor" text,
	"dispatch_cursor" text,
	"step" bigint DEFAULT 0 NOT NULL,
	"enrolled_count" bigint DEFAULT 0 NOT NULL,
	"deduplicated_count" bigint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"cancelled_by" text,
	"started_at" bigint,
	"finished_at" bigint,
	"cancelled_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "marketing_runs_channel" CHECK("marketing_runs"."channel" IN ('email', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "marketing_runs_status" CHECK("marketing_runs"."status" IN ('scheduled', 'enrolling', 'sending', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "marketing_runs_content" CHECK(json_valid("marketing_runs"."content_json") AND length("marketing_runs"."content_json") <= 64000),
	CONSTRAINT "marketing_runs_audience" CHECK(json_valid("marketing_runs"."audience_json") AND length("marketing_runs"."audience_json") <= 8000),
	CONSTRAINT "marketing_runs_revision" CHECK("marketing_runs"."revision" > 0 AND "marketing_runs"."draft_revision" > 0 AND "marketing_runs"."segment_revision" > 0),
	CONSTRAINT "marketing_runs_counts" CHECK("marketing_runs"."step" >= 0 AND "marketing_runs"."enrolled_count" >= 0 AND "marketing_runs"."deduplicated_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "marketing_contact_slots" (
	"channel" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"day" text NOT NULL,
	"run_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("channel", "recipient_hash", "day"),
	CONSTRAINT "marketing_contact_slots_channel" CHECK("marketing_contact_slots"."channel" IN ('email', 'sms', 'whatsapp', 'push')),
	CONSTRAINT "marketing_contact_slots_hash" CHECK(length("marketing_contact_slots"."recipient_hash") = 64),
	CONSTRAINT "marketing_contact_slots_day" CHECK(length("marketing_contact_slots"."day") = 10)
);
--> statement-breakpoint
CREATE INDEX "marketing_contact_slots_retention_idx" ON "marketing_contact_slots" ("day");
--> statement-breakpoint
CREATE TABLE "marketing_run_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"outbox_id" text,
	"status" text DEFAULT 'enrolled' NOT NULL,
	"reason" text,
	"dispatch_started_at" bigint,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("run_id") REFERENCES "marketing_runs"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "marketing_run_recipients_status" CHECK("marketing_run_recipients"."status" IN ('enrolled', 'queued', 'sending', 'accepted', 'delivered', 'failed', 'unconfirmed', 'skipped', 'cancelled')),
	CONSTRAINT "marketing_run_recipients_hash" CHECK(length("marketing_run_recipients"."recipient_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_run_recipients_target_unique" ON "marketing_run_recipients" ("run_id","recipient_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_run_recipients_outbox_unique" ON "marketing_run_recipients" ("outbox_id") WHERE "marketing_run_recipients"."outbox_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "marketing_run_recipients_progress_idx" ON "marketing_run_recipients" ("run_id","status","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_runs_request_unique" ON "marketing_runs" ("plugin_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "marketing_runs_due_idx" ON "marketing_runs" ("status","scheduled_at","id");
--> statement-breakpoint
CREATE INDEX "marketing_runs_app_list_idx" ON "marketing_runs" ("plugin_id","created_at","id");
--> statement-breakpoint
CREATE TABLE "conversation_cart_shares" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"lines_json" text NOT NULL,
	"shared_at" bigint NOT NULL,
	"withdrawn_at" bigint,
	"version" bigint DEFAULT 1 NOT NULL,
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "conversation_cart_shares_lines" CHECK(json_valid("conversation_cart_shares"."lines_json") AND length("conversation_cart_shares"."lines_json") <= 120000),
	CONSTRAINT "conversation_cart_shares_version" CHECK("conversation_cart_shares"."version" > 0),
	CONSTRAINT "conversation_cart_shares_withdrawn_empty" CHECK("conversation_cart_shares"."withdrawn_at" IS NULL OR "conversation_cart_shares"."lines_json" = '[]')
);
--> statement-breakpoint
CREATE TABLE "conversation_saved_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"mode" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"archived_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	FOREIGN KEY ("created_by") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "conversation_saved_replies_title_length" CHECK(length(trim("conversation_saved_replies"."title")) BETWEEN 1 AND 80),
	CONSTRAINT "conversation_saved_replies_body_length" CHECK(length(trim("conversation_saved_replies"."body")) BETWEEN 1 AND 5000),
	CONSTRAINT "conversation_saved_replies_mode" CHECK("conversation_saved_replies"."mode" IN ('reply', 'note')),
	CONSTRAINT "conversation_saved_replies_version" CHECK("conversation_saved_replies"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX "conversation_saved_replies_all_idx" ON "conversation_saved_replies" ("archived_at","updated_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "conversation_saved_replies_list_idx" ON "conversation_saved_replies" ("archived_at","mode","updated_at" DESC,"id");
--> statement-breakpoint
CREATE TABLE "conversation_search_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_message_id" text,
	"complete" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "conversation_search_state_id" CHECK("conversation_search_state"."id" = 'v1')
);
--> statement-breakpoint
CREATE TABLE "conversation_search_terms" (
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"term" text COLLATE "C" NOT NULL,
	PRIMARY KEY("conversation_id", "term", "message_id"),
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("message_id") REFERENCES "conversation_messages"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "conversation_search_terms_length" CHECK(length("conversation_search_terms"."term") BETWEEN 2 AND 32)
);
--> statement-breakpoint
CREATE INDEX "conversation_search_terms_message_idx" ON "conversation_search_terms" ("conversation_id","seq","term");
--> statement-breakpoint
ALTER TABLE "customer_marketing_consents" DROP CONSTRAINT "customer_marketing_consents_channel_check";
--> statement-breakpoint
ALTER TABLE "customer_marketing_consents" ADD CONSTRAINT "customer_marketing_consents_channel_check" CHECK ("channel" IN ('email', 'sms', 'whatsapp', 'push'));
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_subject_type_check";
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_subject_type_check" CHECK ("subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer', 'marketing_run'));
--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" DROP CONSTRAINT "notification_delivery_receipts_subject_type_check";
--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" ADD CONSTRAINT "notification_delivery_receipts_subject_type_check" CHECK ("subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer', 'marketing_run'));
--> statement-breakpoint
CREATE INDEX "conversation_messages_public_seq_idx" ON "conversation_messages" ("conversation_id","seq") WHERE "conversation_messages"."visibility" = 'public';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."conversation_product_reply_shape_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW.event_kind = 'product_reply' AND (
  NEW.visibility <> 'public' OR NEW.author_type <> 'staff' OR NEW.event_data IS NULL
  OR (NEW.body IS NOT NULL AND length(trim(NEW.body)) = 0)
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid public product reply';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "conversation_product_reply_shape"
BEFORE INSERT ON "conversation_messages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."conversation_product_reply_shape_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (143, '0143_remaining_polish', 'd479468027dc2a6b0506b24e8bed8a57a1a9bc82067e2497abea5691fdeacb00');
