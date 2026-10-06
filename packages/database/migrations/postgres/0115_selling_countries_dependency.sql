-- Markets step 3b follow-up: the checkout config reads the set of countries
-- the active markets sell to (its accepted phone countries), not the markets'
-- names or presences. The key mk:selling advances only when a country of an
-- active market is added, removed or moved, or a market's status changes
-- (generated from packages/shared/src/cache-deps.ts); a rename of a market
-- leaves it, and every other market's checkout config, valid. Triggers only.
CREATE OR REPLACE FUNCTION scalius_compat."cdep_markets_selling_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:selling', 't:markets']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_markets_selling_upd"
AFTER UPDATE ON "markets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status"))
EXECUTE FUNCTION scalius_compat."cdep_markets_selling_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_markets_selling_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:selling', 't:markets']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_markets_selling_del"
AFTER DELETE ON "markets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'active')
EXECUTE FUNCTION scalius_compat."cdep_markets_selling_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_market_countries_selling_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM markets WHERE markets.id = NEW.market_id AND markets.status = 'active')), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:selling', 't:market_countries']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_market_countries_selling_ins"
AFTER INSERT ON "market_countries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_market_countries_selling_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_market_countries_selling_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((EXISTS (SELECT 1 FROM markets WHERE markets.id = OLD.market_id AND markets.status = 'active')), false) THEN
    RETURN NULL;
  END IF;
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:selling', 't:market_countries']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_market_countries_selling_del"
AFTER DELETE ON "market_countries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_market_countries_selling_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_market_countries_selling_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['mk:selling', 't:market_countries']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_market_countries_selling_upd"
AFTER UPDATE ON "market_countries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."country_code" IS DISTINCT FROM NEW."country_code" OR OLD."market_id" IS DISTINCT FROM NEW."market_id"))
EXECUTE FUNCTION scalius_compat."cdep_market_countries_selling_upd_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (115, '0115_selling_countries_dependency', '371fa529b5b3a6cb9294666fc7aa157809279fd8d656a2571e67074c3d36c0c3');
