-- Markets step 6 (docs/MARKETS-DESIGN.md D2-D5, "Step 6 implemented"): a
-- second currency.
--
-- markets gain the currency they sell in: currency_code NULL sells in the
-- shop currency (the backup market always does); a code sells in that
-- currency, its prices converted from the base prices at fx_rate (price mode
-- `fx`) unless a price list fixes them (MARKET_CURRENCY_INVALID). The rate
-- keeps the time it was set (fx_rate_as_of, an order's fx_as_of) and the
-- minutes a placed order keeps it (fx_lock_minutes, default 30: an order's
-- fx_locked_until). Nothing changes for a store: every market keeps the shop
-- currency.
--
-- A change of a market's currency or lock advances the checkout authority
-- fence: a checkout priced in the old currency prices again. Its row's cache
-- dependency trigger (generated from packages/shared/src/cache-deps.ts) gains
-- the currency.
--
-- customer_order_stats counts what customers spent in the shop currency: an
-- order paid in another currency adds its paid share of its shop total. A
-- same-currency order adds what it did before, so no row changes.
ALTER TABLE "markets" ADD COLUMN "currency_code" text CONSTRAINT "markets_currency_shape" CHECK ("currency_code" IS NULL OR (length("currency_code") = 3 AND "currency_code" !~ '[^A-Z]'));
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "fx_rate_as_of" bigint;
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "fx_lock_minutes" bigint DEFAULT 30 NOT NULL CONSTRAINT "markets_fx_lock_minutes" CHECK ("fx_lock_minutes" BETWEEN 5 AND 1440);
--> statement-breakpoint
-- A manual rate set before step 6 is as of the market's last change.
UPDATE "markets" SET "fx_rate_as_of" = "updated_at" WHERE "fx_rate" IS NOT NULL;
--> statement-breakpoint
-- The backup market sells in the shop currency; a market in another
-- currency derives its prices at its rate.
CREATE OR REPLACE FUNCTION scalius_compat."markets_currency_insert_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."currency_code" IS NOT NULL AND (NEW."is_backup" = 1 OR NEW."price_mode" <> 'fx')), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'MARKET_CURRENCY_INVALID';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "markets_currency_insert_guard"
BEFORE INSERT ON "markets"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."markets_currency_insert_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."markets_currency_update_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."currency_code" IS NOT NULL AND (NEW."is_backup" = 1 OR NEW."price_mode" <> 'fx')), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'MARKET_CURRENCY_INVALID';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "markets_currency_update_guard"
BEFORE UPDATE OF "currency_code", "is_backup", "price_mode" ON "markets"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."markets_currency_update_guard_fn"();
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status,
-- its tax inclusion, its pricing, its currency, its rate lock or a country's
-- market changed reviews again.
CREATE OR REPLACE FUNCTION scalius_compat."markets_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."price_increment_minor" IS DISTINCT FROM OLD."price_increment_minor" OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."prices_include_tax" IS DISTINCT FROM OLD."prices_include_tax" OR NEW."price_mode" IS DISTINCT FROM OLD."price_mode" OR NEW."fx_rate" IS DISTINCT FROM OLD."fx_rate" OR NEW."price_adjustment_bps" IS DISTINCT FROM OLD."price_adjustment_bps" OR NEW."price_rounding_minor" IS DISTINCT FROM OLD."price_rounding_minor" OR NEW."price_ending_minor" IS DISTINCT FROM OLD."price_ending_minor" OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code" OR NEW."fx_lock_minutes" IS DISTINCT FROM OLD."fx_lock_minutes"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_markets_upd" ON "markets";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_markets_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:' || NEW."id", 'mk:*', 't:markets']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_markets_upd"
AFTER UPDATE ON "markets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."handle" IS DISTINCT FROM NEW."handle" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."is_backup" IS DISTINCT FROM NEW."is_backup" OR OLD."price_increment_minor" IS DISTINCT FROM NEW."price_increment_minor" OR OLD."currency_code" IS DISTINCT FROM NEW."currency_code"))
EXECUTE FUNCTION scalius_compat."cdep_markets_upd_fn"();
--> statement-breakpoint
-- customer_order_stats: what each customer spent, in the shop currency.
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."customer_id" IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(CASE WHEN "orders"."currency_code" = "orders"."shop_currency" OR "orders"."total_amount_minor" <= 0 THEN max("orders"."paid_amount_minor", 0) ELSE CAST(round(max("orders"."paid_amount_minor", 0) * 1.0 * "orders"."total_shop_minor" / "orders"."total_amount_minor") AS bigint) END), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = NEW."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."customer_id" IS NOT NULL AND (OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."paid_amount_minor" IS DISTINCT FROM NEW."paid_amount_minor" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR (OLD."status" IS DISTINCT FROM NEW."status" AND (OLD."status" = 'incomplete' OR NEW."status" = 'incomplete')) OR (NEW."currency_code" <> NEW."shop_currency" AND (OLD."total_shop_minor" IS DISTINCT FROM NEW."total_shop_minor" OR OLD."total_amount_minor" IS DISTINCT FROM NEW."total_amount_minor")))), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(CASE WHEN "orders"."currency_code" = "orders"."shop_currency" OR "orders"."total_amount_minor" <= 0 THEN max("orders"."paid_amount_minor", 0) ELSE CAST(round(max("orders"."paid_amount_minor", 0) * 1.0 * "orders"."total_shop_minor" / "orders"."total_amount_minor") AS bigint) END), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = NEW."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."customer_id" IS NOT NULL AND OLD."customer_id" IS DISTINCT FROM NEW."customer_id"), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(CASE WHEN "orders"."currency_code" = "orders"."shop_currency" OR "orders"."total_amount_minor" <= 0 THEN max("orders"."paid_amount_minor", 0) ELSE CAST(round(max("orders"."paid_amount_minor", 0) * 1.0 * "orders"."total_shop_minor" / "orders"."total_amount_minor") AS bigint) END), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = OLD."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."customer_id" IS NOT NULL), false) THEN
    RETURN OLD;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(CASE WHEN "orders"."currency_code" = "orders"."shop_currency" OR "orders"."total_amount_minor" <= 0 THEN max("orders"."paid_amount_minor", 0) ELSE CAST(round(max("orders"."paid_amount_minor", 0) * 1.0 * "orders"."total_shop_minor" / "orders"."total_amount_minor") AS bigint) END), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = OLD."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (123, '0123_market_currencies', '6c6cf8a662eef18fd8a097c8dd413acb6a85a681d150d355d08e9b5549770977');
