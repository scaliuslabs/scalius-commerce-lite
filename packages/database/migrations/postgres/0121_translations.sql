-- Markets step 4b (docs/MARKETS-DESIGN.md D9, "Step 4b implemented"): the
-- store's languages, translations and localized URL handles.
--
-- store_languages is the one list of the store's languages (Shopify's
-- Settings → Languages). It unifies the two lists the store had: the
-- languages of the market presences (published) and of the checkout copy
-- (unpublished unless a presence uses it). The default language is the backup
-- market's root presence locale; it takes the language of the checkout
-- copy buyers read today (the active copy, else the fallback one), so the
-- root keeps its bytes. From
-- now on a presence names a store language (STORE_LANGUAGE_REQUIRED), the
-- default language stays published (STORE_LANGUAGE_DEFAULT_REQUIRED), a
-- language a presence uses cannot be removed (STORE_LANGUAGE_IN_USE) and a
-- language's code never changes (STORE_LANGUAGE_IMMUTABLE).
--
-- translations holds one row per resource, locale and market (NULL: every
-- market) with the translated fields (JSON) and the digest of the source
-- text each was made from: a source edit shows the field Outdated.
-- localized_slugs holds one URL handle per resource and locale, unique per
-- resource type and locale, and never another resource's source handle of
-- the same type (LOCALIZED_SLUG_TAKEN, checked from both sides). A
-- resource's translations and handles go with it when it is deleted; a
-- language's and a market's go with them (foreign keys).
--
-- The cache dependency triggers are generated from
-- packages/shared/src/cache-deps.ts: `tr:<type>:<id>` per resource (a
-- product's SKUs, options and values advance the product's),
-- `tr:slugs:<type>:<locale>` per handle space and `tr:locales` for the
-- presences' locales and the published languages.
CREATE TABLE "store_languages" (
	"locale" text PRIMARY KEY NOT NULL,
	"published" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "store_languages_locale_shape" CHECK(length("store_languages"."locale") = 2 AND "store_languages"."locale" !~ '[^a-z]'),
	CONSTRAINT "store_languages_published_flag" CHECK("store_languages"."published" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"locale" text NOT NULL,
	"market_id" text,
	"fields" text NOT NULL,
	"source_digest" text DEFAULT '{}' NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("locale") REFERENCES "store_languages"("locale") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "translations_id_shape" CHECK(substr("translations"."id", 1, 3) = 'tr_' AND length("translations"."id") BETWEEN 6 AND 40),
	CONSTRAINT "translations_resource_type_check" CHECK("translations"."resource_type" IN ('product', 'product_variant', 'product_option', 'product_option_value', 'collection', 'category', 'brand', 'page', 'menu', 'shipping_method', 'payment_method')),
	CONSTRAINT "translations_resource_id_length" CHECK(length("translations"."resource_id") BETWEEN 1 AND 64),
	CONSTRAINT "translations_locale_shape" CHECK(length("translations"."locale") = 2 AND "translations"."locale" !~ '[^a-z]'),
	CONSTRAINT "translations_fields_object" CHECK(json_valid("translations"."fields") AND json_type("translations"."fields") = 'object'),
	CONSTRAINT "translations_source_digest_object" CHECK(json_valid("translations"."source_digest") AND json_type("translations"."source_digest") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "translations_identity_unique" ON "translations" ("resource_type","resource_id","locale",coalesce("market_id", ''));
--> statement-breakpoint
CREATE INDEX "translations_locale_idx" ON "translations" ("locale");
--> statement-breakpoint
CREATE INDEX "translations_market_idx" ON "translations" ("market_id");
--> statement-breakpoint
CREATE TABLE "localized_slugs" (
	"resource_type" text NOT NULL,
	"locale" text NOT NULL,
	"slug" text NOT NULL,
	"resource_id" text NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("resource_type", "locale", "slug"),
	FOREIGN KEY ("locale") REFERENCES "store_languages"("locale") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "localized_slugs_resource_type_check" CHECK("localized_slugs"."resource_type" IN ('product', 'category', 'brand', 'page')),
	CONSTRAINT "localized_slugs_resource_id_length" CHECK(length("localized_slugs"."resource_id") BETWEEN 1 AND 64),
	CONSTRAINT "localized_slugs_locale_shape" CHECK(length("localized_slugs"."locale") = 2 AND "localized_slugs"."locale" !~ '[^a-z]'),
	CONSTRAINT "localized_slugs_slug_shape" CHECK(length("localized_slugs"."slug") BETWEEN 1 AND 100 AND "localized_slugs"."slug" !~ '[^a-z0-9-]' AND substr("localized_slugs"."slug", 1, 1) <> '-' AND substr("localized_slugs"."slug", -1, 1) <> '-' AND position('--' in "localized_slugs"."slug") = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "localized_slugs_resource_unique" ON "localized_slugs" ("resource_type","resource_id","locale");
--> statement-breakpoint
CREATE INDEX "localized_slugs_slug_idx" ON "localized_slugs" ("resource_type","slug");
--> statement-breakpoint
CREATE INDEX "localized_slugs_locale_idx" ON "localized_slugs" ("locale");
--> statement-breakpoint
-- The store's languages: every presence's language is published (a draft
-- market's presence is still not served), and the default language takes
-- the language of the checkout copy buyers read at the root today (the
-- active copy, else the fallback one).
INSERT INTO "store_languages" ("locale", "published")
SELECT DISTINCT "locale", 1 FROM "market_presences" WHERE "locale" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "store_languages" ("locale", "published")
SELECT lower(substr("code", 1, 2)), 1 FROM "checkout_languages"
WHERE ("is_active" = 1 OR "is_default" = 1) AND "deleted_at" IS NULL AND length("code") >= 2 AND lower(substr("code", 1, 2)) !~ '[^a-z]'
ORDER BY "is_active" DESC, "is_default" DESC, "id" LIMIT 1
ON CONFLICT ("locale") DO UPDATE SET "published" = 1;
--> statement-breakpoint
UPDATE "market_presences" SET "locale" = (
  SELECT lower(substr("code", 1, 2)) FROM "checkout_languages"
  WHERE ("is_active" = 1 OR "is_default" = 1) AND "deleted_at" IS NULL AND length("code") >= 2 AND lower(substr("code", 1, 2)) !~ '[^a-z]'
  ORDER BY "is_active" DESC, "is_default" DESC, "id" LIMIT 1
)
WHERE "kind" = 'subfolder' AND "value" = '' AND EXISTS (
  SELECT 1 FROM "checkout_languages" WHERE ("is_active" = 1 OR "is_default" = 1) AND "deleted_at" IS NULL AND length("code") >= 2 AND lower(substr("code", 1, 2)) !~ '[^a-z]'
);
--> statement-breakpoint
-- The other checkout copies' languages join the list unpublished.
INSERT INTO "store_languages" ("locale", "published")
SELECT DISTINCT lower(substr("code", 1, 2)), 0 FROM "checkout_languages"
WHERE "deleted_at" IS NULL AND length("code") >= 2 AND lower(substr("code", 1, 2)) !~ '[^a-z]'
ON CONFLICT ("locale") DO NOTHING;
--> statement-breakpoint
-- A presence is in a store language, and the root presence's (the default
-- language) is published.
CREATE OR REPLACE FUNCTION scalius_compat."market_presences_store_language_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (SELECT 1 FROM "store_languages" WHERE "store_languages"."locale" = NEW."locale" AND ("store_languages"."published" = 1 OR NEW."value" <> '' OR NEW."kind" <> 'subfolder'))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STORE_LANGUAGE_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "market_presences_store_language_insert"
BEFORE INSERT ON "market_presences"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."market_presences_store_language_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."market_presences_store_language_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NOT EXISTS (SELECT 1 FROM "store_languages" WHERE "store_languages"."locale" = NEW."locale" AND ("store_languages"."published" = 1 OR NEW."value" <> '' OR NEW."kind" <> 'subfolder'))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STORE_LANGUAGE_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "market_presences_store_language_update"
BEFORE UPDATE OF "locale", "value", "kind" ON "market_presences"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."market_presences_store_language_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."store_languages_in_use_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "market_presences" WHERE "market_presences"."locale" = OLD."locale")), false) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STORE_LANGUAGE_IN_USE';
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "store_languages_in_use"
BEFORE DELETE ON "store_languages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."store_languages_in_use_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."store_languages_default_published_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."published" = 0 AND EXISTS (SELECT 1 FROM "market_presences" WHERE "market_presences"."kind" = 'subfolder' AND "market_presences"."value" = '' AND "market_presences"."locale" = OLD."locale")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STORE_LANGUAGE_DEFAULT_REQUIRED';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "store_languages_default_published"
BEFORE UPDATE OF "published" ON "store_languages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."store_languages_default_published_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."store_languages_locale_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."locale" IS DISTINCT FROM OLD."locale"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'STORE_LANGUAGE_IMMUTABLE';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "store_languages_locale_immutable"
BEFORE UPDATE OF "locale" ON "store_languages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."store_languages_locale_immutable_fn"();
--> statement-breakpoint
-- A localized handle is never another resource's source handle of the same
-- type, checked from both sides.
CREATE OR REPLACE FUNCTION scalius_compat."localized_slugs_source_taken_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."resource_type" = 'product' AND EXISTS (SELECT 1 FROM "products" WHERE "products"."slug" = NEW."slug" AND "products"."id" <> NEW."resource_id")) OR (NEW."resource_type" = 'category' AND EXISTS (SELECT 1 FROM "categories" WHERE "categories"."slug" = NEW."slug" AND "categories"."id" <> NEW."resource_id")) OR (NEW."resource_type" = 'brand' AND EXISTS (SELECT 1 FROM "brands" WHERE "brands"."slug" = NEW."slug" AND "brands"."id" <> NEW."resource_id")) OR (NEW."resource_type" = 'page' AND EXISTS (SELECT 1 FROM "pages" WHERE "pages"."slug" = NEW."slug" AND "pages"."id" <> NEW."resource_id"))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "localized_slugs_source_taken_insert"
BEFORE INSERT ON "localized_slugs"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."localized_slugs_source_taken_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."localized_slugs_source_taken_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."resource_type" = 'product' AND EXISTS (SELECT 1 FROM "products" WHERE "products"."slug" = NEW."slug" AND "products"."id" <> NEW."resource_id")) OR (NEW."resource_type" = 'category' AND EXISTS (SELECT 1 FROM "categories" WHERE "categories"."slug" = NEW."slug" AND "categories"."id" <> NEW."resource_id")) OR (NEW."resource_type" = 'brand' AND EXISTS (SELECT 1 FROM "brands" WHERE "brands"."slug" = NEW."slug" AND "brands"."id" <> NEW."resource_id")) OR (NEW."resource_type" = 'page' AND EXISTS (SELECT 1 FROM "pages" WHERE "pages"."slug" = NEW."slug" AND "pages"."id" <> NEW."resource_id"))), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "localized_slugs_source_taken_update"
BEFORE UPDATE OF "resource_type", "resource_id", "slug" ON "localized_slugs"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."localized_slugs_source_taken_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."products_localized_slug_taken_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'product' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "products_localized_slug_taken_insert"
BEFORE INSERT ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_localized_slug_taken_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."products_localized_slug_taken_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'product' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "products_localized_slug_taken_update"
BEFORE UPDATE OF "slug" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_localized_slug_taken_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_localized_slug_taken_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'category' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "categories_localized_slug_taken_insert"
BEFORE INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_localized_slug_taken_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_localized_slug_taken_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'category' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "categories_localized_slug_taken_update"
BEFORE UPDATE OF "slug" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_localized_slug_taken_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."brands_localized_slug_taken_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'brand' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "brands_localized_slug_taken_insert"
BEFORE INSERT ON "brands"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."brands_localized_slug_taken_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."brands_localized_slug_taken_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'brand' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "brands_localized_slug_taken_update"
BEFORE UPDATE OF "slug" ON "brands"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."brands_localized_slug_taken_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."pages_localized_slug_taken_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'page' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "pages_localized_slug_taken_insert"
BEFORE INSERT ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."pages_localized_slug_taken_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."pages_localized_slug_taken_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM "localized_slugs" WHERE "localized_slugs"."resource_type" = 'page' AND "localized_slugs"."slug" = NEW."slug" AND "localized_slugs"."resource_id" <> NEW."id")), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LOCALIZED_SLUG_TAKEN';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "pages_localized_slug_taken_update"
BEFORE UPDATE OF "slug" ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."pages_localized_slug_taken_update_fn"();
--> statement-breakpoint
-- A deleted resource's translations and localized handles go with it.
CREATE OR REPLACE FUNCTION scalius_compat."products_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'product' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "products_translations_cleanup"
AFTER DELETE ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."products_localized_slugs_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "localized_slugs" WHERE "resource_type" = 'product' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "products_localized_slugs_cleanup"
AFTER DELETE ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_localized_slugs_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_variants_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'product_variant' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "product_variants_translations_cleanup"
AFTER DELETE ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_variants_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_option_definitions_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'product_option' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "product_option_definitions_translations_cleanup"
AFTER DELETE ON "product_option_definitions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_option_definitions_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_option_values_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'product_option_value' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "product_option_values_translations_cleanup"
AFTER DELETE ON "product_option_values"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_option_values_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."collections_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'collection' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "collections_translations_cleanup"
AFTER DELETE ON "collections"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."collections_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'category' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "categories_translations_cleanup"
AFTER DELETE ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_localized_slugs_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "localized_slugs" WHERE "resource_type" = 'category' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "categories_localized_slugs_cleanup"
AFTER DELETE ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_localized_slugs_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."brands_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'brand' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "brands_translations_cleanup"
AFTER DELETE ON "brands"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."brands_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."brands_localized_slugs_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "localized_slugs" WHERE "resource_type" = 'brand' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "brands_localized_slugs_cleanup"
AFTER DELETE ON "brands"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."brands_localized_slugs_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."pages_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'page' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "pages_translations_cleanup"
AFTER DELETE ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."pages_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."pages_localized_slugs_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "localized_slugs" WHERE "resource_type" = 'page' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "pages_localized_slugs_cleanup"
AFTER DELETE ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."pages_localized_slugs_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."navigation_menus_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'menu' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "navigation_menus_translations_cleanup"
AFTER DELETE ON "navigation_menus"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."navigation_menus_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."shipping_methods_translations_cleanup_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "translations" WHERE "resource_type" = 'shipping_method' AND "resource_id" = OLD."id";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "shipping_methods_translations_cleanup"
AFTER DELETE ON "shipping_methods"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."shipping_methods_translations_cleanup_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_market_presences_locales_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:locales', 't:market_presences']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_market_presences_locales_ins"
AFTER INSERT ON "market_presences"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_market_presences_locales_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_market_presences_locales_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:locales', 't:market_presences']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_market_presences_locales_del"
AFTER DELETE ON "market_presences"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_market_presences_locales_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_market_presences_locales_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:locales', 't:market_presences']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_market_presences_locales_upd"
AFTER UPDATE ON "market_presences"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."market_id" IS DISTINCT FROM NEW."market_id" OR OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."value" IS DISTINCT FROM NEW."value" OR OLD."locale" IS DISTINCT FROM NEW."locale"))
EXECUTE FUNCTION scalius_compat."cdep_market_presences_locales_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_store_languages_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:*', 'tr:locales', 't:store_languages']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_store_languages_ins"
AFTER INSERT ON "store_languages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_store_languages_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_store_languages_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:*', 'tr:locales', 't:store_languages']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_store_languages_del"
AFTER DELETE ON "store_languages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_store_languages_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_store_languages_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:*', 'tr:locales', 't:store_languages']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_store_languages_upd"
AFTER UPDATE ON "store_languages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."published" IS DISTINCT FROM NEW."published"))
EXECUTE FUNCTION scalius_compat."cdep_store_languages_upd_fn"();
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
CREATE OR REPLACE FUNCTION scalius_compat."cdep_localized_slugs_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || NEW."resource_type" || ':' || NEW."resource_id", 'tr:handles:' || NEW."resource_type" || ':' || NEW."resource_id", 'tr:slugs:' || NEW."resource_type" || ':' || NEW."locale", 'tr:slugs:' || NEW."resource_type", 't:localized_slugs']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_localized_slugs_ins"
AFTER INSERT ON "localized_slugs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_localized_slugs_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_localized_slugs_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || OLD."resource_type" || ':' || OLD."resource_id", 'tr:handles:' || OLD."resource_type" || ':' || OLD."resource_id", 'tr:slugs:' || OLD."resource_type" || ':' || OLD."locale", 'tr:slugs:' || OLD."resource_type", 't:localized_slugs']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_localized_slugs_del"
AFTER DELETE ON "localized_slugs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_localized_slugs_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_localized_slugs_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || NEW."resource_type" || ':' || NEW."resource_id", 'tr:handles:' || NEW."resource_type" || ':' || NEW."resource_id", 'tr:slugs:' || NEW."resource_type" || ':' || NEW."locale", 'tr:slugs:' || NEW."resource_type", 't:localized_slugs']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_localized_slugs_upd"
AFTER UPDATE ON "localized_slugs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."slug" IS DISTINCT FROM NEW."slug" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id"))
EXECUTE FUNCTION scalius_compat."cdep_localized_slugs_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_localized_slugs_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['tr:' || OLD."resource_type" || ':' || OLD."resource_id", 'tr:handles:' || OLD."resource_type" || ':' || OLD."resource_id", 'tr:slugs:' || OLD."resource_type" || ':' || OLD."locale", 'tr:slugs:' || OLD."resource_type", 't:localized_slugs']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_localized_slugs_upd_old"
AFTER UPDATE ON "localized_slugs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."resource_type" IS DISTINCT FROM NEW."resource_type" OR OLD."resource_id" IS DISTINCT FROM NEW."resource_id" OR OLD."locale" IS DISTINCT FROM NEW."locale"))
EXECUTE FUNCTION scalius_compat."cdep_localized_slugs_upd_old_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (121, '0121_translations', 'bd4bc6821c6f8787a33e888a51e71ac2a562ea3dc7c4ec57b9192ae00d9ad8b4');
