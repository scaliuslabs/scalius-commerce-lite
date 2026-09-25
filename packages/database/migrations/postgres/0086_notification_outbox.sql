-- Generic notification outbox (Wave A §10, §5.5). Expand-only: the
-- order-only outbox and its delivery receipts stay until the contract
-- migration. The new pair keys every row by subject (an order, a
-- conversation, and later a gift card or digital delivery) and audience;
-- queue messages carry only the outbox id and recipients are resolved at
-- send time. Rows the previous API writes to the old tables while this
-- release deploys are not moved (demo data, accepted).
CREATE TABLE "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"order_id" text,
	"conversation_id" text,
	"audience" text NOT NULL,
	"notification_type" text NOT NULL,
	"source" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text,
	"claim_expires_at" bigint,
	"last_error" text,
	"queued_at" bigint,
	"sent_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "notification_outbox_subject_type_check" CHECK("notification_outbox"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital')),
	CONSTRAINT "notification_outbox_audience_check" CHECK("notification_outbox"."audience" IN ('customer', 'staff')),
	CONSTRAINT "notification_outbox_subject_shape" CHECK(("notification_outbox"."subject_type" <> 'order' OR "notification_outbox"."order_id" IS NOT DISTINCT FROM "notification_outbox"."subject_id") AND ("notification_outbox"."subject_type" <> 'conversation' OR "notification_outbox"."conversation_id" IS NOT DISTINCT FROM "notification_outbox"."subject_id")),
	CONSTRAINT "notification_outbox_payload_json" CHECK(json_valid("notification_outbox"."payload"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_unique" ON "notification_outbox" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" ("status","next_attempt_at","created_at");
--> statement-breakpoint
CREATE INDEX "notification_outbox_claim_idx" ON "notification_outbox" ("status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "notification_outbox_queued_idx" ON "notification_outbox" ("status","queued_at","created_at");
--> statement-breakpoint
CREATE INDEX "notification_outbox_subject_idx" ON "notification_outbox" ("subject_type","subject_id");
--> statement-breakpoint
CREATE INDEX "notification_outbox_order_id_idx" ON "notification_outbox" ("order_id") WHERE "notification_outbox"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "notification_outbox_conversation_id_idx" ON "notification_outbox" ("conversation_id") WHERE "notification_outbox"."conversation_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "notification_delivery_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_key" text NOT NULL,
	"outbox_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"order_id" text,
	"notification_type" text NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_masked" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"provider_status" text,
	"raw_response" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text,
	"claim_expires_at" bigint,
	"last_error" text,
	"last_attempt_at" bigint,
	"accepted_at" bigint,
	"delivered_at" bigint,
	"failed_at" bigint,
	"skipped_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("outbox_id") REFERENCES "notification_outbox"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "notification_delivery_receipts_subject_type_check" CHECK("notification_delivery_receipts"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital')),
	CONSTRAINT "notification_delivery_receipts_order_shape" CHECK("notification_delivery_receipts"."subject_type" <> 'order' OR "notification_delivery_receipts"."order_id" IS NOT DISTINCT FROM "notification_delivery_receipts"."subject_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_receipts_receipt_key_unique" ON "notification_delivery_receipts" ("receipt_key");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_outbox_id_idx" ON "notification_delivery_receipts" ("outbox_id");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_outbox_status_idx" ON "notification_delivery_receipts" ("outbox_id","status");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_subject_created_idx" ON "notification_delivery_receipts" ("subject_type","subject_id","created_at");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_subject_channel_idx" ON "notification_delivery_receipts" ("subject_type","subject_id","channel","accepted_at");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_order_id_created_at_idx" ON "notification_delivery_receipts" ("order_id","created_at") WHERE "notification_delivery_receipts"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_pending_idx" ON "notification_delivery_receipts" ("status","next_attempt_at","created_at");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_claim_idx" ON "notification_delivery_receipts" ("status","claim_expires_at","created_at");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_provider_message_idx" ON "notification_delivery_receipts" ("provider","provider_message_id");
--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_provider_status_updated_idx" ON "notification_delivery_receipts" ("channel","provider","status","updated_at");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (86, '0086_notification_outbox', 'fb4be5e48fcf6535d7ef7334d7548415fc40eeb4438d9746e65cf9d00e35676f');
