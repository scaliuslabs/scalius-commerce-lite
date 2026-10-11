CREATE TABLE "recommendation_order_products" (
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"buyer" text,
	PRIMARY KEY("order_id", "product_id"),
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "recommendation_order_products_created_idx" ON "recommendation_order_products" ("created_at","product_id","buyer");
--> statement-breakpoint
CREATE INDEX "recommendation_order_products_product_idx" ON "recommendation_order_products" ("product_id","created_at","buyer");
--> statement-breakpoint
CREATE INDEX "product_buyer_state_scope_idx" ON "product_buyer_state" ("is_public","product_id","from_minor","to_minor");
--> statement-breakpoint
INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
SELECT DISTINCT o.id, item.product_id, o.created_at, coalesce(nullif(o.customer_phone, ''), lower(trim(o.customer_email)))
FROM orders o JOIN order_items item ON item.order_id = o.id WHERE o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND o.deleted_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."recommendation_order_products_item_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
    SELECT o.id, NEW.product_id, o.created_at, coalesce(nullif(o.customer_phone, ''), lower(trim(o.customer_email))) FROM orders o
    WHERE o.id = NEW.order_id AND o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND o.deleted_at IS NULL ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS DISTINCT FROM excluded.created_at
     OR recommendation_order_products.buyer IS DISTINCT FROM excluded.buyer;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "recommendation_order_products_item_insert"
AFTER INSERT ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."recommendation_order_products_item_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."recommendation_order_products_item_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM recommendation_order_products
    WHERE order_id = OLD.order_id AND product_id = OLD.product_id
      AND NOT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id = OLD.order_id AND item.product_id = OLD.product_id);
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "recommendation_order_products_item_delete"
AFTER DELETE ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."recommendation_order_products_item_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."recommendation_order_products_item_move_remove_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.order_id IS DISTINCT FROM NEW.order_id OR OLD.product_id IS DISTINCT FROM NEW.product_id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM recommendation_order_products
    WHERE order_id = OLD.order_id AND product_id = OLD.product_id
      AND NOT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id = OLD.order_id AND item.product_id = OLD.product_id);
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "recommendation_order_products_item_move_remove"
AFTER UPDATE OF "order_id", "product_id" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."recommendation_order_products_item_move_remove_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."recommendation_order_products_item_move_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.order_id IS DISTINCT FROM NEW.order_id OR OLD.product_id IS DISTINCT FROM NEW.product_id), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
    SELECT o.id, NEW.product_id, o.created_at, coalesce(nullif(o.customer_phone, ''), lower(trim(o.customer_email))) FROM orders o
    WHERE o.id = NEW.order_id AND o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND o.deleted_at IS NULL ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS DISTINCT FROM excluded.created_at
     OR recommendation_order_products.buyer IS DISTINCT FROM excluded.buyer;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "recommendation_order_products_item_move_insert"
AFTER UPDATE OF "order_id", "product_id" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."recommendation_order_products_item_move_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."recommendation_order_products_order_remove_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) AND NOT (NEW.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND NEW.deleted_at IS NULL)), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM recommendation_order_products WHERE order_id = NEW.id;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "recommendation_order_products_order_remove"
AFTER UPDATE OF "status", "deleted_at" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."recommendation_order_products_order_remove_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."recommendation_order_products_order_refresh_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.customer_phone IS DISTINCT FROM NEW.customer_phone OR OLD.customer_email IS DISTINCT FROM NEW.customer_email) AND NEW.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed') AND NEW.deleted_at IS NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
       SELECT DISTINCT NEW.id, item.product_id, NEW.created_at, coalesce(nullif(NEW.customer_phone, ''), lower(trim(NEW.customer_email)))
       FROM order_items item WHERE item.order_id = NEW.id ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS DISTINCT FROM excluded.created_at
     OR recommendation_order_products.buyer IS DISTINCT FROM excluded.buyer;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "recommendation_order_products_order_refresh"
AFTER UPDATE OF "status", "deleted_at", "created_at", "customer_phone", "customer_email" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."recommendation_order_products_order_refresh_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cdep_orders_upd ON orders;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_orders_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE NEW.deleted_at IS NULL AND NEW.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed'))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['recommendation-signals', 't:orders']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_orders_upd"
AFTER UPDATE ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."customer_phone" IS DISTINCT FROM NEW."customer_phone" OR OLD."customer_email" IS DISTINCT FROM NEW."customer_email" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"))
EXECUTE FUNCTION scalius_compat."cdep_orders_upd_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cdep_orders_upd_old ON orders;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_orders_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 WHERE OLD.deleted_at IS NULL AND OLD.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed'))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['recommendation-signals', 't:orders']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_orders_upd_old"
AFTER UPDATE ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at" OR OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."cdep_orders_upd_old_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cdep_order_items_upd ON order_items;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_order_items_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['recommendation-signals', 't:order_items']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_order_items_upd"
AFTER UPDATE ON "order_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id" OR OLD."order_id" IS DISTINCT FROM NEW."order_id" OR OLD."created_at" IS DISTINCT FROM NEW."created_at"))
EXECUTE FUNCTION scalius_compat."cdep_order_items_upd_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (139, '0139_recommendation_order_products', '77125e88788835063573d29d56110ace40717ffc7f5f6b36f63493c30eb10e1b');
