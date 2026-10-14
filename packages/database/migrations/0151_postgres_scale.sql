-- PostgreSQL only. Its `cache_dep` becomes an insert-only change log with one
-- seq per transaction from a sequence, taken under a transaction advisory
-- lock, so concurrent checkouts no longer fail on the shared clock and key
-- rows (packages/database/scripts/cache-dep-triggers.ts,
-- CACHE_DEP_POSTGRES_LOG_SQL). D1 and Turso keep one writer, one row per key
-- and the clock row: nothing changes here.
SELECT 1;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (151, '0151_postgres_scale', '7a7aba5c17a87178440dd453a8712ebebeddb52b32ac58f578e2273faf9be1d4');
