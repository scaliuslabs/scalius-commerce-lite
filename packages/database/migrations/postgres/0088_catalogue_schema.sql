-- Catalogue schema for the storefront templates and catalogue scale (templates
-- Phase 1-schema + catalogue-scale designs A, B, D, E). Expand-only: every
-- new column has a safe default, the deployed API never reads the new tables,
-- and the only drop is the never-read `page_templates`. `product_rich_content`
-- stays until its readers move to `product_content_blocks` (slice 1c); until
-- then triggers mirror every write into the new table, so no data is lost in
-- the migrate -> deploy window or before 1c ships.
--
-- Category tree: the application writes only `categories.parent_id`. Triggers
-- keep `depth`, the stored id `path` ('/root/child/') and the closure table
-- exact, refuse cycles, trashed parents and trees deeper than four levels
-- (depth 0-3), and every body is one statement with its guard in WHEN.
ALTER TABLE "categories" ADD COLUMN "parent_id" text REFERENCES "categories"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "depth" bigint DEFAULT 0 NOT NULL CONSTRAINT "categories_depth_range" CHECK ("depth" BETWEEN 0 AND 3);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "path" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "listing_template" text CONSTRAINT "categories_listing_template_shape" CHECK ("listing_template" IS NULL OR (length("listing_template") BETWEEN 1 AND 40 AND "listing_template" = lower("listing_template") AND "listing_template" !~ '[^A-Za-z0-9_-]' AND position('_' in "listing_template") = 0));
--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" ("parent_id","deleted_at");
--> statement-breakpoint
CREATE TABLE "category_closure" (
	"ancestor_id" text NOT NULL,
	"descendant_id" text NOT NULL,
	"depth" bigint NOT NULL,
	PRIMARY KEY("ancestor_id", "descendant_id"),
	FOREIGN KEY ("ancestor_id") REFERENCES "categories"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("descendant_id") REFERENCES "categories"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "category_closure_depth_range" CHECK("category_closure"."depth" BETWEEN 0 AND 3),
	CONSTRAINT "category_closure_self_shape" CHECK(("category_closure"."depth" = 0) = ("category_closure"."ancestor_id" = "category_closure"."descendant_id"))
);
--> statement-breakpoint
CREATE INDEX "category_closure_descendant_idx" ON "category_closure" ("descendant_id","depth");
--> statement-breakpoint
UPDATE "categories" SET "path" = '/' || "id" || '/';
--> statement-breakpoint
INSERT INTO "category_closure" ("ancestor_id", "descendant_id", "depth") SELECT "id", "id", 0 FROM "categories";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_id_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."id" IS DISTINCT FROM OLD."id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category id is immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_id_immutable"
BEFORE UPDATE OF "id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_id_immutable_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_parent_insert_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS NOT NULL
  AND (
    NEW."parent_id" = NEW."id"
    OR NOT EXISTS (
      SELECT 1 FROM "categories" AS p
      WHERE p."id" = NEW."parent_id" AND p."deleted_at" IS NULL
    )
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category parent must be another live category';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_parent_insert_guard"
BEFORE INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_parent_insert_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_depth_insert_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "categories" AS p
    WHERE p."id" = NEW."parent_id" AND p."deleted_at" IS NULL AND p."depth" >= 3
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category tree is limited to four levels';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_depth_insert_guard"
BEFORE INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_depth_insert_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_insert_shape_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "categories"
  SET "depth" = coalesce((SELECT p."depth" + 1 FROM "categories" AS p WHERE p."id" = NEW."parent_id"), 0),
      "path" = coalesce((SELECT p."path" FROM "categories" AS p WHERE p."id" = NEW."parent_id"), '/') || NEW."id" || '/'
  WHERE "id" = NEW."id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_insert_shape"
AFTER INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_insert_shape_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_insert_closure_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "category_closure" ("ancestor_id", "descendant_id", "depth")
  SELECT NEW."id", NEW."id", 0
  UNION ALL
  SELECT c."ancestor_id", NEW."id", c."depth" + 1
  FROM "category_closure" AS c
  WHERE c."descendant_id" = NEW."parent_id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_insert_closure"
AFTER INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_insert_closure_fn"();
--> statement-breakpoint
-- A move may not put a category under itself or anything below it.
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_cycle_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
  AND NEW."parent_id" IS NOT NULL
  AND (
    NEW."parent_id" = NEW."id"
    OR EXISTS (
      SELECT 1 FROM "category_closure" AS c
      WHERE c."ancestor_id" = NEW."id" AND c."descendant_id" = NEW."parent_id"
    )
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category cannot move under itself or its descendants';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_cycle_guard"
BEFORE UPDATE OF "parent_id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_cycle_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_parent_update_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
  AND NEW."parent_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "categories" AS p
    WHERE p."id" = NEW."parent_id" AND p."deleted_at" IS NULL
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category parent must be another live category';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_parent_update_guard"
BEFORE UPDATE OF "parent_id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_parent_update_guard_fn"();
--> statement-breakpoint
-- The moved subtree's deepest node must stay within depth 3. Cycles and
-- trashed parents are left to their own guards, so each refusal has one reason.
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_depth_update_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
  AND NEW."parent_id" IS NOT NULL
  AND NEW."parent_id" <> NEW."id"
  AND NOT EXISTS (
    SELECT 1 FROM "category_closure" AS c
    WHERE c."ancestor_id" = NEW."id" AND c."descendant_id" = NEW."parent_id"
  )
  AND (
    SELECT p."depth" FROM "categories" AS p WHERE p."id" = NEW."parent_id" AND p."deleted_at" IS NULL
  ) + 1 + (
    SELECT max(c."depth") FROM "category_closure" AS c WHERE c."ancestor_id" = NEW."id"
  ) > 3), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category tree is limited to four levels';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_depth_update_guard"
BEFORE UPDATE OF "parent_id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_depth_update_guard_fn"();
--> statement-breakpoint
-- Moves: drop the links from the old ancestors into the moved subtree before
-- the row changes, link the new ancestors after it, and rewrite the subtree's
-- depth and path. Each step reads only closure rows inside the subtree (which
-- a move never changes), so the order of the three triggers does not matter.
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_move_detach_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS DISTINCT FROM OLD."parent_id"), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM "category_closure"
  WHERE "descendant_id" IN (
      SELECT s."descendant_id" FROM "category_closure" AS s WHERE s."ancestor_id" = OLD."id"
    )
    AND "ancestor_id" NOT IN (
      SELECT s."descendant_id" FROM "category_closure" AS s WHERE s."ancestor_id" = OLD."id"
    );
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_move_detach"
BEFORE UPDATE OF "parent_id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_move_detach_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_move_attach_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
  AND NEW."parent_id" IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "category_closure" ("ancestor_id", "descendant_id", "depth")
  SELECT a."ancestor_id", d."descendant_id", a."depth" + d."depth" + 1
  FROM "category_closure" AS a
  CROSS JOIN "category_closure" AS d
  WHERE a."descendant_id" = NEW."parent_id" AND d."ancestor_id" = NEW."id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_move_attach"
AFTER UPDATE OF "parent_id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_move_attach_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_move_reshape_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."parent_id" IS DISTINCT FROM OLD."parent_id"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "categories"
  SET "depth" = coalesce((SELECT p."depth" + 1 FROM "categories" AS p WHERE p."id" = NEW."parent_id"), 0)
        + (SELECT c."depth" FROM "category_closure" AS c WHERE c."ancestor_id" = NEW."id" AND c."descendant_id" = "categories"."id"),
      "path" = coalesce((SELECT p."path" FROM "categories" AS p WHERE p."id" = NEW."parent_id"), '/')
        || substr("categories"."path", length(OLD."path") - length(OLD."id"))
  WHERE "id" IN (SELECT c."descendant_id" FROM "category_closure" AS c WHERE c."ancestor_id" = NEW."id");
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_move_reshape"
AFTER UPDATE OF "parent_id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_move_reshape_fn"();
--> statement-breakpoint
-- Depth and path are trigger-written; a direct write must at least keep the
-- path ending in the category's own id with one segment per level.
CREATE OR REPLACE FUNCTION scalius_compat."categories_tree_shape_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."path" NOT LIKE '%/' || NEW."id" || '/'
  OR substr(NEW."path", 1, 1) <> '/'
  OR NEW."depth" <> length(NEW."path") - length(replace(NEW."path", '/', '')) - 2), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'category depth and path are maintained by the tree triggers';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "categories_tree_shape_guard"
BEFORE UPDATE OF "depth", "path" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_tree_shape_guard_fn"();
--> statement-breakpoint
-- Brands: a first-class entity with its own page, logo and SEO fields.
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"logo_media_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"canonical_path" text,
	"no_index" bigint DEFAULT 0 NOT NULL,
	"exclude_from_sitemap" bigint DEFAULT 0 NOT NULL,
	"listing_template" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"deleted_at" bigint,
	FOREIGN KEY ("logo_media_id") REFERENCES "media"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "brands_id_shape" CHECK(substr("brands"."id", 1, 4) = 'brd_' AND length("brands"."id") BETWEEN 10 AND 68 AND "brands"."id" !~ '[^A-Za-z0-9_-]'),
	CONSTRAINT "brands_name_valid" CHECK("brands"."name" = trim("brands"."name") AND length("brands"."name") BETWEEN 1 AND 120),
	CONSTRAINT "brands_slug_valid" CHECK(length("brands"."slug") BETWEEN 1 AND 100 AND "brands"."slug" = lower("brands"."slug") AND "brands"."slug" !~ '[^A-Za-z0-9_-]' AND position('_' in "brands"."slug") = 0),
	CONSTRAINT "brands_description_length" CHECK("brands"."description" IS NULL OR length("brands"."description") <= 20000),
	CONSTRAINT "brands_status_valid" CHECK("brands"."status" IN ('draft', 'published')),
	CONSTRAINT "brands_flags_valid" CHECK("brands"."no_index" IN (0, 1) AND "brands"."exclude_from_sitemap" IN (0, 1)),
	CONSTRAINT "brands_listing_template_shape" CHECK("brands"."listing_template" IS NULL OR (length("brands"."listing_template") BETWEEN 1 AND 40 AND "brands"."listing_template" = lower("brands"."listing_template") AND "brands"."listing_template" !~ '[^A-Za-z0-9_-]' AND position('_' in "brands"."listing_template") = 0)),
	CONSTRAINT "brands_revision_positive" CHECK("brands"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_unique" ON "brands" ("slug");
--> statement-breakpoint
CREATE INDEX "brands_public_idx" ON "brands" ("status","deleted_at","sort_order");
--> statement-breakpoint
CREATE INDEX "brands_logo_media_idx" ON "brands" ("logo_media_id") WHERE "brands"."logo_media_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand_id" text REFERENCES "brands"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- Brand pages list public products newest first (the category index's shape).
CREATE INDEX "products_public_brand_newest_idx" ON "products" ("brand_id","is_active","deleted_at","created_at" DESC);
--> statement-breakpoint
-- Template assignment (NULL = the theme's default) and EMI eligibility.
ALTER TABLE "products" ADD COLUMN "page_template" text CONSTRAINT "products_page_template_shape" CHECK ("page_template" IS NULL OR (length("page_template") BETWEEN 1 AND 40 AND "page_template" = lower("page_template") AND "page_template" !~ '[^A-Za-z0-9_-]' AND position('_' in "page_template") = 0));
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "emi_eligible" bigint DEFAULT 1 NOT NULL CONSTRAINT "products_emi_eligible_check" CHECK ("emi_eligible" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "listing_template" text CONSTRAINT "collections_listing_template_shape" CHECK ("listing_template" IS NULL OR (length("listing_template") BETWEEN 1 AND 40 AND "listing_template" = lower("listing_template") AND "listing_template" !~ '[^A-Za-z0-9_-]' AND position('_' in "listing_template") = 0));
--> statement-breakpoint
-- Typed spec attributes: groups, a value type, unit, order, the key-spec and
-- highlight flags, the facet widget, and normalised values for enums.
CREATE TABLE "attribute_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "attribute_groups_id_shape" CHECK(substr("attribute_groups"."id", 1, 4) = 'atg_' AND length("attribute_groups"."id") BETWEEN 10 AND 68 AND "attribute_groups"."id" !~ '[^A-Za-z0-9_-]'),
	CONSTRAINT "attribute_groups_name_valid" CHECK("attribute_groups"."name" = trim("attribute_groups"."name") AND length("attribute_groups"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_groups_live_name_unique" ON "attribute_groups" (lower("name")) WHERE "attribute_groups"."deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "group_id" text REFERENCES "attribute_groups"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "value_type" text DEFAULT 'text' NOT NULL CONSTRAINT "product_attributes_value_type_check" CHECK ("value_type" IN ('text', 'number', 'boolean', 'enum'));
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "unit" text CONSTRAINT "product_attributes_unit_check" CHECK ("unit" IS NULL OR ("unit" = trim("unit") AND length("unit") BETWEEN 1 AND 16));
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "sort_order" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "key_spec" bigint DEFAULT 0 NOT NULL CONSTRAINT "product_attributes_key_spec_check" CHECK ("key_spec" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "highlight" bigint DEFAULT 0 NOT NULL CONSTRAINT "product_attributes_highlight_check" CHECK ("highlight" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "product_attributes" ADD COLUMN "facet_display" text DEFAULT 'checkbox' NOT NULL CONSTRAINT "product_attributes_facet_display_check" CHECK ("facet_display" IN ('checkbox', 'range', 'swatch', 'search_list') AND ("facet_display" <> 'range' OR "value_type" = 'number') AND ("facet_display" <> 'swatch' OR "value_type" = 'enum'));
--> statement-breakpoint
CREATE INDEX "product_attributes_group_idx" ON "product_attributes" ("group_id","sort_order");
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_id" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"swatch_hex" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"deleted_at" bigint,
	FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "attribute_values_id_shape" CHECK(substr("attribute_values"."id", 1, 4) = 'atv_' AND length("attribute_values"."id") BETWEEN 10 AND 68 AND "attribute_values"."id" !~ '[^A-Za-z0-9_-]'),
	CONSTRAINT "attribute_values_value_valid" CHECK("attribute_values"."value" = trim("attribute_values"."value") AND length("attribute_values"."value") BETWEEN 1 AND 200),
	CONSTRAINT "attribute_values_normalized_value_valid" CHECK("attribute_values"."normalized_value" = lower(trim("attribute_values"."value"))),
	CONSTRAINT "attribute_values_swatch_hex_valid" CHECK("attribute_values"."swatch_hex" IS NULL OR (length("attribute_values"."swatch_hex") = 7 AND "attribute_values"."swatch_hex" ~ '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_live_value_unique" ON "attribute_values" ("attribute_id","normalized_value") WHERE "attribute_values"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "attribute_values_attribute_order_idx" ON "attribute_values" ("attribute_id","deleted_at","sort_order");
--> statement-breakpoint
-- A product's value keeps its display text in `value`; enums also name their
-- normalised value, numbers and booleans also carry `value_number`.
ALTER TABLE "product_attribute_values" ADD COLUMN "value_id" text REFERENCES "attribute_values"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD COLUMN "value_number" double precision;
--> statement-breakpoint
CREATE INDEX "product_attribute_values_value_id_idx" ON "product_attribute_values" ("value_id") WHERE "product_attribute_values"."value_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_attribute_values_type_insert_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."value_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "attribute_values" AS v
    WHERE v."id" = NEW."value_id" AND v."attribute_id" = NEW."attribute_id"
  ))
  OR EXISTS (
    SELECT 1 FROM "product_attributes" AS a
    WHERE a."id" = NEW."attribute_id"
      AND (
        (a."value_type" = 'enum' AND NEW."value_id" IS NULL)
        OR (a."value_type" <> 'enum' AND NEW."value_id" IS NOT NULL)
        OR (a."value_type" = 'number' AND NEW."value_number" IS NULL)
        OR (a."value_type" = 'boolean' AND (NEW."value_number" IS NULL OR NEW."value_number" NOT IN (0, 1)))
        OR (a."value_type" IN ('text', 'enum') AND NEW."value_number" IS NOT NULL)
      )
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attribute value does not match the attribute type';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_attribute_values_type_insert_guard"
BEFORE INSERT ON "product_attribute_values"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_attribute_values_type_insert_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_attribute_values_type_update_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((NEW."value_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "attribute_values" AS v
    WHERE v."id" = NEW."value_id" AND v."attribute_id" = NEW."attribute_id"
  ))
  OR EXISTS (
    SELECT 1 FROM "product_attributes" AS a
    WHERE a."id" = NEW."attribute_id"
      AND (
        (a."value_type" = 'enum' AND NEW."value_id" IS NULL)
        OR (a."value_type" <> 'enum' AND NEW."value_id" IS NOT NULL)
        OR (a."value_type" = 'number' AND NEW."value_number" IS NULL)
        OR (a."value_type" = 'boolean' AND (NEW."value_number" IS NULL OR NEW."value_number" NOT IN (0, 1)))
        OR (a."value_type" IN ('text', 'enum') AND NEW."value_number" IS NOT NULL)
      )
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attribute value does not match the attribute type';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_attribute_values_type_update_guard"
BEFORE UPDATE ON "product_attribute_values"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_attribute_values_type_update_guard_fn"();
--> statement-breakpoint
-- Which specs a category uses, in order; a category inherits its ancestors' sets.
CREATE TABLE "category_attribute_sets" (
	"category_id" text NOT NULL,
	"attribute_id" text NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	PRIMARY KEY("category_id", "attribute_id"),
	FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "category_attribute_sets_attribute_idx" ON "category_attribute_sets" ("attribute_id");
--> statement-breakpoint
-- Facet projection: one row per product attribute value (product level) and
-- one per SKU option-axis value (SKU level, so combined option filters match
-- one SKU); `owner_id` is the product or the SKU. Maintained with the product
-- aggregate's writes and rebuildable from its sources; counts join it to
-- `product_buyer_state` on indexed reads.
CREATE TABLE "product_facet_values" (
	"owner_id" text NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"facet_kind" text NOT NULL,
	"facet_key" text NOT NULL,
	"value_key" text NOT NULL,
	"value_label" text NOT NULL,
	"value_number" double precision,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	PRIMARY KEY("owner_id", "facet_key"),
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_facet_values_owner_shape" CHECK("product_facet_values"."owner_id" = coalesce("product_facet_values"."variant_id", "product_facet_values"."product_id")),
	CONSTRAINT "product_facet_values_kind_shape" CHECK(("product_facet_values"."facet_kind" = 'attribute' AND "product_facet_values"."variant_id" IS NULL) OR ("product_facet_values"."facet_kind" = 'option' AND "product_facet_values"."variant_id" IS NOT NULL AND substr("product_facet_values"."facet_key", 1, 7) = 'option.')),
	CONSTRAINT "product_facet_values_keys_valid" CHECK(length("product_facet_values"."facet_key") BETWEEN 1 AND 120 AND length("product_facet_values"."value_key") BETWEEN 1 AND 200 AND length("product_facet_values"."value_label") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "product_facet_values_product_idx" ON "product_facet_values" ("product_id","facet_key","value_key","variant_id");
--> statement-breakpoint
CREATE INDEX "product_facet_values_value_idx" ON "product_facet_values" ("facet_key","value_key","product_id");
--> statement-breakpoint
CREATE INDEX "product_facet_values_number_idx" ON "product_facet_values" ("facet_key","value_number","product_id") WHERE "product_facet_values"."value_number" IS NOT NULL;
--> statement-breakpoint
-- Buyer state: one row per product, the buyer-visible projection of its SKUs
-- (public eligibility, the card's SKU and price range, availability band).
-- Written in the same batch as every write that can change it; stock and
-- checkout stay authoritative and a rebuild recomputes it from them.
CREATE TABLE "product_buyer_state" (
	"product_id" text PRIMARY KEY NOT NULL,
	"is_public" bigint DEFAULT 0 NOT NULL,
	"category_id" text,
	"brand_id" text,
	"product_created_at" bigint NOT NULL,
	"sku_id" text,
	"from_minor" bigint,
	"to_minor" bigint,
	"base_minor" bigint,
	"discount_depth_bps" bigint DEFAULT 0 NOT NULL,
	"has_discount" bigint DEFAULT 0 NOT NULL,
	"available_for_sale" bigint DEFAULT 0 NOT NULL,
	"has_customer_options" bigint DEFAULT 0 NOT NULL,
	"availability_band" text DEFAULT 'out_of_stock' NOT NULL,
	"refreshed_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_buyer_state_flags_valid" CHECK("product_buyer_state"."is_public" IN (0, 1) AND "product_buyer_state"."has_discount" IN (0, 1) AND "product_buyer_state"."available_for_sale" IN (0, 1) AND "product_buyer_state"."has_customer_options" IN (0, 1)),
	CONSTRAINT "product_buyer_state_band_valid" CHECK("product_buyer_state"."availability_band" IN ('untracked', 'out_of_stock', 'low_stock', 'in_stock')),
	CONSTRAINT "product_buyer_state_discount_depth_range" CHECK("product_buyer_state"."discount_depth_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "product_buyer_state_price_shape" CHECK(("product_buyer_state"."sku_id" IS NULL AND "product_buyer_state"."from_minor" IS NULL AND "product_buyer_state"."to_minor" IS NULL AND "product_buyer_state"."base_minor" IS NULL) OR ("product_buyer_state"."sku_id" IS NOT NULL AND "product_buyer_state"."from_minor" IS NOT NULL AND "product_buyer_state"."to_minor" IS NOT NULL AND "product_buyer_state"."base_minor" IS NOT NULL AND "product_buyer_state"."from_minor" >= 0 AND "product_buyer_state"."to_minor" >= "product_buyer_state"."from_minor" AND "product_buyer_state"."base_minor" >= "product_buyer_state"."from_minor")),
	CONSTRAINT "product_buyer_state_public_priced" CHECK("product_buyer_state"."is_public" = 0 OR "product_buyer_state"."sku_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "product_buyer_state_newest_idx" ON "product_buyer_state" ("is_public","product_created_at" DESC,"product_id");
--> statement-breakpoint
CREATE INDEX "product_buyer_state_category_newest_idx" ON "product_buyer_state" ("is_public","category_id","product_created_at" DESC,"product_id");
--> statement-breakpoint
CREATE INDEX "product_buyer_state_brand_newest_idx" ON "product_buyer_state" ("is_public","brand_id","product_created_at" DESC,"product_id") WHERE "product_buyer_state"."brand_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "product_buyer_state_price_idx" ON "product_buyer_state" ("is_public","from_minor","product_id");
--> statement-breakpoint
-- Precomputed recommendations, refreshed off the request path.
CREATE TABLE "product_recommendations" (
	"product_id" text NOT NULL,
	"position" bigint NOT NULL,
	"recommended_product_id" text NOT NULL,
	"reason" text NOT NULL,
	"computed_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("product_id", "position"),
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("recommended_product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_recommendations_position_range" CHECK("product_recommendations"."position" BETWEEN 0 AND 23),
	CONSTRAINT "product_recommendations_not_self" CHECK("product_recommendations"."recommended_product_id" <> "product_recommendations"."product_id"),
	CONSTRAINT "product_recommendations_reason_valid" CHECK("product_recommendations"."reason" IN ('also_bought', 'similar', 'popular', 'new_arrivals'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_recommendations_pair_unique" ON "product_recommendations" ("product_id","recommended_product_id");
--> statement-breakpoint
CREATE INDEX "product_recommendations_recommended_idx" ON "product_recommendations" ("recommended_product_id");
--> statement-breakpoint
-- Units sold in the last 30 days (real order lines), refreshed on a schedule.
CREATE TABLE "product_sales_stats" (
	"product_id" text PRIMARY KEY NOT NULL,
	"sold_30d" bigint DEFAULT 0 NOT NULL,
	"computed_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_sales_stats_sold_nonnegative" CHECK("product_sales_stats"."sold_30d" >= 0)
);
--> statement-breakpoint
CREATE INDEX "product_sales_stats_popular_idx" ON "product_sales_stats" ("sold_30d" DESC,"product_id");
--> statement-breakpoint
-- Product content blocks: typed blocks whose settings follow the strict
-- per-type schema in packages/shared/src/product-content-blocks.ts.
CREATE TABLE "product_content_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"placement" text NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"settings" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_content_blocks_id_shape" CHECK(substr("product_content_blocks"."id", 1, 4) = 'pcb_' AND length("product_content_blocks"."id") BETWEEN 8 AND 120 AND "product_content_blocks"."id" !~ '[^A-Za-z0-9_-]'),
	CONSTRAINT "product_content_blocks_placement_valid" CHECK("product_content_blocks"."placement" IN ('tabs', 'after-buy-box', 'after-description', 'before-reviews')),
	CONSTRAINT "product_content_blocks_position_nonnegative" CHECK("product_content_blocks"."position" >= 0),
	CONSTRAINT "product_content_blocks_type_shape" CHECK(length("product_content_blocks"."type") BETWEEN 1 AND 40 AND "product_content_blocks"."type" = lower("product_content_blocks"."type") AND "product_content_blocks"."type" !~ '[^A-Za-z0-9_-]' AND position('_' in "product_content_blocks"."type") = 0),
	CONSTRAINT "product_content_blocks_version_positive" CHECK("product_content_blocks"."version" >= 1),
	CONSTRAINT "product_content_blocks_settings_valid" CHECK(json_valid("product_content_blocks"."settings") AND substr("product_content_blocks"."settings", 1, 1) = '{' AND length("product_content_blocks"."settings") <= 262144)
);
--> statement-breakpoint
CREATE INDEX "product_content_blocks_product_order_idx" ON "product_content_blocks" ("product_id","placement","position","id");
--> statement-breakpoint
INSERT INTO "product_content_blocks" ("id", "product_id", "placement", "position", "type", "version", "settings", "created_at", "updated_at")
SELECT 'pcb_' || "id", "product_id", 'tabs', max(0, CAST("sort_order" AS bigint)), 'rich-text', 1,
       json_object('title', "title", 'html', "content"), "created_at", "updated_at"
FROM "product_rich_content";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_rich_content_mirror_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "product_content_blocks" ("id", "product_id", "placement", "position", "type", "version", "settings", "created_at", "updated_at")
  VALUES ('pcb_' || NEW."id", NEW."product_id", 'tabs', max(0, CAST(NEW."sort_order" AS bigint)), 'rich-text', 1,
          json_object('title', NEW."title", 'html', NEW."content"), NEW."created_at", NEW."updated_at");
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_rich_content_mirror_insert"
AFTER INSERT ON "product_rich_content"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_rich_content_mirror_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_rich_content_mirror_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "product_content_blocks"
  SET "position" = max(0, CAST(NEW."sort_order" AS bigint)),
      "settings" = json_object('title', NEW."title", 'html', NEW."content"),
      "updated_at" = NEW."updated_at"
  WHERE "id" = 'pcb_' || NEW."id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_rich_content_mirror_update"
AFTER UPDATE ON "product_rich_content"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_rich_content_mirror_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_rich_content_mirror_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM "product_content_blocks" WHERE "id" = 'pcb_' || OLD."id";
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_rich_content_mirror_delete"
AFTER DELETE ON "product_rich_content"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_rich_content_mirror_delete_fn"();
--> statement-breakpoint
-- Quantity tiers ("2 for 10% off", "3 for 900"): checkout prices them, so
-- every change fences in-flight checkouts like any other price input.
CREATE TABLE "product_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"quantity" bigint NOT NULL,
	"discount_type" text NOT NULL,
	"discount_bps" bigint DEFAULT 0 NOT NULL,
	"price_minor" bigint,
	"label" text,
	"position" bigint DEFAULT 0 NOT NULL,
	"is_active" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "product_bundles_id_shape" CHECK(substr("product_bundles"."id", 1, 4) = 'pbd_' AND length("product_bundles"."id") BETWEEN 10 AND 68 AND "product_bundles"."id" !~ '[^A-Za-z0-9_-]'),
	CONSTRAINT "product_bundles_quantity_range" CHECK("product_bundles"."quantity" BETWEEN 2 AND 100),
	CONSTRAINT "product_bundles_price_shape" CHECK(("product_bundles"."discount_type" = 'percentage' AND "product_bundles"."discount_bps" BETWEEN 1 AND 9999 AND "product_bundles"."price_minor" IS NULL) OR ("product_bundles"."discount_type" = 'fixed_price' AND "product_bundles"."discount_bps" = 0 AND "product_bundles"."price_minor" IS NOT NULL AND "product_bundles"."price_minor" > 0)),
	CONSTRAINT "product_bundles_label_valid" CHECK("product_bundles"."label" IS NULL OR ("product_bundles"."label" = trim("product_bundles"."label") AND length("product_bundles"."label") BETWEEN 1 AND 60)),
	CONSTRAINT "product_bundles_position_nonnegative" CHECK("product_bundles"."position" >= 0),
	CONSTRAINT "product_bundles_active_valid" CHECK("product_bundles"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_bundles_product_quantity_unique" ON "product_bundles" ("product_id","quantity");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_bundles_checkout_authority_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_bundles_checkout_authority_insert"
AFTER INSERT ON "product_bundles"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_bundles_checkout_authority_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_bundles_checkout_authority_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."product_id" IS DISTINCT FROM OLD."product_id"
  OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
  OR NEW."discount_type" IS DISTINCT FROM OLD."discount_type"
  OR NEW."discount_bps" IS DISTINCT FROM OLD."discount_bps"
  OR NEW."price_minor" IS DISTINCT FROM OLD."price_minor"
  OR NEW."is_active" IS DISTINCT FROM OLD."is_active"), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_bundles_checkout_authority_update"
AFTER UPDATE ON "product_bundles"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_bundles_checkout_authority_update_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."product_bundles_checkout_authority_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "checkout_authority" SET "revision" = "revision" + 1, "updated_at" = unixepoch() WHERE "id" = 'default';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "product_bundles_checkout_authority_delete"
AFTER DELETE ON "product_bundles"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."product_bundles_checkout_authority_delete_fn"();
--> statement-breakpoint
-- Never read by any deployed code (templates now live in the theme document).
DROP TABLE "page_templates";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (88, '0088_catalogue_schema', '0c4e0fe4d503aaeda11d492acb521f8740e64073427df0c2d2e2ed9802bf0ecf');
