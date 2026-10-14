-- Turso and PostgreSQL: the indexed text search `search_fts_terms`, in place
-- of D1's FTS5 tables (packages/database/src/search-index.ts). On Turso,
-- compileSqliteMigrationForProvider expands this statement into the table,
-- its triggers and its backfill; PostgreSQL has its sidecar. D1 keeps its
-- FTS5 tables: nothing changes here.
SELECT 'search_fts_terms';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (152, '0152_search_index', '32c542b59fa136f6dbb7ec51231204dbebced72504c0f15ea7e2ff2a2316e13a');
