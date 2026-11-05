-- PostgreSQL only. The SQLite-profile JSON editors json_set, json_insert,
-- json_replace and json_remove exist on PostgreSQL with SQLite's answer for
-- every path a document has or lacks. Before this, PostgreSQL had none of
-- them, so recording a digital upload's part failed and no PostgreSQL store
-- could upload a digital file (packages/database/src/postgres-sqlite-profile.ts,
-- POSTGRES_JSON_EDIT_FUNCTIONS_SQL). D1 and Turso have SQLite's own
-- functions: nothing changes here.
SELECT 1;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (195, '0195_postgres_json_edits', '8ab5a63ebdd53b349e4b5f53f80083c045623f5b0573a5972bcd3947b771666e');
