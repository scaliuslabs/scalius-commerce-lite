-- A limited promotion's redemptions advance its cache key (promo:<id>) only
-- when one exhausts it: the redemption count reaches max_redemptions, or the
-- discount spend reaches max_discount_spend_minor (the evaluator's rule). A
-- removed redemption advances it only when it un-exhausts the promotion.
-- Every other redemption leaves the pages that show the promotion cached, so
-- a flash sale is not re-rendered after every order. The guard is the
-- trigger's WHEN clause (generated from packages/shared/src/cache-deps.ts by
-- packages/database/scripts/cache-dep-triggers.ts). Triggers only.
DROP TRIGGER IF EXISTS "cdep_promotion_redemptions_ins" ON "promotion_redemptions";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_promotion_redemptions_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM promotions WHERE promotions.id = NEW.promotion_id AND (promotions.max_redemptions IS NOT NULL OR promotions.max_discount_spend_minor IS NOT NULL) AND ((promotions.max_redemptions IS NOT NULL AND (SELECT count(*) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = NEW.promotion_id) = promotions.max_redemptions) OR (promotions.max_discount_spend_minor IS NOT NULL AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = NEW.promotion_id) >= promotions.max_discount_spend_minor AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = NEW.promotion_id) - NEW.discount_amount_minor < promotions.max_discount_spend_minor)))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['promo:' || NEW."promotion_id", 't:promotion_redemptions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_promotion_redemptions_ins"
AFTER INSERT ON "promotion_redemptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_promotion_redemptions_ins_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_promotion_redemptions_del" ON "promotion_redemptions";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_promotion_redemptions_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM promotions WHERE promotions.id = OLD.promotion_id AND (promotions.max_redemptions IS NOT NULL OR promotions.max_discount_spend_minor IS NOT NULL) AND ((promotions.max_redemptions IS NOT NULL AND (SELECT count(*) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = OLD.promotion_id) + 1 = promotions.max_redemptions) OR (promotions.max_discount_spend_minor IS NOT NULL AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = OLD.promotion_id) < promotions.max_discount_spend_minor AND (SELECT coalesce(sum(limit_rows.discount_amount_minor), 0) FROM promotion_redemptions AS limit_rows WHERE limit_rows.promotion_id = OLD.promotion_id) + OLD.discount_amount_minor >= promotions.max_discount_spend_minor)))), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['promo:' || OLD."promotion_id", 't:promotion_redemptions']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_promotion_redemptions_del"
AFTER DELETE ON "promotion_redemptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_promotion_redemptions_del_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (167, '0167_promotion_exhaustion_dependency', '32cbe7582a9e1aa23dbf5e5dfba735ce9f4e7462d3f4e85ddd1ff9f10e6d8f3e');
