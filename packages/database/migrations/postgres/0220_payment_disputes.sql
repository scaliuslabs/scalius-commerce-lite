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
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (220, '0220_payment_disputes', '9bb9606a433cf553967f4ca44d8bd9751d085c66e82bfb422d61a4e73e595623');
