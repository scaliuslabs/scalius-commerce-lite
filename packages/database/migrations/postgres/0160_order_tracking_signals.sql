CREATE TABLE "order_tracking_signals" (
	"order_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"consent_analytics" bigint NOT NULL,
	"consent_marketing" bigint NOT NULL,
	"consent_sale_of_data" bigint NOT NULL,
	"consent_source" text COLLATE "C" NOT NULL,
	"fbp" text COLLATE "C",
	"fbc" text COLLATE "C",
	"ttp" text COLLATE "C",
	"ttclid" text COLLATE "C",
	"ga_client_id" text COLLATE "C",
	"ga_session_id" text COLLATE "C",
	"gclid" text COLLATE "C",
	"client_ip" text COLLATE "C",
	"user_agent" text COLLATE "C",
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "order_tracking_signals_created_idx" ON "order_tracking_signals" ("created_at");
--> statement-breakpoint
CREATE TABLE "tracking_deliveries" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"destination" text COLLATE "C" NOT NULL,
	"event_name" text COLLATE "C" NOT NULL,
	"dedup_key" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"payment_id" text COLLATE "C",
	"status" text COLLATE "C" DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text COLLATE "C",
	"claim_expires_at" bigint,
	"match_signals" text COLLATE "C",
	"last_error" text COLLATE "C",
	"sent_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_deliveries_dedup_unique" ON "tracking_deliveries" ("destination","dedup_key");
--> statement-breakpoint
CREATE INDEX "tracking_deliveries_due_idx" ON "tracking_deliveries" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "tracking_deliveries_claim_idx" ON "tracking_deliveries" ("status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "tracking_deliveries_created_idx" ON "tracking_deliveries" ("created_at");
--> statement-breakpoint
CREATE INDEX "tracking_deliveries_order_idx" ON "tracking_deliveries" ("order_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tracking_ga4_refund_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "tracking_deliveries" ("id", "destination", "event_name", "dedup_key", "order_id", "payment_id")
  VALUES ('trk_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24), 'ga4', 'refund', 'refund:' || NEW."id", NEW."order_id", NEW."id")
  ON CONFLICT ("destination", "dedup_key") DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "tracking_ga4_refund_insert"
AFTER INSERT ON "order_payments"
FOR EACH ROW
WHEN (NEW."payment_type" = 'refund' AND NEW."status" = 'refunded' AND EXISTS (SELECT 1 FROM "tracking_deliveries" WHERE "destination" = 'ga4' AND "dedup_key" = 'purchase:' || NEW."order_id" AND "status" = 'sent'))
EXECUTE FUNCTION scalius_compat."tracking_ga4_refund_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tracking_ga4_refund_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "tracking_deliveries" ("id", "destination", "event_name", "dedup_key", "order_id", "payment_id")
  VALUES ('trk_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24), 'ga4', 'refund', 'refund:' || NEW."id", NEW."order_id", NEW."id")
  ON CONFLICT ("destination", "dedup_key") DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "tracking_ga4_refund_update"
AFTER UPDATE ON "order_payments"
FOR EACH ROW
WHEN (NEW."payment_type" = 'refund' AND NEW."status" = 'refunded' AND OLD."status" IS DISTINCT FROM 'refunded' AND EXISTS (SELECT 1 FROM "tracking_deliveries" WHERE "destination" = 'ga4' AND "dedup_key" = 'purchase:' || NEW."order_id" AND "status" = 'sent'))
EXECUTE FUNCTION scalius_compat."tracking_ga4_refund_update_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (160, '0160_order_tracking_signals', '2288de59a047c4daea18883f65b105cf4b2be5fc9004f85311611b0dc9301382');
