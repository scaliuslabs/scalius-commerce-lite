ALTER TABLE "conversations" ADD "search_indexed_seq" bigint;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (145, '0145_conversation_search_cursor', 'b91a94f2a2a37b0a0ff124a49e9b0b5ed03ab943049416c0c2aec709a4a74b8f');
