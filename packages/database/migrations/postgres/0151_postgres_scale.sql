-- PostgreSQL: the cache dependency change log (cache-dep-triggers.ts, CACHE_DEP_POSTGRES_LOG_SQL).
INSERT INTO "cache_clock" ("id", "seq", "floor", "coarse") VALUES (1, 0, 0, 0) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "cache_dep" DROP CONSTRAINT "cache_dep_pkey";
--> statement-breakpoint
CREATE INDEX "cache_dep_dep_seq_idx" ON "cache_dep" ("dep", "seq");
--> statement-breakpoint
CREATE SEQUENCE scalius_compat."cache_dep_seq" AS bigint MINVALUE 0 START WITH 0;
--> statement-breakpoint
SELECT setval('scalius_compat."cache_dep_seq"', GREATEST((SELECT "seq" FROM "cache_clock" WHERE "id" = 1), (SELECT max("seq") FROM "cache_dep"), 0));
--> statement-breakpoint
CREATE SEQUENCE scalius_compat."cache_dep_compacted" AS bigint MINVALUE 0 START WITH 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cache_dep_next_seq"()
RETURNS bigint
LANGUAGE plpgsql
AS $cache_dep_next_seq$
DECLARE
  next_seq bigint := nullif(current_setting('scalius.cache_dep_seq', true), '')::bigint;
BEGIN
  IF next_seq IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('scalius-cache-dep-clock', 0));
    next_seq := nextval('scalius_compat."cache_dep_seq"');
    PERFORM set_config('scalius.cache_dep_seq', next_seq::text, true);
  END IF;
  RETURN next_seq;
END
$cache_dep_next_seq$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cache_dep_bump"(dep_keys text[])
RETURNS void
LANGUAGE plpgsql
AS $cache_dep_bump$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM unnest(dep_keys) AS key_value WHERE key_value IS NOT NULL) THEN
    RETURN;
  END IF;
  IF (SELECT "coarse" FROM "cache_clock" WHERE "id" = 1) = 1 THEN
    dep_keys := ARRAY['store'];
  END IF;
  -- No uniqueness check: under SERIALIZABLE it would read the index pages
  -- other writers insert into. A key bumped twice in one transaction has two
  -- rows at one seq until compaction.
  INSERT INTO "cache_dep" ("dep", "seq")
  SELECT DISTINCT key_value, scalius_compat."cache_dep_next_seq"() FROM unnest(dep_keys) AS key_value WHERE key_value IS NOT NULL;
END
$cache_dep_bump$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cache_dep_compact"()
RETURNS bigint
LANGUAGE plpgsql
AS $cache_dep_compact$
DECLARE
  since bigint;
  through bigint;
  removed bigint;
BEGIN
  SELECT last_value INTO since FROM scalius_compat."cache_dep_compacted";
  SELECT max("seq") INTO through FROM "cache_dep";
  IF through IS NULL OR through <= since THEN
    RETURN 0;
  END IF;
  DELETE FROM "cache_dep" WHERE ctid IN (
    SELECT ranked.row_id FROM (
      SELECT d.ctid AS row_id, row_number() OVER (PARTITION BY d."dep" ORDER BY d."seq" DESC) AS position
      FROM "cache_dep" d
      WHERE d."dep" IN (SELECT "dep" FROM "cache_dep" WHERE "seq" > since AND "seq" <= through)
    ) AS ranked
    WHERE ranked.position > 1
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM setval('scalius_compat."cache_dep_compacted"', through);
  RETURN removed;
END
$cache_dep_compact$;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (151, '0151_postgres_scale', '7a7aba5c17a87178440dd453a8712ebebeddb52b32ac58f578e2273faf9be1d4');
