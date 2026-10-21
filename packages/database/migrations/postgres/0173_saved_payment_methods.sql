-- Saved payment methods: a buyer's card or wallet kept by its payment
-- provider for later charges without the buyer (a subscription's renewals).
-- The provider vaults the method; the store keeps only its opaque reference
-- and the facts a buyer or staff may see (brand, last four digits, expiry, a
-- label), never a card number or CVC. Written in the batch that applies the
-- payment that kept it, for the order's account customer only; one row per
-- provider method, never moved to another customer. Private operational
-- state: no public read touches it.
CREATE TABLE "customer_payment_methods" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"customer_id" text COLLATE "C" NOT NULL,
	"provider_id" text COLLATE "C" NOT NULL,
	"provider_method_ref" text COLLATE "C" NOT NULL,
	"brand" text COLLATE "C",
	"last4" text COLLATE "C",
	"expiry_month" bigint,
	"expiry_year" bigint,
	"label" text COLLATE "C",
	"status" text COLLATE "C" DEFAULT 'active' NOT NULL,
	"source_order_id" text COLLATE "C",
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "customer_payment_methods_status_check" CHECK("customer_payment_methods"."status" IN ('active', 'removed')),
	CONSTRAINT "customer_payment_methods_last4_check" CHECK("customer_payment_methods"."last4" IS NULL OR (length("customer_payment_methods"."last4") = 4 AND "customer_payment_methods"."last4" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "customer_payment_methods_expiry_check" CHECK(("customer_payment_methods"."expiry_month" IS NULL OR "customer_payment_methods"."expiry_month" BETWEEN 1 AND 12) AND ("customer_payment_methods"."expiry_year" IS NULL OR "customer_payment_methods"."expiry_year" BETWEEN 2000 AND 2200))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_methods_provider_ref_unique" ON "customer_payment_methods" ("provider_id","provider_method_ref");
--> statement-breakpoint
CREATE INDEX "customer_payment_methods_customer_idx" ON "customer_payment_methods" ("customer_id","status");
--> statement-breakpoint
CREATE INDEX "customer_payment_methods_source_order_idx" ON "customer_payment_methods" ("source_order_id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (173, '0173_saved_payment_methods', '9e743d00fc29a72692ae558bdc25990d4ebc5ea6866fa82985c714a62088b315');