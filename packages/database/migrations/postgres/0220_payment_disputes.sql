-- Disputes (chargebacks) on captured payments: see ../0220_payment_disputes.sql.
CREATE TABLE "payment_disputes" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"payment_id" text COLLATE "C" NOT NULL,
	"gateway" text COLLATE "C" NOT NULL,
	"dispute_ref" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" DEFAULT 'needs_response' NOT NULL,
	"funds" text COLLATE "C" DEFAULT 'held' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"counted_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text COLLATE "C" NOT NULL,
	"reason" text COLLATE "C",
	"evidence_due_at" bigint,
	"fee_minor" bigint,
	"fee_currency" text COLLATE "C",
	"buyer_message" text COLLATE "C",
	"dashboard_url" text COLLATE "C",
	"recorded_by" text COLLATE "C",
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"closed_at" bigint,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("payment_id") REFERENCES "order_payments"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "payment_disputes_status_check" CHECK("payment_disputes"."status" IN ('needs_response', 'under_review', 'won', 'lost')),
	CONSTRAINT "payment_disputes_funds_check" CHECK("payment_disputes"."funds" IN ('held', 'withdrawn', 'reinstated')),
	CONSTRAINT "payment_disputes_amount_positive" CHECK("payment_disputes"."amount_minor" > 0),
	CONSTRAINT "payment_disputes_counted_within_amount" CHECK("payment_disputes"."counted_minor" >= 0 AND "payment_disputes"."counted_minor" <= "payment_disputes"."amount_minor"),
	CONSTRAINT "payment_disputes_fee_nonnegative" CHECK("payment_disputes"."fee_minor" IS NULL OR "payment_disputes"."fee_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_disputes_ref_unique" ON "payment_disputes" ("gateway","dispute_ref");
--> statement-breakpoint
CREATE INDEX "payment_disputes_order_idx" ON "payment_disputes" ("order_id");
--> statement-breakpoint
CREATE INDEX "payment_disputes_payment_idx" ON "payment_disputes" ("payment_id");
--> statement-breakpoint
CREATE INDEX "payment_disputes_awaiting_idx" ON "payment_disputes" ("evidence_due_at") WHERE "payment_disputes"."status" = 'needs_response';
--> statement-breakpoint
ALTER TABLE "orders" ADD "disputed_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "analytics_order_facts" ADD "dispute_sum" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."analytics_disputes_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW.funds = 'withdrawn'), false) THEN
    RETURN NEW;
  END IF;
  UPDATE analytics_order_facts SET dispute_sum = dispute_sum + (case when order_id = NEW.order_id and NEW.funds = 'withdrawn' then coalesce(NEW.counted_minor, 0) else 0 end) WHERE order_id IN (NEW.order_id);
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "analytics_disputes_insert"
AFTER INSERT ON "payment_disputes"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."analytics_disputes_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."analytics_disputes_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((OLD.order_id IS DISTINCT FROM NEW.order_id OR OLD.funds IS DISTINCT FROM NEW.funds OR OLD.counted_minor IS DISTINCT FROM NEW.counted_minor) AND (OLD.funds = 'withdrawn' OR NEW.funds = 'withdrawn')), false) THEN
    RETURN NEW;
  END IF;
  UPDATE analytics_order_facts SET dispute_sum = dispute_sum - (case when order_id = OLD.order_id and OLD.funds = 'withdrawn' then coalesce(OLD.counted_minor, 0) else 0 end) + (case when order_id = NEW.order_id and NEW.funds = 'withdrawn' then coalesce(NEW.counted_minor, 0) else 0 end) WHERE order_id IN (OLD.order_id, NEW.order_id);
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "analytics_disputes_update"
AFTER UPDATE OF "order_id", "funds", "counted_minor" ON "payment_disputes"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."analytics_disputes_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."analytics_disputes_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.funds = 'withdrawn'), false) THEN
    RETURN OLD;
  END IF;
  UPDATE analytics_order_facts SET dispute_sum = dispute_sum - (case when order_id = OLD.order_id and OLD.funds = 'withdrawn' then coalesce(OLD.counted_minor, 0) else 0 end) WHERE order_id IN (OLD.order_id);
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "analytics_disputes_delete"
AFTER DELETE ON "payment_disputes"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."analytics_disputes_delete_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (220, '0220_payment_disputes', '3f3d66286d129c9376b2aefdf09d5e515f96fc239205bb09727adf7b068fa469');
