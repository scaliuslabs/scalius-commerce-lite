-- PostgreSQL only. The SQLite-profile JSON functions take every JSON shape
-- as SQLite does: json_each over a missing path yields no rows and over a
-- scalar (JSON null included) one row, and json_array_length is NULL for a
-- missing path and 0 for anything but an array. Before this, PostgreSQL
-- raised, so a read over an optional JSON key (a theme without app skins)
-- failed (packages/database/src/postgres-sqlite-profile.ts,
-- POSTGRES_JSON_SHAPE_FUNCTIONS_SQL). D1 and Turso have SQLite's own
-- functions: nothing changes here.
SELECT 1;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (190, '0190_postgres_json_shapes', '693bf2d05d935e9d49867a27adbc191c73e41419bb957f813ad8c1ce6c002a6e');
