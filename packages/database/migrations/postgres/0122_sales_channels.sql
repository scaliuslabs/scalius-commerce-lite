-- Markets step 5 (docs/MARKETS-DESIGN.md D6, "Step 5 implemented"): sales
-- channels, product publications and channel stock locations.
--
-- sales_channels lists where products are published. Like Shopify, each
-- surface is its own channel: the online store (`sc_online_store`, always
-- active), the Google catalogue feed (`sc_google`), the Meta catalogue feed
-- (`sc_meta`) and AI agents (`sc_agents`: the UCP catalogue and buyer-agent
-- checkout). An app declares more (`kind = 'app'`, its `plugin_id`).
--
-- product_channel_publications: a product is published to a channel while its
-- row has no unpublished_at. Every product is backfilled to every channel, so
-- the storefront, the feeds and UCP list what they listed before. The product
-- flag exclude_from_product_feed becomes the feed and agent publications (one
-- truth): a product it excluded is unpublished from Google, Meta and AI agents,
-- and the column is dropped. A new product is published to every channel.
--
-- sales_channel_locations: the locations whose on-hand a channel sells. Every
-- channel is linked to every location, and a new channel or location is
-- linked to all of the other kind, so a channel's sellable stock stays the
-- SKU's stock until a merchant unlinks one. Never a per-channel stock count.
--
-- orders.sales_channel_id names the channel an order sold from, beside the
-- attribution `channel`: buyer agents' orders sell from AI agents, every other
-- order from the online store. It never changes.
--
-- The default inventory location takes the store's country (the backup
-- market's) while nobody has edited it: its country was a 'BD' literal.
--
-- Unpublishing a product or deactivating a channel advances the checkout
-- authority fence. The cache dependency and event triggers are generated
-- from packages/shared/src/cache-deps.ts and
-- packages/database/scripts/event-outbox-triggers.ts.
CREATE TABLE "sales_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"plugin_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "sales_channels_id_shape" CHECK(length("sales_channels"."id") BETWEEN 4 AND 160 AND "sales_channels"."id" !~ '[^a-z0-9._:-]'),
	CONSTRAINT "sales_channels_handle_shape" CHECK(length("sales_channels"."handle") BETWEEN 1 AND 160 AND "sales_channels"."handle" !~ '[^a-z0-9._:-]'),
	CONSTRAINT "sales_channels_name_length" CHECK("sales_channels"."name" = trim("sales_channels"."name") AND length("sales_channels"."name") BETWEEN 1 AND 80),
	CONSTRAINT "sales_channels_kind_check" CHECK("sales_channels"."kind" IN ('online_store', 'pos', 'catalog_feed', 'agent', 'app')),
	CONSTRAINT "sales_channels_status_check" CHECK("sales_channels"."status" IN ('active', 'inactive')),
	CONSTRAINT "sales_channels_app_plugin" CHECK(("sales_channels"."kind" = 'app') = ("sales_channels"."plugin_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channels_handle_unique" ON "sales_channels" (lower(trim("handle")));
--> statement-breakpoint
CREATE INDEX "sales_channels_plugin_idx" ON "sales_channels" ("plugin_id") WHERE "sales_channels"."plugin_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "product_channel_publications" (
	"product_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"published_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"unpublished_at" bigint,
	PRIMARY KEY("product_id", "channel_id"),
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("channel_id") REFERENCES "sales_channels"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_channel_publications_dates" CHECK("product_channel_publications"."unpublished_at" IS NULL OR "product_channel_publications"."unpublished_at" >= "product_channel_publications"."published_at")
);
--> statement-breakpoint
CREATE INDEX "product_channel_publications_channel_idx" ON "product_channel_publications" ("channel_id","product_id") WHERE "product_channel_publications"."unpublished_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "sales_channel_locations" (
	"channel_id" text NOT NULL,
	"location_id" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("channel_id", "location_id"),
	FOREIGN KEY ("channel_id") REFERENCES "sales_channels"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "sales_channel_locations_location_idx" ON "sales_channel_locations" ("location_id");
--> statement-breakpoint
-- The built-in channels (the dashboard shows their names in the staff
-- member's language).
INSERT INTO "sales_channels" ("id", "handle", "name", "kind", "status", "position") VALUES
	('sc_online_store', 'online-store', 'Online store', 'online_store', 'active', 0),
	('sc_google', 'google', 'Google', 'catalog_feed', 'active', 1),
	('sc_meta', 'meta', 'Facebook and Instagram', 'catalog_feed', 'active', 2),
	('sc_agents', 'agents', 'AI agents', 'agent', 'active', 3);
--> statement-breakpoint
-- Every channel sells every location's stock, as checkout did before.
INSERT INTO "sales_channel_locations" ("channel_id", "location_id")
SELECT "sales_channels"."id", "inventory_locations"."id" FROM "sales_channels", "inventory_locations";
--> statement-breakpoint
-- Every product is published to every channel, except that a product the
-- feed flag excluded is unpublished from the feeds and AI agents (UCP read
-- the same flag).
INSERT INTO "product_channel_publications" ("product_id", "channel_id", "published_at", "unpublished_at")
SELECT "products"."id", "sales_channels"."id", least("products"."created_at", unixepoch()),
	CASE WHEN "products"."exclude_from_product_feed" = 1 AND "sales_channels"."id" <> 'sc_online_store' THEN unixepoch() ELSE NULL END
FROM "products", "sales_channels";
--> statement-breakpoint
-- The feed flag's triggers are reinstalled without it below.
DROP TRIGGER IF EXISTS "cdep_products_upd" ON "products";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_products_seo" ON "products";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "exclude_from_product_feed";
--> statement-breakpoint
-- A row written without a sales channel (raw SQL) is the online store's.
-- Order writers set it in the insert.
ALTER TABLE "orders" ADD COLUMN "sales_channel_id" text DEFAULT 'sc_online_store' NOT NULL;
--> statement-breakpoint
CREATE INDEX "orders_sales_channel_idx" ON "orders" ("sales_channel_id") WHERE "orders"."sales_channel_id" <> 'sc_online_store';
--> statement-breakpoint
UPDATE "orders" SET "sales_channel_id" = 'sc_agents' WHERE "channel" = 'agent';
--> statement-breakpoint
-- The default location takes the store's country while it is as 0102 made it.
UPDATE "inventory_locations"
SET "country_code" = (SELECT "country_code" FROM "market_countries" WHERE "market_id" = 'mkt_backup' ORDER BY "country_code" LIMIT 1), "updated_at" = unixepoch()
WHERE "id" = 'loc_default' AND "version" = 1
	AND "address_line1" IS NULL AND "city" IS NULL AND "postal_code" IS NULL
	AND EXISTS (SELECT 1 FROM "market_countries" WHERE "market_id" = 'mkt_backup')
	AND NOT EXISTS (SELECT 1 FROM "market_countries" WHERE "market_id" = 'mkt_backup' AND "country_code" = "inventory_locations"."country_code");
--> statement-breakpoint
-- The online store is the storefront: it is always active and never removed.
CREATE OR REPLACE FUNCTION scalius_compat."sales_channels_online_store_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."id" = 'sc_online_store'), false) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SALES_CHANNEL_ONLINE_STORE_REQUIRED';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "sales_channels_online_store_delete"
BEFORE DELETE ON "sales_channels"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."sales_channels_online_store_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."sales_channels_online_store_status_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."id" = 'sc_online_store' AND NEW."status" <> 'active'), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SALES_CHANNEL_ONLINE_STORE_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "sales_channels_online_store_status"
BEFORE UPDATE OF "status" ON "sales_channels"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."sales_channels_online_store_status_fn"();
--> statement-breakpoint
-- A channel's kind and app never change (an app's channel is its own).
CREATE OR REPLACE FUNCTION scalius_compat."sales_channels_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."plugin_id" IS DISTINCT FROM OLD."plugin_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SALES_CHANNEL_IDENTITY_IMMUTABLE';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "sales_channels_identity_immutable"
BEFORE UPDATE OF "kind", "plugin_id" ON "sales_channels"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."sales_channels_identity_immutable_fn"();
--> statement-breakpoint
-- A new channel sells every location's stock; a new location is sold by
-- every channel.
CREATE OR REPLACE FUNCTION scalius_compat."sales_channels_link_locations_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "sales_channel_locations" ("channel_id", "location_id") SELECT NEW."id", "inventory_locations"."id" FROM "inventory_locations" WHERE "inventory_locations"."id" IS NOT NULL ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "sales_channels_link_locations"
AFTER INSERT ON "sales_channels"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."sales_channels_link_locations_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."inventory_locations_link_channels_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "sales_channel_locations" ("channel_id", "location_id") SELECT "sales_channels"."id", NEW."id" FROM "sales_channels" WHERE "sales_channels"."id" IS NOT NULL ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "inventory_locations_link_channels"
AFTER INSERT ON "inventory_locations"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."inventory_locations_link_channels_fn"();
--> statement-breakpoint
-- A new product is published to every channel; the product form, the bulk
-- actions and the API unpublish it where the merchant says.
CREATE OR REPLACE FUNCTION scalius_compat."products_publish_to_channels_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "product_channel_publications" ("product_id", "channel_id") SELECT NEW."id", "sales_channels"."id" FROM "sales_channels" WHERE "sales_channels"."id" IS NOT NULL ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "products_publish_to_channels"
AFTER INSERT ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_publish_to_channels_fn"();
--> statement-breakpoint
-- An order's sales channel never changes, and a channel with orders is
-- never deleted (the column's default could not carry a foreign key).
CREATE OR REPLACE FUNCTION scalius_compat."orders_sales_channel_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."sales_channel_id" IS DISTINCT FROM OLD."sales_channel_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order sales channel is immutable';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "orders_sales_channel_immutable"
BEFORE UPDATE OF "sales_channel_id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."orders_sales_channel_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."sales_channels_has_orders_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "orders" WHERE "orders"."sales_channel_id" = OLD."id" AND "orders"."sales_channel_id" <> 'sc_online_store')), false) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SALES_CHANNEL_HAS_ORDERS';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "sales_channels_has_orders"
BEFORE DELETE ON "sales_channels"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."sales_channels_has_orders_fn"();
--> statement-breakpoint
-- A checkout validated before a product left a channel, or a channel was
-- switched off, reviews again instead of committing.
CREATE OR REPLACE FUNCTION scalius_compat."product_channel_publications_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."unpublished_at" IS NULL AND (NEW."unpublished_at" IS NOT NULL OR NEW."channel_id" IS DISTINCT FROM OLD."channel_id" OR NEW."product_id" IS DISTINCT FROM OLD."product_id")), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "product_channel_publications_checkout_authority_update"
AFTER UPDATE OF "unpublished_at", "channel_id", "product_id" ON "product_channel_publications"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_channel_publications_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_channel_publications_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."unpublished_at" IS NULL), false) THEN
    RETURN OLD;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "product_channel_publications_checkout_authority_delete"
AFTER DELETE ON "product_channel_publications"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_channel_publications_checkout_authority_delete_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."sales_channels_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" IS DISTINCT FROM OLD."status"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "sales_channels_checkout_authority_update"
AFTER UPDATE OF "status" ON "sales_channels"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."sales_channels_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_published_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', NEW."product_id", jsonb_build_object('productId', NEW."product_id", 'channelId', NEW."channel_id", 'state', 'published')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_published"
AFTER INSERT ON "product_channel_publications"
FOR EACH ROW
WHEN (NEW."unpublished_at" IS NULL)
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_published_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_republished_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', NEW."product_id", jsonb_build_object('productId', NEW."product_id", 'channelId', NEW."channel_id", 'state', 'published')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_republished"
AFTER UPDATE ON "product_channel_publications"
FOR EACH ROW
WHEN ((OLD."unpublished_at" IS NOT NULL AND NEW."unpublished_at" IS NULL))
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_republished_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_unpublished_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', NEW."product_id", jsonb_build_object('productId', NEW."product_id", 'channelId', NEW."channel_id", 'state', 'unpublished')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_unpublished"
AFTER UPDATE ON "product_channel_publications"
FOR EACH ROW
WHEN ((OLD."unpublished_at" IS NULL AND NEW."unpublished_at" IS NOT NULL))
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_unpublished_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_product_channel_publications_removed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'product.publication_changed', 'product', OLD."product_id", jsonb_build_object('productId', OLD."product_id", 'channelId', OLD."channel_id", 'state', 'unpublished')::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_product_channel_publications_removed"
AFTER DELETE ON "product_channel_publications"
FOR EACH ROW
WHEN (OLD."unpublished_at" IS NULL)
EXECUTE FUNCTION scalius_compat."evt_product_channel_publications_removed_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_products_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."id", 't:products']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_products_upd"
AFTER UPDATE ON "products"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."price_minor" IS DISTINCT FROM NEW."price_minor" OR OLD."category_id" IS DISTINCT FROM NEW."category_id" OR OLD."slug" IS DISTINCT FROM NEW."slug" OR OLD."meta_title" IS DISTINCT FROM NEW."meta_title" OR OLD."meta_description" IS DISTINCT FROM NEW."meta_description" OR OLD."canonical_path" IS DISTINCT FROM NEW."canonical_path" OR OLD."no_index" IS DISTINCT FROM NEW."no_index" OR OLD."exclude_from_sitemap" IS DISTINCT FROM NEW."exclude_from_sitemap" OR OLD."product_condition" IS DISTINCT FROM NEW."product_condition" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at" OR OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."discount_bps" IS DISTINCT FROM NEW."discount_bps" OR OLD."discount_type" IS DISTINCT FROM NEW."discount_type" OR OLD."discount_amount_minor" IS DISTINCT FROM NEW."discount_amount_minor" OR OLD."free_delivery" IS DISTINCT FROM NEW."free_delivery" OR OLD."tax_class_id" IS DISTINCT FROM NEW."tax_class_id" OR OLD."is_gift_card" IS DISTINCT FROM NEW."is_gift_card" OR OLD."customization_schema" IS DISTINCT FROM NEW."customization_schema" OR OLD."brand_id" IS DISTINCT FROM NEW."brand_id" OR OLD."page_template" IS DISTINCT FROM NEW."page_template" OR OLD."emi_eligible" IS DISTINCT FROM NEW."emi_eligible" OR OLD."warranty_policy_id" IS DISTINCT FROM NEW."warranty_policy_id"))
EXECUTE FUNCTION scalius_compat."cdep_products_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_products_price_order_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:products']::text[]) AS key_list(value) UNION SELECT facet_list.value || ':' || scope_rows.scope FROM (SELECT scope_list.value AS scope FROM "product_buyer_state" AS scope_state, unnest(ARRAY['all', 'brand:' || scope_state."brand_id", 'cat:' || scope_state."category_id"]::text[]) AS scope_list(value) WHERE scope_state."product_id" = NEW."id" AND scope_state."is_public" = 1 UNION ALL SELECT 'cat:' || scope_closure."ancestor_id" FROM "product_buyer_state" AS scope_state JOIN "category_closure" AS scope_closure ON scope_closure."descendant_id" = scope_state."category_id" WHERE scope_state."product_id" = NEW."id" AND scope_state."is_public" = 1) AS scope_rows, unnest(ARRAY['lo:price']::text[]) AS facet_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_products_price_order"
AFTER UPDATE ON "products"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."discount_type" IS DISTINCT FROM NEW."discount_type" OR OLD."discount_amount_minor" IS DISTINCT FROM NEW."discount_amount_minor" OR OLD."discount_bps" IS DISTINCT FROM NEW."discount_bps"))
EXECUTE FUNCTION scalius_compat."cdep_products_price_order_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_products_price_order_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['t:products']::text[]) AS key_list(value) UNION SELECT facet_list.value || ':' || scope_rows.scope FROM (SELECT scope_list.value AS scope FROM "product_buyer_state" AS scope_state, unnest(ARRAY['all', 'brand:' || scope_state."brand_id", 'cat:' || scope_state."category_id"]::text[]) AS scope_list(value) WHERE scope_state."product_id" = OLD."id" AND scope_state."is_public" = 1 UNION ALL SELECT 'cat:' || scope_closure."ancestor_id" FROM "product_buyer_state" AS scope_state JOIN "category_closure" AS scope_closure ON scope_closure."descendant_id" = scope_state."category_id" WHERE scope_state."product_id" = OLD."id" AND scope_state."is_public" = 1) AS scope_rows, unnest(ARRAY['lo:price']::text[]) AS facet_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_products_price_order_old"
AFTER UPDATE ON "products"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."discount_type" IS DISTINCT FROM NEW."discount_type" OR OLD."discount_amount_minor" IS DISTINCT FROM NEW."discount_amount_minor" OR OLD."discount_bps" IS DISTINCT FROM NEW."discount_bps") AND (OLD."id" IS DISTINCT FROM NEW."id"))
EXECUTE FUNCTION scalius_compat."cdep_products_price_order_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_products_seo_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:seo', 't:products']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_products_seo"
AFTER UPDATE ON "products"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."no_index" IS DISTINCT FROM NEW."no_index" OR OLD."exclude_from_sitemap" IS DISTINCT FROM NEW."exclude_from_sitemap"))
EXECUTE FUNCTION scalius_compat."cdep_products_seo_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_variants_chstock_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM sales_channels AS partial_channel, inventory_locations AS partial_location WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS partial_link WHERE partial_link.channel_id = partial_channel.id AND partial_link.location_id = partial_location.id))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 't:product_variants']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_variants_chstock"
AFTER UPDATE ON "product_variants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."stock" IS DISTINCT FROM NEW."stock" OR OLD."reserved_stock" IS DISTINCT FROM NEW."reserved_stock"))
EXECUTE FUNCTION scalius_compat."cdep_product_variants_chstock_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_variants_chstock_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM sales_channels AS partial_channel, inventory_locations AS partial_location WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS partial_link WHERE partial_link.channel_id = partial_channel.id AND partial_link.location_id = partial_location.id))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 't:product_variants']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_variants_chstock_old"
AFTER UPDATE ON "product_variants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."stock" IS DISTINCT FROM NEW."stock" OR OLD."reserved_stock" IS DISTINCT FROM NEW."reserved_stock") AND (OLD."product_id" IS DISTINCT FROM NEW."product_id"))
EXECUTE FUNCTION scalius_compat."cdep_product_variants_chstock_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_inventory_levels_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM sales_channels AS unlinked_channel WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS unlinked_link WHERE unlinked_link.channel_id = unlinked_channel.id AND unlinked_link.location_id = NEW.location_id))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."variant_id"), 't:inventory_levels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_inventory_levels_ins"
AFTER INSERT ON "inventory_levels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_inventory_levels_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_inventory_levels_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM sales_channels AS unlinked_channel WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS unlinked_link WHERE unlinked_link.channel_id = unlinked_channel.id AND unlinked_link.location_id = OLD.location_id))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."variant_id"), 't:inventory_levels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_inventory_levels_del"
AFTER DELETE ON "inventory_levels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_inventory_levels_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_inventory_levels_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM sales_channels AS unlinked_channel WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS unlinked_link WHERE unlinked_link.channel_id = unlinked_channel.id AND unlinked_link.location_id = NEW.location_id))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = NEW."variant_id"), 't:inventory_levels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_inventory_levels_upd"
AFTER UPDATE ON "inventory_levels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."variant_id" IS DISTINCT FROM NEW."variant_id" OR OLD."location_id" IS DISTINCT FROM NEW."location_id" OR OLD."on_hand" IS DISTINCT FROM NEW."on_hand"))
EXECUTE FUNCTION scalius_compat."cdep_inventory_levels_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_inventory_levels_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM sales_channels AS unlinked_channel WHERE NOT EXISTS (SELECT 1 FROM sales_channel_locations AS unlinked_link WHERE unlinked_link.channel_id = unlinked_channel.id AND unlinked_link.location_id = OLD.location_id))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || (SELECT "product_id" FROM "product_variants" WHERE "id" = OLD."variant_id"), 't:inventory_levels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_inventory_levels_upd_old"
AFTER UPDATE ON "inventory_levels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."variant_id" IS DISTINCT FROM NEW."variant_id" OR OLD."location_id" IS DISTINCT FROM NEW."location_id"))
EXECUTE FUNCTION scalius_compat."cdep_inventory_levels_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_sales_channels_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:seo', 't:sales_channels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_sales_channels_ins"
AFTER INSERT ON "sales_channels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_sales_channels_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_sales_channels_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:seo', 't:sales_channels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_sales_channels_del"
AFTER DELETE ON "sales_channels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_sales_channels_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_sales_channels_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:seo', 't:sales_channels']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_sales_channels_upd"
AFTER UPDATE ON "sales_channels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."plugin_id" IS DISTINCT FROM NEW."plugin_id" OR OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."cdep_sales_channels_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 'lm:seo', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_ins"
AFTER INSERT ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 'lm:seo', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_del"
AFTER DELETE ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || NEW."product_id", 'lm:seo', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_upd"
AFTER UPDATE ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id" OR OLD."channel_id" IS DISTINCT FROM NEW."channel_id" OR OLD."unpublished_at" IS DISTINCT FROM NEW."unpublished_at"))
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['p:' || OLD."product_id", 'lm:seo', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_upd_old"
AFTER UPDATE ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id"))
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_store_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:all', 'srch', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_store_ins"
AFTER INSERT ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."channel_id" = 'sc_online_store')
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_store_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_store_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:all', 'srch', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_store_del"
AFTER DELETE ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."channel_id" = 'sc_online_store')
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_store_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_store_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:all', 'srch', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_store_upd"
AFTER UPDATE ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."product_id" IS DISTINCT FROM NEW."product_id" OR OLD."channel_id" IS DISTINCT FROM NEW."channel_id" OR OLD."unpublished_at" IS DISTINCT FROM NEW."unpublished_at") AND NEW."channel_id" = 'sc_online_store')
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_store_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_product_channel_publications_store_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['lm:all', 'srch', 't:product_channel_publications']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_product_channel_publications_store_upd_old"
AFTER UPDATE ON "product_channel_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."channel_id" IS DISTINCT FROM NEW."channel_id") AND OLD."channel_id" = 'sc_online_store')
EXECUTE FUNCTION scalius_compat."cdep_product_channel_publications_store_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_sales_channel_locations_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['store', 't:sales_channel_locations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_sales_channel_locations_ins"
AFTER INSERT ON "sales_channel_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_sales_channel_locations_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_sales_channel_locations_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['store', 't:sales_channel_locations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_sales_channel_locations_del"
AFTER DELETE ON "sales_channel_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_sales_channel_locations_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_sales_channel_locations_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['store', 't:sales_channel_locations']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_sales_channel_locations_upd"
AFTER UPDATE ON "sales_channel_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."channel_id" IS DISTINCT FROM NEW."channel_id" OR OLD."location_id" IS DISTINCT FROM NEW."location_id"))
EXECUTE FUNCTION scalius_compat."cdep_sales_channel_locations_upd_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (122, '0122_sales_channels', '7a6b5cac792843fd099faa6d18fe59aa54ce4ff5defe29d2e34a72218e15e69d');
