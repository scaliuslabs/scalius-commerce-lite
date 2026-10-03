-- Markets step 1 (docs/MARKETS-DESIGN.md D2, D3): the order money chain and
-- payment settlement, as no-ops for a single-currency store. See the D1/Turso
-- migration of the same name: orders gain the shop-currency snapshot
-- (shop_currency, fx_rate, fx_source, fx_as_of, fx_locked_until and the
-- *_shop_minor totals); order_payments gain settlement_currency,
-- settlement_amount_minor, settlement_rate and exchange_adjustment_minor.
-- Every existing order is same-currency (rate '1', shop = presentment) and
-- every existing movement settled as presented. The backfills touch only the
-- new columns, which no trigger watches.
ALTER TABLE "order_payments" ADD COLUMN "settlement_currency" text DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_payments" ADD COLUMN "settlement_amount_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_payments" ADD COLUMN "settlement_rate" text DEFAULT '1' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_payments" ADD COLUMN "exchange_adjustment_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_currency" text DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_rate" text DEFAULT '1' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_source" text DEFAULT 'same_currency' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_as_of" bigint;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_locked_until" bigint;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal_shop_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_shop_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_shop_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_shop_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "total_shop_minor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "orders" SET
  "shop_currency" = "currency_code",
  "subtotal_shop_minor" = "subtotal_amount_minor",
  "shipping_shop_minor" = "shipping_amount_minor",
  "discount_shop_minor" = "discount_amount_minor",
  "tax_shop_minor" = "tax_amount_minor",
  "total_shop_minor" = "total_amount_minor";
--> statement-breakpoint
UPDATE "order_payments" SET
  "settlement_currency" = "currency",
  "settlement_amount_minor" = "amount_minor";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (111, '0111_order_money_chain', '19d1617b34d3c5f245a316505431358960578e214440de499ab3fb33f58f6833');
