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
DROP INDEX "orders_account_owner_customer_id_idx";
--> statement-breakpoint
CREATE INDEX "orders_account_owner_customer_id_idx" ON "orders" ("account_owner_customer_id","currency_code") WHERE "orders"."account_owner_customer_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "whatsapp" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "buyer_account_id" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "topic" text COLLATE "C";
--> statement-breakpoint
CREATE INDEX "conversations_buyer_account_idx" ON "conversations" ("buyer_account_id","last_message_at" DESC,"id") WHERE "conversations"."buyer_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."account_order_totals_order_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW.account_owner_customer_id IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.status <> 'incomplete')), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = NEW.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
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
  IF NOT coalesce((NEW.account_owner_customer_id IS NOT NULL AND ((OLD.account_owner_customer_id IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'incomplete') OR (NEW.account_owner_customer_id IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.status <> 'incomplete')) AND (OLD.account_owner_customer_id IS DISTINCT FROM NEW.account_owner_customer_id OR OLD.currency_code IS DISTINCT FROM NEW.currency_code OR OLD.paid_amount_minor IS DISTINCT FROM NEW.paid_amount_minor OR OLD.disputed_minor IS DISTINCT FROM NEW.disputed_minor OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete')))), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = NEW.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
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
  IF NOT coalesce(((OLD.account_owner_customer_id IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'incomplete') AND (OLD.account_owner_customer_id IS DISTINCT FROM NEW.account_owner_customer_id OR OLD.currency_code IS DISTINCT FROM NEW.currency_code)), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = OLD.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
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
  IF NOT coalesce(((OLD.account_owner_customer_id IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'incomplete')), false) THEN
    RETURN OLD;
  END IF;
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = OLD.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
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
    SELECT customers.id, orders.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders INNER JOIN customers ON customers.id = orders.account_owner_customer_id
    WHERE orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    GROUP BY customers.id, orders.currency_code;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = customer_id WHERE subject_type = 'store' AND channel IS NULL AND customer_id IS NOT NULL;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order
    WHERE owner_order.id = conversations.order_id AND owner_order.deleted_at IS NULL)
    WHERE subject_type <> 'store' AND order_id IS NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (225, '0225_account_data', '7ac043a3b2e6472df7a310462fc8eeb6c05440923676e2ca2bc4b17ab7fe617f');
