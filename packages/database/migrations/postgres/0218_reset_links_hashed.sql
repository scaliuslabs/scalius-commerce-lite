-- Reset and invite links are stored hashed: see ../0218_reset_links_hashed.sql.
DELETE FROM "verification"
WHERE "identifier" LIKE 'reset-password:%'
  AND "identifier" NOT LIKE 'reset-password:used:%'
  AND "identifier" NOT LIKE 'reset-password:cancelled:%';
--> statement-breakpoint
UPDATE "verification"
SET "identifier" = 'reset-link:' || substr("identifier", 16)
WHERE "identifier" LIKE 'reset-password:used:%'
   OR "identifier" LIKE 'reset-password:cancelled:%';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (218, '0218_reset_links_hashed', 'cbbf92558b84edc690e9a697e264550f9b79149db4cd235d997732bd99c2640f');
