-- PostgreSQL only. Its `cache_dep` becomes an insert-only change log with one
-- seq per transaction from a sequence, taken under a transaction advisory
-- lock, so concurrent checkouts no longer fail on the shared clock and key
-- rows (packages/database/scripts/cache-dep-triggers.ts,
-- CACHE_DEP_POSTGRES_LOG_SQL). Every text column becomes COLLATE "C", so text
-- orders and compares bytewise as SQLite's BINARY does
-- (packages/database/scripts/postgres-schema.ts, POSTGRES_TEXT_COLLATION_SQL).
-- The JSON table functions plan at 10 rows, not 1,000
-- (packages/database/src/postgres-sqlite-profile.ts, POSTGRES_JSON_EACH_ROWS_SQL).
-- D1 and Turso keep one writer, one row per key and the clock row: nothing
-- changes here.
SELECT 1;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (151, '0151_postgres_scale', '959ce66f33eab4b3ecc54e59371b3a4e6b621198f0bd8f5f6504acebe99ab234');
