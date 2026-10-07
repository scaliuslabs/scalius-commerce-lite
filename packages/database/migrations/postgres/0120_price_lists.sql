-- Markets step 4a (docs/MARKETS-DESIGN.md D5, "Step 4a implemented"): price
-- lists and FX-derived market prices.
--
-- price_lists: fixed prices for a market (`market`), for the members of one
-- customer segment in a market (`segment`) or a scheduled sale (`sale`), with
-- a status, a schedule, a priority and a revision. price_list_prices: one
-- price of a SKU in a list per currency and quantity break (`min_quantity`),
-- with an optional compare-at. Market and sale lists price a non-backup
-- market (PRICE_LIST_BACKUP_MARKET): the backup market sells at base prices,
-- so the root catalogue never varies. Segment lists may price any market.
--
-- markets gain how they price: price_mode `fixed` (base and list prices) or
-- `fx` (base prices converted at fx_rate, adjusted by price_adjustment_bps,
-- rounded up to price_rounding_minor and ending in price_ending_minor). The
-- backup market is always `fixed`. Nothing is backfilled: every market stays
-- `fixed` with no list, so every price is today's.
--
-- Every write that can change a checkout price (an active list, its prices, a
-- market's pricing) advances the checkout authority fence. The cache
-- dependency triggers are generated from packages/shared/src/cache-deps.ts.
CREATE TABLE "price_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"market_id" text NOT NULL,
	"segment_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_at" bigint,
	"ends_at" bigint,
	"priority" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("segment_id") REFERENCES "customer_segments"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "price_lists_id_shape" CHECK(substr("price_lists"."id", 1, 3) = 'pl_' AND length("price_lists"."id") BETWEEN 6 AND 40),
	CONSTRAINT "price_lists_name_length" CHECK("price_lists"."name" = trim("price_lists"."name") AND length("price_lists"."name") BETWEEN 1 AND 80),
	CONSTRAINT "price_lists_description_length" CHECK("price_lists"."description" IS NULL OR length("price_lists"."description") BETWEEN 1 AND 300),
	CONSTRAINT "price_lists_kind_check" CHECK("price_lists"."kind" IN ('market', 'segment', 'sale')),
	CONSTRAINT "price_lists_status_check" CHECK("price_lists"."status" IN ('draft', 'active')),
	CONSTRAINT "price_lists_segment_kind" CHECK(("price_lists"."kind" = 'segment') = ("price_lists"."segment_id" IS NOT NULL)),
	CONSTRAINT "price_lists_schedule" CHECK("price_lists"."starts_at" IS NULL OR "price_lists"."ends_at" IS NULL OR "price_lists"."ends_at" > "price_lists"."starts_at"),
	CONSTRAINT "price_lists_priority_range" CHECK("price_lists"."priority" BETWEEN 0 AND 1000),
	CONSTRAINT "price_lists_revision_positive" CHECK("price_lists"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX "price_lists_market_status_idx" ON "price_lists" ("market_id","status");
--> statement-breakpoint
CREATE INDEX "price_lists_segment_idx" ON "price_lists" ("segment_id");
--> statement-breakpoint
CREATE TABLE "price_list_prices" (
	"price_list_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"compare_at_minor" bigint,
	"min_quantity" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("price_list_id", "variant_id", "currency_code", "min_quantity"),
	FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "price_list_prices_currency_shape" CHECK(length("price_list_prices"."currency_code") = 3 AND "price_list_prices"."currency_code" !~ '[^A-Z]'),
	CONSTRAINT "price_list_prices_amount_positive" CHECK("price_list_prices"."amount_minor" > 0),
	CONSTRAINT "price_list_prices_compare_at" CHECK("price_list_prices"."compare_at_minor" IS NULL OR "price_list_prices"."compare_at_minor" > "price_list_prices"."amount_minor"),
	CONSTRAINT "price_list_prices_min_quantity" CHECK("price_list_prices"."min_quantity" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE INDEX "price_list_prices_variant_idx" ON "price_list_prices" ("variant_id");
--> statement-breakpoint
-- How each market prices; every market starts `fixed` (today's prices).
ALTER TABLE "markets" ADD COLUMN "price_mode" text DEFAULT 'fixed' NOT NULL CONSTRAINT "markets_price_mode_check" CHECK ("price_mode" IN ('fixed', 'fx') AND ("is_backup" = 0 OR "price_mode" = 'fixed'));
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "fx_rate" text CONSTRAINT "markets_fx_rate_shape" CHECK ("fx_rate" IS NULL OR (length("fx_rate") BETWEEN 1 AND 25 AND "fx_rate" ~ '^[0-9].*$' AND "fx_rate" !~ '[^0-9.]'));
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "price_adjustment_bps" bigint DEFAULT 0 NOT NULL CONSTRAINT "markets_price_adjustment_range" CHECK ("price_adjustment_bps" BETWEEN -9900 AND 100000);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "price_rounding_minor" bigint CONSTRAINT "markets_price_rounding" CHECK ("price_rounding_minor" IS NULL OR "price_rounding_minor" BETWEEN 1 AND 100000000);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "price_ending_minor" bigint CONSTRAINT "markets_price_ending" CHECK ("price_ending_minor" IS NULL OR ("price_rounding_minor" IS NOT NULL AND "price_ending_minor" > 0 AND "price_ending_minor" < "price_rounding_minor"));
--> statement-breakpoint
-- Market and sale lists price a non-backup market: the backup market sells
-- at base prices (segment lists may price any market).
CREATE OR REPLACE FUNCTION scalius_compat."price_lists_backup_market_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kind" <> 'segment' AND EXISTS (SELECT 1 FROM "markets" WHERE "markets"."id" = NEW."market_id" AND "markets"."is_backup" = 1)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PRICE_LIST_BACKUP_MARKET';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "price_lists_backup_market_insert"
BEFORE INSERT ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_lists_backup_market_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."price_lists_backup_market_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kind" <> 'segment' AND EXISTS (SELECT 1 FROM "markets" WHERE "markets"."id" = NEW."market_id" AND "markets"."is_backup" = 1)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PRICE_LIST_BACKUP_MARKET';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "price_lists_backup_market_update"
BEFORE UPDATE OF "kind", "market_id" ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_lists_backup_market_update_fn"();
--> statement-breakpoint
-- A checkout priced before an active list, its prices or a market's pricing
-- changed reviews again instead of committing.
CREATE OR REPLACE FUNCTION scalius_compat."price_lists_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" = 'active'), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "price_lists_checkout_authority_insert"
AFTER INSERT ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_lists_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."price_lists_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((OLD."status" = 'active' OR NEW."status" = 'active') AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."market_id" IS DISTINCT FROM OLD."market_id" OR NEW."segment_id" IS DISTINCT FROM OLD."segment_id" OR NEW."starts_at" IS DISTINCT FROM OLD."starts_at" OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at" OR NEW."priority" IS DISTINCT FROM OLD."priority")), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "price_lists_checkout_authority_update"
AFTER UPDATE ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_lists_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."price_lists_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."status" = 'active'), false) THEN
    RETURN OLD;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "price_lists_checkout_authority_delete"
AFTER DELETE ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_lists_checkout_authority_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."price_list_prices_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "price_lists" WHERE "price_lists"."id" = NEW."price_list_id" AND "price_lists"."status" = 'active')), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "price_list_prices_checkout_authority_insert"
AFTER INSERT ON "price_list_prices"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_list_prices_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."price_list_prices_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "price_lists" WHERE "price_lists"."id" IN (NEW."price_list_id", OLD."price_list_id") AND "price_lists"."status" = 'active')), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "price_list_prices_checkout_authority_update"
AFTER UPDATE ON "price_list_prices"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_list_prices_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."price_list_prices_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "price_lists" WHERE "price_lists"."id" = OLD."price_list_id" AND "price_lists"."status" = 'active')), false) THEN
    RETURN OLD;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "price_list_prices_checkout_authority_delete"
AFTER DELETE ON "price_list_prices"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."price_list_prices_checkout_authority_delete_fn"();
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status,
-- its tax inclusion, its pricing or a country's market changed reviews again.
CREATE OR REPLACE FUNCTION scalius_compat."markets_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."price_increment_minor" IS DISTINCT FROM OLD."price_increment_minor" OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."prices_include_tax" IS DISTINCT FROM OLD."prices_include_tax" OR NEW."price_mode" IS DISTINCT FROM OLD."price_mode" OR NEW."fx_rate" IS DISTINCT FROM OLD."fx_rate" OR NEW."price_adjustment_bps" IS DISTINCT FROM OLD."price_adjustment_bps" OR NEW."price_rounding_minor" IS DISTINCT FROM OLD."price_rounding_minor" OR NEW."price_ending_minor" IS DISTINCT FROM OLD."price_ending_minor"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_markets_pricing_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pl:' || NEW."id", 't:markets']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_markets_pricing"
AFTER UPDATE ON "markets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."price_mode" IS DISTINCT FROM NEW."price_mode" OR OLD."fx_rate" IS DISTINCT FROM NEW."fx_rate" OR OLD."price_adjustment_bps" IS DISTINCT FROM NEW."price_adjustment_bps" OR OLD."price_rounding_minor" IS DISTINCT FROM NEW."price_rounding_minor" OR OLD."price_ending_minor" IS DISTINCT FROM NEW."price_ending_minor"))
EXECUTE FUNCTION scalius_compat."cdep_markets_pricing_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_markets_pricing_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pl:' || OLD."id", 't:markets']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_markets_pricing_old"
AFTER UPDATE ON "markets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."price_mode" IS DISTINCT FROM NEW."price_mode" OR OLD."fx_rate" IS DISTINCT FROM NEW."fx_rate" OR OLD."price_adjustment_bps" IS DISTINCT FROM NEW."price_adjustment_bps" OR OLD."price_rounding_minor" IS DISTINCT FROM NEW."price_rounding_minor" OR OLD."price_ending_minor" IS DISTINCT FROM NEW."price_ending_minor") AND (OLD."id" IS DISTINCT FROM NEW."id"))
EXECUTE FUNCTION scalius_compat."cdep_markets_pricing_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_lists_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE NEW.kind <> 'segment' AND NEW.status = 'active')), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pl:' || NEW."market_id", 't:price_lists']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_lists_ins"
AFTER INSERT ON "price_lists"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_price_lists_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_lists_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE OLD.kind <> 'segment' AND OLD.status = 'active')), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pl:' || OLD."market_id", 't:price_lists']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_lists_del"
AFTER DELETE ON "price_lists"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_price_lists_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_lists_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE NEW.kind <> 'segment' AND NEW.status = 'active')), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pl:' || NEW."market_id", 't:price_lists']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_lists_upd"
AFTER UPDATE ON "price_lists"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."segment_id" IS DISTINCT FROM NEW."segment_id" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."starts_at" IS DISTINCT FROM NEW."starts_at" OR OLD."ends_at" IS DISTINCT FROM NEW."ends_at" OR OLD."priority" IS DISTINCT FROM NEW."priority"))
EXECUTE FUNCTION scalius_compat."cdep_price_lists_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_lists_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE OLD.kind <> 'segment' AND OLD.status = 'active')), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pl:' || OLD."market_id", 't:price_lists']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_lists_upd_old"
AFTER UPDATE ON "price_lists"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."cdep_price_lists_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_list_prices_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:price_list_prices']::text[]) AS key_list(value) UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = NEW.price_list_id AND price_sku.id = NEW.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_list_prices_ins"
AFTER INSERT ON "price_list_prices"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_price_list_prices_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_list_prices_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:price_list_prices']::text[]) AS key_list(value) UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = OLD.price_list_id AND price_sku.id = OLD.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_list_prices_del"
AFTER DELETE ON "price_list_prices"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_price_list_prices_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_list_prices_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:price_list_prices']::text[]) AS key_list(value) UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = NEW.price_list_id AND price_sku.id = NEW.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_list_prices_upd"
AFTER UPDATE ON "price_list_prices"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."price_list_id" IS DISTINCT FROM NEW."price_list_id" OR OLD."variant_id" IS DISTINCT FROM NEW."variant_id" OR OLD."currency_code" IS DISTINCT FROM NEW."currency_code" OR OLD."amount_minor" IS DISTINCT FROM NEW."amount_minor" OR OLD."compare_at_minor" IS DISTINCT FROM NEW."compare_at_minor" OR OLD."min_quantity" IS DISTINCT FROM NEW."min_quantity"))
EXECUTE FUNCTION scalius_compat."cdep_price_list_prices_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_price_list_prices_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:price_list_prices']::text[]) AS key_list(value) UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = OLD.price_list_id AND price_sku.id = OLD.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_price_list_prices_upd_old"
AFTER UPDATE ON "price_list_prices"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."price_list_id" IS DISTINCT FROM NEW."price_list_id" OR OLD."variant_id" IS DISTINCT FROM NEW."variant_id"))
EXECUTE FUNCTION scalius_compat."cdep_price_list_prices_upd_old_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (120, '0120_price_lists', '79cc8a68ea53ea7d0bf32662d98755c46384e1d1e1ea8018d405c325967c3ae4');
