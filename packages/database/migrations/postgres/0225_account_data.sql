-- What a buyer's account reads: see ../0225_account_data.sql.
CREATE TABLE "account_order_totals" (
	"customer_id" text COLLATE "C" NOT NULL,
	"currency_code" text COLLATE "C" NOT NULL,
	"orders_count" bigint DEFAULT 0 NOT NULL,
	"spent_minor" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("customer_id", "currency_code"),
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "account_order_totals_nonnegative" CHECK("account_order_totals"."orders_count" >= 0 AND "account_order_totals"."spent_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "whatsapp" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "buyer_account_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "topic" text COLLATE "C";
--> statement-breakpoint
CREATE INDEX "conversations_buyer_account_idx" ON "conversations" ("buyer_account_id","last_message_at" DESC,"id") WHERE "conversations"."buyer_account_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "translations" DROP CONSTRAINT "translations_resource_type_check";
--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_resource_type_check" CHECK("translations"."resource_type" IN ('product', 'product_variant', 'product_option', 'product_option_value', 'collection', 'category', 'brand', 'page', 'menu', 'shipping_method', 'payment_method', 'conversation_topic'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."account_order_totals_order_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW.account_owner_customer_id IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT NEW.account_owner_customer_id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = NEW.account_owner_customer_id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "account_order_totals_order_ins"
AFTER INSERT ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."account_order_totals_order_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."account_order_totals_order_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW.account_owner_customer_id IS NOT NULL AND (OLD.account_owner_customer_id IS DISTINCT FROM NEW.account_owner_customer_id OR OLD.currency_code IS DISTINCT FROM NEW.currency_code OR OLD.paid_amount_minor IS DISTINCT FROM NEW.paid_amount_minor OR OLD.disputed_minor IS DISTINCT FROM NEW.disputed_minor OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete')))), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT NEW.account_owner_customer_id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = NEW.account_owner_customer_id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "account_order_totals_order_upd"
AFTER UPDATE OF "account_owner_customer_id", "currency_code", "paid_amount_minor", "disputed_minor", "deleted_at", "status" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."account_order_totals_order_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."account_order_totals_order_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.account_owner_customer_id IS NOT NULL AND (OLD.account_owner_customer_id IS DISTINCT FROM NEW.account_owner_customer_id OR OLD.currency_code IS DISTINCT FROM NEW.currency_code)), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT OLD.account_owner_customer_id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = OLD.account_owner_customer_id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "account_order_totals_order_upd_old"
AFTER UPDATE OF "account_owner_customer_id", "currency_code" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."account_order_totals_order_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."account_order_totals_order_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.account_owner_customer_id IS NOT NULL), false) THEN
    RETURN OLD;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT OLD.account_owner_customer_id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id = OLD.account_owner_customer_id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "account_order_totals_order_del"
AFTER DELETE ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."account_order_totals_order_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."conversations_buyer_account_store_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW.subject_type = 'store' AND NEW.channel IS NULL AND NEW.customer_id IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  UPDATE conversations SET buyer_account_id = NEW.customer_id WHERE id = NEW.id;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "conversations_buyer_account_store"
AFTER INSERT ON "conversations"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."conversations_buyer_account_store_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."conversations_buyer_account_order_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW.subject_type <> 'store' AND NEW.order_id IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order WHERE owner_order.id = NEW.order_id AND owner_order.deleted_at IS NULL) WHERE id = NEW.id;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "conversations_buyer_account_order"
AFTER INSERT ON "conversations"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."conversations_buyer_account_order_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."orders_conversations_buyer_account_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.account_owner_customer_id IS DISTINCT FROM NEW.account_owner_customer_id OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  UPDATE conversations SET buyer_account_id = (CASE WHEN NEW.deleted_at IS NULL THEN NEW.account_owner_customer_id END) WHERE order_id = NEW.id AND subject_type <> 'store';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "orders_conversations_buyer_account"
AFTER UPDATE OF "account_owner_customer_id", "deleted_at" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."orders_conversations_buyer_account_fn"();
--> statement-breakpoint
INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT orders.account_owner_customer_id, orders.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders
    WHERE orders.account_owner_customer_id IS NOT NULL AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    GROUP BY orders.account_owner_customer_id, orders.currency_code;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = customer_id WHERE subject_type = 'store' AND channel IS NULL AND customer_id IS NOT NULL;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order
    WHERE owner_order.id = conversations.order_id AND owner_order.deleted_at IS NULL)
    WHERE subject_type <> 'store' AND order_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_ins" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE NEW.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || NEW."resource_type" || ':' || NEW."resource_id", 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_ins"
AFTER INSERT ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_translations_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_del" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE OLD.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || OLD."resource_type" || ':' || OLD."resource_id", 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_del"
AFTER DELETE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_translations_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_upd" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE NEW.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || NEW."resource_type" || ':' || NEW."resource_id", 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_upd"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."fields" IS DISTINCT FROM NEW."fields" OR OLD."source_digest" IS DISTINCT FROM NEW."source_digest"))
EXECUTE FUNCTION scalius_compat."cdep_translations_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_upd_old" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE OLD.resource_type NOT IN ('product_variant', 'product_option', 'product_option_value'))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || OLD."resource_type" || ':' || OLD."resource_id", 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_upd_old"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id"))
EXECUTE FUNCTION scalius_compat."cdep_translations_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_sku_ins" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_sku_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_sku_ins"
AFTER INSERT ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."resource_type" = 'product_variant')
EXECUTE FUNCTION scalius_compat."cdep_translations_sku_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_sku_del" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_sku_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_sku_del"
AFTER DELETE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."resource_type" = 'product_variant')
EXECUTE FUNCTION scalius_compat."cdep_translations_sku_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_sku_upd" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_sku_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_sku_upd"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."fields" IS DISTINCT FROM NEW."fields" OR OLD."source_digest" IS DISTINCT FROM NEW."source_digest") AND NEW."resource_type" = 'product_variant')
EXECUTE FUNCTION scalius_compat."cdep_translations_sku_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_sku_upd_old" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_sku_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_sku_upd_old"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type") AND OLD."resource_type" = 'product_variant')
EXECUTE FUNCTION scalius_compat."cdep_translations_sku_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_option_ins" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_option_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_option_definitions" WHERE "id" = NEW."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_option_ins"
AFTER INSERT ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."resource_type" = 'product_option')
EXECUTE FUNCTION scalius_compat."cdep_translations_option_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_option_del" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_option_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_option_definitions" WHERE "id" = OLD."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_option_del"
AFTER DELETE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."resource_type" = 'product_option')
EXECUTE FUNCTION scalius_compat."cdep_translations_option_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_option_upd" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_option_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_option_definitions" WHERE "id" = NEW."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_option_upd"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."fields" IS DISTINCT FROM NEW."fields" OR OLD."source_digest" IS DISTINCT FROM NEW."source_digest") AND NEW."resource_type" = 'product_option')
EXECUTE FUNCTION scalius_compat."cdep_translations_option_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_option_upd_old" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_option_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:product:' || (SELECT "product_id" FROM "product_option_definitions" WHERE "id" = OLD."resource_id"), 't:translations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_option_upd_old"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type") AND OLD."resource_type" = 'product_option')
EXECUTE FUNCTION scalius_compat."cdep_translations_option_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_value_ins" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_value_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:translations']::text[]) AS key_list(value) UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = NEW.resource_id) AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_value_ins"
AFTER INSERT ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."resource_type" = 'product_option_value')
EXECUTE FUNCTION scalius_compat."cdep_translations_value_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_value_del" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_value_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:translations']::text[]) AS key_list(value) UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = OLD.resource_id) AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_value_del"
AFTER DELETE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."resource_type" = 'product_option_value')
EXECUTE FUNCTION scalius_compat."cdep_translations_value_del_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_value_upd" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_value_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:translations']::text[]) AS key_list(value) UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = NEW.resource_id) AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_value_upd"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."fields" IS DISTINCT FROM NEW."fields" OR OLD."source_digest" IS DISTINCT FROM NEW."source_digest") AND NEW."resource_type" = 'product_option_value')
EXECUTE FUNCTION scalius_compat."cdep_translations_value_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_translations_value_upd_old" ON "translations";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_translations_value_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:translations']::text[]) AS key_list(value) UNION SELECT 'tr:product:' || key_ref_0.ref FROM (SELECT value_option.product_id AS ref FROM product_option_values AS translated_value JOIN product_option_definitions AS value_option ON value_option.id = translated_value.option_definition_id WHERE translated_value.id = OLD.resource_id) AS key_ref_0));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_translations_value_upd_old"
AFTER UPDATE ON "translations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."resource_type" IS DISTINCT FROM NEW."resource_type") AND OLD."resource_type" = 'product_option_value')
EXECUTE FUNCTION scalius_compat."cdep_translations_value_upd_old_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (225, '0225_account_data', '2791e86abc59b3355bc372fd0920e6fc0031d0ff840c11ba691e39497390a11c');
