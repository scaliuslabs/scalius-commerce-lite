-- PostgreSQL: search reads a rich-text column's search text (SQLite twin and
-- packages/database/src/search-index.ts): the companion columns and their
-- revisions, the stale triggers, the fold table and function, every search
-- trigger (one per indexed column, firing when the text it indexes changed, so
-- the stale trigger's clear and the write it follows index correctly in either
-- order), and every short column's terms written again. A rich-text column
-- keeps its terms until the backfill fills its row.
ALTER TABLE "categories" ADD COLUMN "description_search_text" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description_search_text" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "content_search_text" text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "description_search_rev" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description_search_rev" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "content_search_rev" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "categories_search_text_pending_idx" ON "categories" ("id") WHERE "categories"."description_search_text" IS NULL AND "categories"."description" IS NOT NULL AND "categories"."description_search_rev" >= 0;
--> statement-breakpoint
CREATE INDEX "products_search_text_pending_idx" ON "products" ("id") WHERE "products"."description_search_text" IS NULL AND "products"."description" IS NOT NULL AND "products"."description_search_rev" >= 0;
--> statement-breakpoint
CREATE INDEX "pages_search_text_pending_idx" ON "pages" ("id") WHERE "pages"."content_search_text" IS NULL AND "pages"."content_search_rev" >= 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."products_description_search_text_stale_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."description" IS DISTINCT FROM NEW."description" AND NEW."description_search_rev" IS NOT DISTINCT FROM OLD."description_search_rev" AND (NEW."description_search_text" IS NOT NULL OR NEW."description_search_rev" < 0)), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "products" SET "description_search_text" = NULL, "description_search_rev" = 0 WHERE "id" = NEW."id";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "products_description_search_text_stale"
AFTER UPDATE OF "description" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."products_description_search_text_stale_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."categories_description_search_text_stale_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."description" IS DISTINCT FROM NEW."description" AND NEW."description_search_rev" IS NOT DISTINCT FROM OLD."description_search_rev" AND (NEW."description_search_text" IS NOT NULL OR NEW."description_search_rev" < 0)), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "categories" SET "description_search_text" = NULL, "description_search_rev" = 0 WHERE "id" = NEW."id";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "categories_description_search_text_stale"
AFTER UPDATE OF "description" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."categories_description_search_text_stale_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."pages_content_search_text_stale_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."content" IS DISTINCT FROM NEW."content" AND NEW."content_search_rev" IS NOT DISTINCT FROM OLD."content_search_rev" AND (NEW."content_search_text" IS NOT NULL OR NEW."content_search_rev" < 0)), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "pages" SET "content_search_text" = NULL, "content_search_rev" = 0 WHERE "id" = NEW."id";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "pages_content_search_text_stale"
AFTER UPDATE OF "content" ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."pages_content_search_text_stale_fn"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS search_fts_fold (
  ch text COLLATE "C" PRIMARY KEY NOT NULL,
  folded text NOT NULL
);
--> statement-breakpoint
DELETE FROM search_fts_fold;
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u0001', E' '), (E'\u0002', E' '), (E'\u0003', E' '), (E'\u0004', E' '), (E'\u0005', E' '), (E'\u0006', E' '), (E'\u0007', E' '), (E'\u0008', E' '), (E'\u0009', E' '), (E'\u000a', E' '), (E'\u000b', E' '), (E'\u000c', E' '), (E'\u000d', E' '), (E'\u000e', E' '), (E'\u000f', E' '), (E'\u0010', E' '), (E'\u0011', E' '), (E'\u0012', E' '), (E'\u0013', E' '), (E'\u0014', E' '), (E'\u0015', E' '), (E'\u0016', E' '), (E'\u0017', E' '), (E'\u0018', E' '), (E'\u0019', E' '), (E'\u001a', E' '), (E'\u001b', E' '), (E'\u001c', E' '), (E'\u001d', E' '), (E'\u001e', E' '), (E'\u001f', E' '), (E'!', E' '), (E'"', E' '), (E'#', E' '), (E'$', E' '), (E'%', E' '), (E'&', E' '), (E'''', E' '), (E'(', E' '), (E')', E' '), (E'*', E' '), (E'+', E' '), (E',', E' '), (E'-', E' '), (E'.', E' '), (E'/', E' '), (E':', E' '), (E';', E' '), (E'<', E' '), (E'=', E' '), (E'>', E' '), (E'?', E' '), (E'@', E' '), (E'[', E' '), (E'\\', E' '), (E']', E' '), (E'^', E' '), (E'_', E' '), (E'`', E' '), (E'{', E' '), (E'|', E' '), (E'}', E' '), (E'~', E' '), (E'\u007f', E' '), (E'\u0080', E' '), (E'\u0081', E' '), (E'\u0082', E' '), (E'\u0083', E' '), (E'\u0084', E' '), (E'\u0085', E' '), (E'\u0086', E' '), (E'\u0087', E' '), (E'\u0088', E' '), (E'\u0089', E' '), (E'\u008a', E' '), (E'\u008b', E' '), (E'\u008c', E' '), (E'\u008d', E' '), (E'\u008e', E' '), (E'\u008f', E' '), (E'\u0090', E' '), (E'\u0091', E' '), (E'\u0092', E' '), (E'\u0093', E' '), (E'\u0094', E' '), (E'\u0095', E' '), (E'\u0096', E' '), (E'\u0097', E' '), (E'\u0098', E' '), (E'\u0099', E' '), (E'\u009a', E' '), (E'\u009b', E' '), (E'\u009c', E' '), (E'\u009d', E' '), (E'\u009e', E' '), (E'\u009f', E' '), (E'\u00a0', E' '), (E'\u00a1', E' '), (E'\u00a2', E' '), (E'\u00a3', E' '), (E'\u00a4', E' '), (E'\u00a5', E' '), (E'\u00a6', E' '), (E'\u00a7', E' '), (E'\u00a8', E' '), (E'\u00a9', E' '), (E'\u00ab', E' '), (E'\u00ac', E' '), (E'\u00ad', E' '), (E'\u00ae', E' '), (E'\u00af', E' '), (E'\u00b0', E' '), (E'\u00b1', E' '), (E'\u00b4', E' '), (E'\u00b6', E' '), (E'\u00b7', E' '), (E'\u00b8', E' '), (E'\u00bb', E' '), (E'\u00bf', E' '), (E'\u00d7', E' '), (E'\u00f7', E' '), (E'\u02c2', E' '), (E'\u02c3', E' '), (E'\u02c4', E' '), (E'\u02c5', E' '), (E'\u02d2', E' '), (E'\u02d3', E' '), (E'\u02d4', E' '), (E'\u02d5', E' '), (E'\u02d6', E' '), (E'\u02d7', E' '), (E'\u02d8', E' '), (E'\u02d9', E' '), (E'\u02da', E' '), (E'\u02db', E' '), (E'\u02dc', E' '), (E'\u02dd', E' '), (E'\u02de', E' '), (E'\u02df', E' '), (E'\u02e5', E' '), (E'\u02e6', E' '), (E'\u02e7', E' '), (E'\u02e8', E' '), (E'\u02e9', E' '), (E'\u02ea', E' '), (E'\u02eb', E' '), (E'\u02ed', E' '), (E'\u02ef', E' '), (E'\u02f0', E' '), (E'\u02f1', E' '), (E'\u02f2', E' '), (E'\u02f3', E' '), (E'\u02f4', E' '), (E'\u02f5', E' '), (E'\u02f6', E' '), (E'\u02f7', E' '), (E'\u02f8', E' '), (E'\u02f9', E' '), (E'\u02fa', E' '), (E'\u02fb', E' '), (E'\u02fc', E' '), (E'\u02fd', E' '), (E'\u02fe', E' '), (E'\u02ff', E' '), (E'\u0375', E' '), (E'\u037e', E' '), (E'\u0384', E' '), (E'\u0385', E' '), (E'\u0387', E' '), (E'\u03f6', E' '), (E'\u0482', E' '), (E'\u0488', E' '), (E'\u0489', E' '), (E'\u055a', E' '), (E'\u055b', E' '), (E'\u055c', E' '), (E'\u055d', E' '), (E'\u055e', E' '), (E'\u055f', E' '), (E'\u0589', E' '), (E'\u058a', E' '), (E'\u058f', E' '), (E'\u05be', E' '), (E'\u05c0', E' '), (E'\u05c3', E' '), (E'\u05c6', E' '), (E'\u05f3', E' '), (E'\u05f4', E' '), (E'\u0600', E' '), (E'\u0601', E' '), (E'\u0602', E' '), (E'\u0603', E' '), (E'\u0604', E' '), (E'\u0606', E' '), (E'\u0607', E' '), (E'\u0608', E' '), (E'\u0609', E' '), (E'\u060a', E' '), (E'\u060b', E' '), (E'\u060c', E' '), (E'\u060d', E' '), (E'\u060e', E' '), (E'\u060f', E' '), (E'\u061b', E' '), (E'\u061e', E' '), (E'\u061f', E' '), (E'\u066a', E' '), (E'\u066b', E' '), (E'\u066c', E' '), (E'\u066d', E' '), (E'\u06d4', E' '), (E'\u06dd', E' '), (E'\u06de', E' '), (E'\u06e9', E' '), (E'\u06fd', E' '), (E'\u06fe', E' '), (E'\u0700', E' '), (E'\u0701', E' '), (E'\u0702', E' '), (E'\u0703', E' '), (E'\u0704', E' '), (E'\u0705', E' '), (E'\u0706', E' '), (E'\u0707', E' '), (E'\u0708', E' '), (E'\u0709', E' '), (E'\u070a', E' '), (E'\u070b', E' '), (E'\u070c', E' '), (E'\u070d', E' '), (E'\u070f', E' '), (E'\u07f6', E' '), (E'\u07f7', E' '), (E'\u07f8', E' '), (E'\u07f9', E' '), (E'\u0830', E' '), (E'\u0831', E' '), (E'\u0832', E' '), (E'\u0833', E' '), (E'\u0834', E' '), (E'\u0835', E' '), (E'\u0836', E' '), (E'\u0837', E' '), (E'\u0838', E' '), (E'\u0839', E' '), (E'\u083a', E' '), (E'\u083b', E' '), (E'\u083c', E' '), (E'\u083d', E' '), (E'\u083e', E' '), (E'\u085e', E' '), (E'\u0964', E' '), (E'\u0965', E' '), (E'\u0970', E' '), (E'\u09f2', E' '), (E'\u09f3', E' '), (E'\u09fa', E' '), (E'\u09fb', E' '), (E'\u0af0', E' '), (E'\u0af1', E' '), (E'\u0b70', E' '), (E'\u0bf3', E' '), (E'\u0bf4', E' '), (E'\u0bf5', E' '), (E'\u0bf6', E' '), (E'\u0bf7', E' '), (E'\u0bf8', E' '), (E'\u0bf9', E' '), (E'\u0bfa', E' '), (E'\u0c7f', E' '), (E'\u0d79', E' '), (E'\u0df4', E' '), (E'\u0e3f', E' '), (E'\u0e4f', E' '), (E'\u0e5a', E' '), (E'\u0e5b', E' '), (E'\u0f01', E' '), (E'\u0f02', E' '), (E'\u0f03', E' '), (E'\u0f04', E' '), (E'\u0f05', E' '), (E'\u0f06', E' '), (E'\u0f07', E' '), (E'\u0f08', E' '), (E'\u0f09', E' '), (E'\u0f0a', E' '), (E'\u0f0b', E' '), (E'\u0f0c', E' '), (E'\u0f0d', E' '), (E'\u0f0e', E' '), (E'\u0f0f', E' '), (E'\u0f10', E' '), (E'\u0f11', E' '), (E'\u0f12', E' '), (E'\u0f13', E' '), (E'\u0f14', E' '), (E'\u0f15', E' '), (E'\u0f16', E' '), (E'\u0f17', E' '), (E'\u0f1a', E' '), (E'\u0f1b', E' '), (E'\u0f1c', E' '), (E'\u0f1d', E' '), (E'\u0f1e', E' '), (E'\u0f1f', E' '), (E'\u0f34', E' '), (E'\u0f36', E' '), (E'\u0f38', E' '), (E'\u0f3a', E' '), (E'\u0f3b', E' '), (E'\u0f3c', E' '), (E'\u0f3d', E' '), (E'\u0f85', E' '), (E'\u0fbe', E' '), (E'\u0fbf', E' '), (E'\u0fc0', E' '), (E'\u0fc1', E' '), (E'\u0fc2', E' '), (E'\u0fc3', E' '), (E'\u0fc4', E' '), (E'\u0fc5', E' '), (E'\u0fc7', E' '), (E'\u0fc8', E' '), (E'\u0fc9', E' '), (E'\u0fca', E' '), (E'\u0fcb', E' '), (E'\u0fcc', E' '), (E'\u0fce', E' '), (E'\u0fcf', E' '), (E'\u0fd0', E' '), (E'\u0fd1', E' '), (E'\u0fd2', E' '), (E'\u0fd3', E' '), (E'\u0fd4', E' '), (E'\u0fd5', E' '), (E'\u0fd6', E' '), (E'\u0fd7', E' '), (E'\u0fd8', E' '), (E'\u0fd9', E' '), (E'\u0fda', E' '), (E'\u104a', E' '), (E'\u104b', E' '), (E'\u104c', E' '), (E'\u104d', E' '), (E'\u104e', E' '), (E'\u104f', E' '), (E'\u109e', E' '), (E'\u109f', E' '), (E'\u10fb', E' '), (E'\u1360', E' '), (E'\u1361', E' '), (E'\u1362', E' '), (E'\u1363', E' '), (E'\u1364', E' '), (E'\u1365', E' '), (E'\u1366', E' '), (E'\u1367', E' '), (E'\u1368', E' '), (E'\u1390', E' '), (E'\u1391', E' '), (E'\u1392', E' '), (E'\u1393', E' '), (E'\u1394', E' '), (E'\u1395', E' '), (E'\u1396', E' '), (E'\u1397', E' '), (E'\u1398', E' '), (E'\u1399', E' '), (E'\u1400', E' '), (E'\u166d', E' '), (E'\u166e', E' '), (E'\u1680', E' '), (E'\u169b', E' '), (E'\u169c', E' '), (E'\u16eb', E' '), (E'\u16ec', E' '), (E'\u16ed', E' '), (E'\u1735', E' '), (E'\u1736', E' '), (E'\u17d4', E' '), (E'\u17d5', E' '), (E'\u17d6', E' '), (E'\u17d8', E' '), (E'\u17d9', E' '), (E'\u17da', E' '), (E'\u17db', E' '), (E'\u1800', E' '), (E'\u1801', E' '), (E'\u1802', E' '), (E'\u1803', E' '), (E'\u1804', E' '), (E'\u1805', E' '), (E'\u1806', E' '), (E'\u1807', E' '), (E'\u1808', E' '), (E'\u1809', E' '), (E'\u180a', E' '), (E'\u180e', E' '), (E'\u1940', E' '), (E'\u1944', E' '), (E'\u1945', E' '), (E'\u19de', E' '), (E'\u19df', E' '), (E'\u19e0', E' '), (E'\u19e1', E' '), (E'\u19e2', E' '), (E'\u19e3', E' '), (E'\u19e4', E' '), (E'\u19e5', E' '), (E'\u19e6', E' '), (E'\u19e7', E' '), (E'\u19e8', E' '), (E'\u19e9', E' '), (E'\u19ea', E' '), (E'\u19eb', E' '), (E'\u19ec', E' '), (E'\u19ed', E' '), (E'\u19ee', E' '), (E'\u19ef', E' '), (E'\u19f0', E' '), (E'\u19f1', E' '), (E'\u19f2', E' '), (E'\u19f3', E' '), (E'\u19f4', E' '), (E'\u19f5', E' '), (E'\u19f6', E' '), (E'\u19f7', E' '), (E'\u19f8', E' '), (E'\u19f9', E' '), (E'\u19fa', E' '), (E'\u19fb', E' '), (E'\u19fc', E' '), (E'\u19fd', E' '), (E'\u19fe', E' '), (E'\u19ff', E' '), (E'\u1a1e', E' '), (E'\u1a1f', E' '), (E'\u1aa0', E' '), (E'\u1aa1', E' '), (E'\u1aa2', E' '), (E'\u1aa3', E' '), (E'\u1aa4', E' '), (E'\u1aa5', E' '), (E'\u1aa6', E' '), (E'\u1aa8', E' '), (E'\u1aa9', E' '), (E'\u1aaa', E' '), (E'\u1aab', E' '), (E'\u1aac', E' '), (E'\u1aad', E' '), (E'\u1b5a', E' '), (E'\u1b5b', E' '), (E'\u1b5c', E' '), (E'\u1b5d', E' '), (E'\u1b5e', E' '), (E'\u1b5f', E' '), (E'\u1b60', E' '), (E'\u1b61', E' '), (E'\u1b62', E' '), (E'\u1b63', E' '), (E'\u1b64', E' '), (E'\u1b65', E' '), (E'\u1b66', E' '), (E'\u1b67', E' '), (E'\u1b68', E' '), (E'\u1b69', E' '), (E'\u1b6a', E' '), (E'\u1b74', E' '), (E'\u1b75', E' '), (E'\u1b76', E' '), (E'\u1b77', E' '), (E'\u1b78', E' '), (E'\u1b79', E' '), (E'\u1b7a', E' '), (E'\u1b7b', E' '), (E'\u1b7c', E' '), (E'\u1bfc', E' '), (E'\u1bfd', E' '), (E'\u1bfe', E' '), (E'\u1bff', E' '), (E'\u1c3b', E' '), (E'\u1c3c', E' '), (E'\u1c3d', E' '), (E'\u1c3e', E' '), (E'\u1c3f', E' '), (E'\u1c7e', E' '), (E'\u1c7f', E' '), (E'\u1cc0', E' '), (E'\u1cc1', E' '), (E'\u1cc2', E' '), (E'\u1cc3', E' '), (E'\u1cc4', E' '), (E'\u1cc5', E' '), (E'\u1cc6', E' '), (E'\u1cc7', E' '), (E'\u1cd3', E' '), (E'\u1fbd', E' '), (E'\u1fbf', E' '), (E'\u1fc0', E' '), (E'\u1fc1', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u1fcd', E' '), (E'\u1fce', E' '), (E'\u1fcf', E' '), (E'\u1fdd', E' '), (E'\u1fde', E' '), (E'\u1fdf', E' '), (E'\u1fed', E' '), (E'\u1fee', E' '), (E'\u1fef', E' '), (E'\u1ffd', E' '), (E'\u1ffe', E' '), (E'\u2000', E' '), (E'\u2001', E' '), (E'\u2002', E' '), (E'\u2003', E' '), (E'\u2004', E' '), (E'\u2005', E' '), (E'\u2006', E' '), (E'\u2007', E' '), (E'\u2008', E' '), (E'\u2009', E' '), (E'\u200a', E' '), (E'\u200b', E' '), (E'\u200c', E''), (E'\u200d', E''), (E'\u200e', E' '), (E'\u200f', E' '), (E'\u2010', E' '), (E'\u2011', E' '), (E'\u2012', E' '), (E'\u2013', E' '), (E'\u2014', E' '), (E'\u2015', E' '), (E'\u2016', E' '), (E'\u2017', E' '), (E'\u2018', E' '), (E'\u2019', E' '), (E'\u201a', E' '), (E'\u201b', E' '), (E'\u201c', E' '), (E'\u201d', E' '), (E'\u201e', E' '), (E'\u201f', E' '), (E'\u2020', E' '), (E'\u2021', E' '), (E'\u2022', E' '), (E'\u2023', E' '), (E'\u2024', E' '), (E'\u2025', E' '), (E'\u2026', E' '), (E'\u2027', E' '), (E'\u2028', E' '), (E'\u2029', E' '), (E'\u202a', E' '), (E'\u202b', E' '), (E'\u202c', E' '), (E'\u202d', E' '), (E'\u202e', E' '), (E'\u202f', E' '), (E'\u2030', E' '), (E'\u2031', E' '), (E'\u2032', E' '), (E'\u2033', E' '), (E'\u2034', E' '), (E'\u2035', E' '), (E'\u2036', E' '), (E'\u2037', E' '), (E'\u2038', E' '), (E'\u2039', E' '), (E'\u203a', E' '), (E'\u203b', E' '), (E'\u203c', E' '), (E'\u203d', E' '), (E'\u203e', E' '), (E'\u203f', E' '), (E'\u2040', E' '), (E'\u2041', E' '), (E'\u2042', E' '), (E'\u2043', E' '), (E'\u2044', E' '), (E'\u2045', E' '), (E'\u2046', E' '), (E'\u2047', E' '), (E'\u2048', E' '), (E'\u2049', E' '), (E'\u204a', E' '), (E'\u204b', E' '), (E'\u204c', E' '), (E'\u204d', E' '), (E'\u204e', E' '), (E'\u204f', E' '), (E'\u2050', E' '), (E'\u2051', E' '), (E'\u2052', E' '), (E'\u2053', E' '), (E'\u2054', E' '), (E'\u2055', E' '), (E'\u2056', E' '), (E'\u2057', E' '), (E'\u2058', E' '), (E'\u2059', E' '), (E'\u205a', E' '), (E'\u205b', E' '), (E'\u205c', E' '), (E'\u205d', E' '), (E'\u205e', E' '), (E'\u205f', E' '), (E'\u2060', E' '), (E'\u2061', E' '), (E'\u2062', E' '), (E'\u2063', E' '), (E'\u2064', E' '), (E'\u206a', E' '), (E'\u206b', E' '), (E'\u206c', E' '), (E'\u206d', E' '), (E'\u206e', E' '), (E'\u206f', E' '), (E'\u207a', E' '), (E'\u207b', E' '), (E'\u207c', E' '), (E'\u207d', E' '), (E'\u207e', E' '), (E'\u208a', E' '), (E'\u208b', E' '), (E'\u208c', E' '), (E'\u208d', E' '), (E'\u208e', E' '), (E'\u20a0', E' '), (E'\u20a1', E' '), (E'\u20a2', E' '), (E'\u20a3', E' '), (E'\u20a4', E' '), (E'\u20a5', E' '), (E'\u20a6', E' '), (E'\u20a7', E' '), (E'\u20a8', E' '), (E'\u20a9', E' '), (E'\u20aa', E' '), (E'\u20ab', E' '), (E'\u20ac', E' '), (E'\u20ad', E' '), (E'\u20ae', E' '), (E'\u20af', E' '), (E'\u20b0', E' '), (E'\u20b1', E' '), (E'\u20b2', E' '), (E'\u20b3', E' '), (E'\u20b4', E' '), (E'\u20b5', E' '), (E'\u20b6', E' '), (E'\u20b7', E' '), (E'\u20b8', E' '), (E'\u20b9', E' '), (E'\u20dd', E' '), (E'\u20de', E' '), (E'\u20df', E' '), (E'\u20e0', E' '), (E'\u20e2', E' '), (E'\u20e3', E' '), (E'\u20e4', E' '), (E'\u2100', E' '), (E'\u2101', E' '), (E'\u2103', E' '), (E'\u2104', E' '), (E'\u2105', E' '), (E'\u2106', E' '), (E'\u2108', E' '), (E'\u2109', E' '), (E'\u2114', E' '), (E'\u2116', E' '), (E'\u2117', E' '), (E'\u2118', E' '), (E'\u211e', E' '), (E'\u211f', E' '), (E'\u2120', E' '), (E'\u2121', E' '), (E'\u2122', E' '), (E'\u2123', E' '), (E'\u2125', E' '), (E'\u2127', E' '), (E'\u2129', E' '), (E'\u212e', E' '), (E'\u213a', E' '), (E'\u213b', E' '), (E'\u2140', E' '), (E'\u2141', E' '), (E'\u2142', E' '), (E'\u2143', E' '), (E'\u2144', E' '), (E'\u214a', E' '), (E'\u214b', E' '), (E'\u214c', E' '), (E'\u214d', E' '), (E'\u214f', E' '), (E'\u2190', E' '), (E'\u2191', E' '), (E'\u2192', E' '), (E'\u2193', E' '), (E'\u2194', E' '), (E'\u2195', E' '), (E'\u2196', E' '), (E'\u2197', E' '), (E'\u2198', E' '), (E'\u2199', E' '), (E'\u219a', E' '), (E'\u219b', E' '), (E'\u219c', E' '), (E'\u219d', E' '), (E'\u219e', E' '), (E'\u219f', E' '), (E'\u21a0', E' '), (E'\u21a1', E' '), (E'\u21a2', E' '), (E'\u21a3', E' '), (E'\u21a4', E' '), (E'\u21a5', E' '), (E'\u21a6', E' '), (E'\u21a7', E' '), (E'\u21a8', E' '), (E'\u21a9', E' '), (E'\u21aa', E' '), (E'\u21ab', E' '), (E'\u21ac', E' '), (E'\u21ad', E' '), (E'\u21ae', E' '), (E'\u21af', E' '), (E'\u21b0', E' '), (E'\u21b1', E' '), (E'\u21b2', E' '), (E'\u21b3', E' '), (E'\u21b4', E' '), (E'\u21b5', E' '), (E'\u21b6', E' '), (E'\u21b7', E' '), (E'\u21b8', E' '), (E'\u21b9', E' '), (E'\u21ba', E' '), (E'\u21bb', E' '), (E'\u21bc', E' '), (E'\u21bd', E' '), (E'\u21be', E' '), (E'\u21bf', E' '), (E'\u21c0', E' '), (E'\u21c1', E' '), (E'\u21c2', E' '), (E'\u21c3', E' '), (E'\u21c4', E' '), (E'\u21c5', E' '), (E'\u21c6', E' '), (E'\u21c7', E' '), (E'\u21c8', E' '), (E'\u21c9', E' '), (E'\u21ca', E' '), (E'\u21cb', E' '), (E'\u21cc', E' '), (E'\u21cd', E' '), (E'\u21ce', E' '), (E'\u21cf', E' '), (E'\u21d0', E' '), (E'\u21d1', E' '), (E'\u21d2', E' '), (E'\u21d3', E' '), (E'\u21d4', E' '), (E'\u21d5', E' '), (E'\u21d6', E' '), (E'\u21d7', E' '), (E'\u21d8', E' '), (E'\u21d9', E' '), (E'\u21da', E' '), (E'\u21db', E' '), (E'\u21dc', E' '), (E'\u21dd', E' '), (E'\u21de', E' '), (E'\u21df', E' '), (E'\u21e0', E' '), (E'\u21e1', E' '), (E'\u21e2', E' '), (E'\u21e3', E' '), (E'\u21e4', E' '), (E'\u21e5', E' '), (E'\u21e6', E' '), (E'\u21e7', E' '), (E'\u21e8', E' '), (E'\u21e9', E' '), (E'\u21ea', E' '), (E'\u21eb', E' '), (E'\u21ec', E' '), (E'\u21ed', E' '), (E'\u21ee', E' '), (E'\u21ef', E' '), (E'\u21f0', E' '), (E'\u21f1', E' '), (E'\u21f2', E' '), (E'\u21f3', E' '), (E'\u21f4', E' '), (E'\u21f5', E' '), (E'\u21f6', E' '), (E'\u21f7', E' '), (E'\u21f8', E' '), (E'\u21f9', E' '), (E'\u21fa', E' '), (E'\u21fb', E' '), (E'\u21fc', E' '), (E'\u21fd', E' '), (E'\u21fe', E' '), (E'\u21ff', E' '), (E'\u2200', E' '), (E'\u2201', E' '), (E'\u2202', E' '), (E'\u2203', E' '), (E'\u2204', E' '), (E'\u2205', E' '), (E'\u2206', E' '), (E'\u2207', E' '), (E'\u2208', E' '), (E'\u2209', E' '), (E'\u220a', E' '), (E'\u220b', E' '), (E'\u220c', E' '), (E'\u220d', E' '), (E'\u220e', E' '), (E'\u220f', E' '), (E'\u2210', E' '), (E'\u2211', E' '), (E'\u2212', E' '), (E'\u2213', E' '), (E'\u2214', E' '), (E'\u2215', E' '), (E'\u2216', E' '), (E'\u2217', E' '), (E'\u2218', E' '), (E'\u2219', E' '), (E'\u221a', E' '), (E'\u221b', E' '), (E'\u221c', E' '), (E'\u221d', E' '), (E'\u221e', E' '), (E'\u221f', E' '), (E'\u2220', E' '), (E'\u2221', E' '), (E'\u2222', E' '), (E'\u2223', E' '), (E'\u2224', E' '), (E'\u2225', E' '), (E'\u2226', E' '), (E'\u2227', E' '), (E'\u2228', E' '), (E'\u2229', E' '), (E'\u222a', E' '), (E'\u222b', E' '), (E'\u222c', E' '), (E'\u222d', E' '), (E'\u222e', E' '), (E'\u222f', E' '), (E'\u2230', E' '), (E'\u2231', E' '), (E'\u2232', E' '), (E'\u2233', E' '), (E'\u2234', E' '), (E'\u2235', E' '), (E'\u2236', E' '), (E'\u2237', E' '), (E'\u2238', E' '), (E'\u2239', E' '), (E'\u223a', E' '), (E'\u223b', E' '), (E'\u223c', E' '), (E'\u223d', E' '), (E'\u223e', E' '), (E'\u223f', E' '), (E'\u2240', E' '), (E'\u2241', E' '), (E'\u2242', E' '), (E'\u2243', E' '), (E'\u2244', E' '), (E'\u2245', E' '), (E'\u2246', E' '), (E'\u2247', E' '), (E'\u2248', E' '), (E'\u2249', E' '), (E'\u224a', E' '), (E'\u224b', E' '), (E'\u224c', E' '), (E'\u224d', E' '), (E'\u224e', E' '), (E'\u224f', E' '), (E'\u2250', E' '), (E'\u2251', E' '), (E'\u2252', E' '), (E'\u2253', E' '), (E'\u2254', E' '), (E'\u2255', E' '), (E'\u2256', E' '), (E'\u2257', E' '), (E'\u2258', E' '), (E'\u2259', E' '), (E'\u225a', E' '), (E'\u225b', E' '), (E'\u225c', E' '), (E'\u225d', E' '), (E'\u225e', E' '), (E'\u225f', E' '), (E'\u2260', E' '), (E'\u2261', E' '), (E'\u2262', E' '), (E'\u2263', E' '), (E'\u2264', E' '), (E'\u2265', E' '), (E'\u2266', E' '), (E'\u2267', E' '), (E'\u2268', E' '), (E'\u2269', E' '), (E'\u226a', E' '), (E'\u226b', E' '), (E'\u226c', E' '), (E'\u226d', E' '), (E'\u226e', E' '), (E'\u226f', E' '), (E'\u2270', E' '), (E'\u2271', E' '), (E'\u2272', E' '), (E'\u2273', E' '), (E'\u2274', E' '), (E'\u2275', E' '), (E'\u2276', E' '), (E'\u2277', E' '), (E'\u2278', E' '), (E'\u2279', E' '), (E'\u227a', E' '), (E'\u227b', E' '), (E'\u227c', E' '), (E'\u227d', E' '), (E'\u227e', E' '), (E'\u227f', E' '), (E'\u2280', E' '), (E'\u2281', E' '), (E'\u2282', E' '), (E'\u2283', E' '), (E'\u2284', E' '), (E'\u2285', E' '), (E'\u2286', E' '), (E'\u2287', E' '), (E'\u2288', E' '), (E'\u2289', E' '), (E'\u228a', E' '), (E'\u228b', E' '), (E'\u228c', E' '), (E'\u228d', E' '), (E'\u228e', E' '), (E'\u228f', E' '), (E'\u2290', E' '), (E'\u2291', E' '), (E'\u2292', E' '), (E'\u2293', E' '), (E'\u2294', E' '), (E'\u2295', E' '), (E'\u2296', E' '), (E'\u2297', E' '), (E'\u2298', E' '), (E'\u2299', E' '), (E'\u229a', E' '), (E'\u229b', E' '), (E'\u229c', E' '), (E'\u229d', E' '), (E'\u229e', E' '), (E'\u229f', E' '), (E'\u22a0', E' '), (E'\u22a1', E' '), (E'\u22a2', E' '), (E'\u22a3', E' '), (E'\u22a4', E' '), (E'\u22a5', E' '), (E'\u22a6', E' '), (E'\u22a7', E' '), (E'\u22a8', E' '), (E'\u22a9', E' '), (E'\u22aa', E' '), (E'\u22ab', E' '), (E'\u22ac', E' '), (E'\u22ad', E' '), (E'\u22ae', E' '), (E'\u22af', E' '), (E'\u22b0', E' '), (E'\u22b1', E' '), (E'\u22b2', E' '), (E'\u22b3', E' '), (E'\u22b4', E' '), (E'\u22b5', E' '), (E'\u22b6', E' '), (E'\u22b7', E' '), (E'\u22b8', E' '), (E'\u22b9', E' '), (E'\u22ba', E' '), (E'\u22bb', E' '), (E'\u22bc', E' '), (E'\u22bd', E' '), (E'\u22be', E' '), (E'\u22bf', E' '), (E'\u22c0', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u22c1', E' '), (E'\u22c2', E' '), (E'\u22c3', E' '), (E'\u22c4', E' '), (E'\u22c5', E' '), (E'\u22c6', E' '), (E'\u22c7', E' '), (E'\u22c8', E' '), (E'\u22c9', E' '), (E'\u22ca', E' '), (E'\u22cb', E' '), (E'\u22cc', E' '), (E'\u22cd', E' '), (E'\u22ce', E' '), (E'\u22cf', E' '), (E'\u22d0', E' '), (E'\u22d1', E' '), (E'\u22d2', E' '), (E'\u22d3', E' '), (E'\u22d4', E' '), (E'\u22d5', E' '), (E'\u22d6', E' '), (E'\u22d7', E' '), (E'\u22d8', E' '), (E'\u22d9', E' '), (E'\u22da', E' '), (E'\u22db', E' '), (E'\u22dc', E' '), (E'\u22dd', E' '), (E'\u22de', E' '), (E'\u22df', E' '), (E'\u22e0', E' '), (E'\u22e1', E' '), (E'\u22e2', E' '), (E'\u22e3', E' '), (E'\u22e4', E' '), (E'\u22e5', E' '), (E'\u22e6', E' '), (E'\u22e7', E' '), (E'\u22e8', E' '), (E'\u22e9', E' '), (E'\u22ea', E' '), (E'\u22eb', E' '), (E'\u22ec', E' '), (E'\u22ed', E' '), (E'\u22ee', E' '), (E'\u22ef', E' '), (E'\u22f0', E' '), (E'\u22f1', E' '), (E'\u22f2', E' '), (E'\u22f3', E' '), (E'\u22f4', E' '), (E'\u22f5', E' '), (E'\u22f6', E' '), (E'\u22f7', E' '), (E'\u22f8', E' '), (E'\u22f9', E' '), (E'\u22fa', E' '), (E'\u22fb', E' '), (E'\u22fc', E' '), (E'\u22fd', E' '), (E'\u22fe', E' '), (E'\u22ff', E' '), (E'\u2300', E' '), (E'\u2301', E' '), (E'\u2302', E' '), (E'\u2303', E' '), (E'\u2304', E' '), (E'\u2305', E' '), (E'\u2306', E' '), (E'\u2307', E' '), (E'\u2308', E' '), (E'\u2309', E' '), (E'\u230a', E' '), (E'\u230b', E' '), (E'\u230c', E' '), (E'\u230d', E' '), (E'\u230e', E' '), (E'\u230f', E' '), (E'\u2310', E' '), (E'\u2311', E' '), (E'\u2312', E' '), (E'\u2313', E' '), (E'\u2314', E' '), (E'\u2315', E' '), (E'\u2316', E' '), (E'\u2317', E' '), (E'\u2318', E' '), (E'\u2319', E' '), (E'\u231a', E' '), (E'\u231b', E' '), (E'\u231c', E' '), (E'\u231d', E' '), (E'\u231e', E' '), (E'\u231f', E' '), (E'\u2320', E' '), (E'\u2321', E' '), (E'\u2322', E' '), (E'\u2323', E' '), (E'\u2324', E' '), (E'\u2325', E' '), (E'\u2326', E' '), (E'\u2327', E' '), (E'\u2328', E' '), (E'\u2329', E' '), (E'\u232a', E' '), (E'\u232b', E' '), (E'\u232c', E' '), (E'\u232d', E' '), (E'\u232e', E' '), (E'\u232f', E' '), (E'\u2330', E' '), (E'\u2331', E' '), (E'\u2332', E' '), (E'\u2333', E' '), (E'\u2334', E' '), (E'\u2335', E' '), (E'\u2336', E' '), (E'\u2337', E' '), (E'\u2338', E' '), (E'\u2339', E' '), (E'\u233a', E' '), (E'\u233b', E' '), (E'\u233c', E' '), (E'\u233d', E' '), (E'\u233e', E' '), (E'\u233f', E' '), (E'\u2340', E' '), (E'\u2341', E' '), (E'\u2342', E' '), (E'\u2343', E' '), (E'\u2344', E' '), (E'\u2345', E' '), (E'\u2346', E' '), (E'\u2347', E' '), (E'\u2348', E' '), (E'\u2349', E' '), (E'\u234a', E' '), (E'\u234b', E' '), (E'\u234c', E' '), (E'\u234d', E' '), (E'\u234e', E' '), (E'\u234f', E' '), (E'\u2350', E' '), (E'\u2351', E' '), (E'\u2352', E' '), (E'\u2353', E' '), (E'\u2354', E' '), (E'\u2355', E' '), (E'\u2356', E' '), (E'\u2357', E' '), (E'\u2358', E' '), (E'\u2359', E' '), (E'\u235a', E' '), (E'\u235b', E' '), (E'\u235c', E' '), (E'\u235d', E' '), (E'\u235e', E' '), (E'\u235f', E' '), (E'\u2360', E' '), (E'\u2361', E' '), (E'\u2362', E' '), (E'\u2363', E' '), (E'\u2364', E' '), (E'\u2365', E' '), (E'\u2366', E' '), (E'\u2367', E' '), (E'\u2368', E' '), (E'\u2369', E' '), (E'\u236a', E' '), (E'\u236b', E' '), (E'\u236c', E' '), (E'\u236d', E' '), (E'\u236e', E' '), (E'\u236f', E' '), (E'\u2370', E' '), (E'\u2371', E' '), (E'\u2372', E' '), (E'\u2373', E' '), (E'\u2374', E' '), (E'\u2375', E' '), (E'\u2376', E' '), (E'\u2377', E' '), (E'\u2378', E' '), (E'\u2379', E' '), (E'\u237a', E' '), (E'\u237b', E' '), (E'\u237c', E' '), (E'\u237d', E' '), (E'\u237e', E' '), (E'\u237f', E' '), (E'\u2380', E' '), (E'\u2381', E' '), (E'\u2382', E' '), (E'\u2383', E' '), (E'\u2384', E' '), (E'\u2385', E' '), (E'\u2386', E' '), (E'\u2387', E' '), (E'\u2388', E' '), (E'\u2389', E' '), (E'\u238a', E' '), (E'\u238b', E' '), (E'\u238c', E' '), (E'\u238d', E' '), (E'\u238e', E' '), (E'\u238f', E' '), (E'\u2390', E' '), (E'\u2391', E' '), (E'\u2392', E' '), (E'\u2393', E' '), (E'\u2394', E' '), (E'\u2395', E' '), (E'\u2396', E' '), (E'\u2397', E' '), (E'\u2398', E' '), (E'\u2399', E' '), (E'\u239a', E' '), (E'\u239b', E' '), (E'\u239c', E' '), (E'\u239d', E' '), (E'\u239e', E' '), (E'\u239f', E' '), (E'\u23a0', E' '), (E'\u23a1', E' '), (E'\u23a2', E' '), (E'\u23a3', E' '), (E'\u23a4', E' '), (E'\u23a5', E' '), (E'\u23a6', E' '), (E'\u23a7', E' '), (E'\u23a8', E' '), (E'\u23a9', E' '), (E'\u23aa', E' '), (E'\u23ab', E' '), (E'\u23ac', E' '), (E'\u23ad', E' '), (E'\u23ae', E' '), (E'\u23af', E' '), (E'\u23b0', E' '), (E'\u23b1', E' '), (E'\u23b2', E' '), (E'\u23b3', E' '), (E'\u23b4', E' '), (E'\u23b5', E' '), (E'\u23b6', E' '), (E'\u23b7', E' '), (E'\u23b8', E' '), (E'\u23b9', E' '), (E'\u23ba', E' '), (E'\u23bb', E' '), (E'\u23bc', E' '), (E'\u23bd', E' '), (E'\u23be', E' '), (E'\u23bf', E' '), (E'\u23c0', E' '), (E'\u23c1', E' '), (E'\u23c2', E' '), (E'\u23c3', E' '), (E'\u23c4', E' '), (E'\u23c5', E' '), (E'\u23c6', E' '), (E'\u23c7', E' '), (E'\u23c8', E' '), (E'\u23c9', E' '), (E'\u23ca', E' '), (E'\u23cb', E' '), (E'\u23cc', E' '), (E'\u23cd', E' '), (E'\u23ce', E' '), (E'\u23cf', E' '), (E'\u23d0', E' '), (E'\u23d1', E' '), (E'\u23d2', E' '), (E'\u23d3', E' '), (E'\u23d4', E' '), (E'\u23d5', E' '), (E'\u23d6', E' '), (E'\u23d7', E' '), (E'\u23d8', E' '), (E'\u23d9', E' '), (E'\u23da', E' '), (E'\u23db', E' '), (E'\u23dc', E' '), (E'\u23dd', E' '), (E'\u23de', E' '), (E'\u23df', E' '), (E'\u23e0', E' '), (E'\u23e1', E' '), (E'\u23e2', E' '), (E'\u23e3', E' '), (E'\u23e4', E' '), (E'\u23e5', E' '), (E'\u23e6', E' '), (E'\u23e7', E' '), (E'\u23e8', E' '), (E'\u23e9', E' '), (E'\u23ea', E' '), (E'\u23eb', E' '), (E'\u23ec', E' '), (E'\u23ed', E' '), (E'\u23ee', E' '), (E'\u23ef', E' '), (E'\u23f0', E' '), (E'\u23f1', E' '), (E'\u23f2', E' '), (E'\u23f3', E' '), (E'\u2400', E' '), (E'\u2401', E' '), (E'\u2402', E' '), (E'\u2403', E' '), (E'\u2404', E' '), (E'\u2405', E' '), (E'\u2406', E' '), (E'\u2407', E' '), (E'\u2408', E' '), (E'\u2409', E' '), (E'\u240a', E' '), (E'\u240b', E' '), (E'\u240c', E' '), (E'\u240d', E' '), (E'\u240e', E' '), (E'\u240f', E' '), (E'\u2410', E' '), (E'\u2411', E' '), (E'\u2412', E' '), (E'\u2413', E' '), (E'\u2414', E' '), (E'\u2415', E' '), (E'\u2416', E' '), (E'\u2417', E' '), (E'\u2418', E' '), (E'\u2419', E' '), (E'\u241a', E' '), (E'\u241b', E' '), (E'\u241c', E' '), (E'\u241d', E' '), (E'\u241e', E' '), (E'\u241f', E' '), (E'\u2420', E' '), (E'\u2421', E' '), (E'\u2422', E' '), (E'\u2423', E' '), (E'\u2424', E' '), (E'\u2425', E' '), (E'\u2426', E' '), (E'\u2440', E' '), (E'\u2441', E' '), (E'\u2442', E' '), (E'\u2443', E' '), (E'\u2444', E' '), (E'\u2445', E' '), (E'\u2446', E' '), (E'\u2447', E' '), (E'\u2448', E' '), (E'\u2449', E' '), (E'\u244a', E' '), (E'\u249c', E' '), (E'\u249d', E' '), (E'\u249e', E' '), (E'\u249f', E' '), (E'\u24a0', E' '), (E'\u24a1', E' '), (E'\u24a2', E' '), (E'\u24a3', E' '), (E'\u24a4', E' '), (E'\u24a5', E' '), (E'\u24a6', E' '), (E'\u24a7', E' '), (E'\u24a8', E' '), (E'\u24a9', E' '), (E'\u24aa', E' '), (E'\u24ab', E' '), (E'\u24ac', E' '), (E'\u24ad', E' '), (E'\u24ae', E' '), (E'\u24af', E' '), (E'\u24b0', E' '), (E'\u24b1', E' '), (E'\u24b2', E' '), (E'\u24b3', E' '), (E'\u24b4', E' '), (E'\u24b5', E' '), (E'\u24b6', E' '), (E'\u24b7', E' '), (E'\u24b8', E' '), (E'\u24b9', E' '), (E'\u24ba', E' '), (E'\u24bb', E' '), (E'\u24bc', E' '), (E'\u24bd', E' '), (E'\u24be', E' '), (E'\u24bf', E' '), (E'\u24c0', E' '), (E'\u24c1', E' '), (E'\u24c2', E' '), (E'\u24c3', E' '), (E'\u24c4', E' '), (E'\u24c5', E' '), (E'\u24c6', E' '), (E'\u24c7', E' '), (E'\u24c8', E' '), (E'\u24c9', E' '), (E'\u24ca', E' '), (E'\u24cb', E' '), (E'\u24cc', E' '), (E'\u24cd', E' '), (E'\u24ce', E' '), (E'\u24cf', E' '), (E'\u24d0', E' '), (E'\u24d1', E' '), (E'\u24d2', E' '), (E'\u24d3', E' '), (E'\u24d4', E' '), (E'\u24d5', E' '), (E'\u24d6', E' '), (E'\u24d7', E' '), (E'\u24d8', E' '), (E'\u24d9', E' '), (E'\u24da', E' '), (E'\u24db', E' '), (E'\u24dc', E' '), (E'\u24dd', E' '), (E'\u24de', E' '), (E'\u24df', E' '), (E'\u24e0', E' '), (E'\u24e1', E' '), (E'\u24e2', E' '), (E'\u24e3', E' '), (E'\u24e4', E' '), (E'\u24e5', E' '), (E'\u24e6', E' '), (E'\u24e7', E' '), (E'\u24e8', E' '), (E'\u24e9', E' '), (E'\u2500', E' '), (E'\u2501', E' '), (E'\u2502', E' '), (E'\u2503', E' '), (E'\u2504', E' '), (E'\u2505', E' '), (E'\u2506', E' '), (E'\u2507', E' '), (E'\u2508', E' '), (E'\u2509', E' '), (E'\u250a', E' '), (E'\u250b', E' '), (E'\u250c', E' '), (E'\u250d', E' '), (E'\u250e', E' '), (E'\u250f', E' '), (E'\u2510', E' '), (E'\u2511', E' '), (E'\u2512', E' '), (E'\u2513', E' '), (E'\u2514', E' '), (E'\u2515', E' '), (E'\u2516', E' '), (E'\u2517', E' '), (E'\u2518', E' '), (E'\u2519', E' '), (E'\u251a', E' '), (E'\u251b', E' '), (E'\u251c', E' '), (E'\u251d', E' '), (E'\u251e', E' '), (E'\u251f', E' '), (E'\u2520', E' '), (E'\u2521', E' '), (E'\u2522', E' '), (E'\u2523', E' '), (E'\u2524', E' '), (E'\u2525', E' '), (E'\u2526', E' '), (E'\u2527', E' '), (E'\u2528', E' '), (E'\u2529', E' '), (E'\u252a', E' '), (E'\u252b', E' '), (E'\u252c', E' '), (E'\u252d', E' '), (E'\u252e', E' '), (E'\u252f', E' '), (E'\u2530', E' '), (E'\u2531', E' '), (E'\u2532', E' '), (E'\u2533', E' '), (E'\u2534', E' '), (E'\u2535', E' '), (E'\u2536', E' '), (E'\u2537', E' '), (E'\u2538', E' '), (E'\u2539', E' '), (E'\u253a', E' '), (E'\u253b', E' '), (E'\u253c', E' '), (E'\u253d', E' '), (E'\u253e', E' '), (E'\u253f', E' '), (E'\u2540', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u2541', E' '), (E'\u2542', E' '), (E'\u2543', E' '), (E'\u2544', E' '), (E'\u2545', E' '), (E'\u2546', E' '), (E'\u2547', E' '), (E'\u2548', E' '), (E'\u2549', E' '), (E'\u254a', E' '), (E'\u254b', E' '), (E'\u254c', E' '), (E'\u254d', E' '), (E'\u254e', E' '), (E'\u254f', E' '), (E'\u2550', E' '), (E'\u2551', E' '), (E'\u2552', E' '), (E'\u2553', E' '), (E'\u2554', E' '), (E'\u2555', E' '), (E'\u2556', E' '), (E'\u2557', E' '), (E'\u2558', E' '), (E'\u2559', E' '), (E'\u255a', E' '), (E'\u255b', E' '), (E'\u255c', E' '), (E'\u255d', E' '), (E'\u255e', E' '), (E'\u255f', E' '), (E'\u2560', E' '), (E'\u2561', E' '), (E'\u2562', E' '), (E'\u2563', E' '), (E'\u2564', E' '), (E'\u2565', E' '), (E'\u2566', E' '), (E'\u2567', E' '), (E'\u2568', E' '), (E'\u2569', E' '), (E'\u256a', E' '), (E'\u256b', E' '), (E'\u256c', E' '), (E'\u256d', E' '), (E'\u256e', E' '), (E'\u256f', E' '), (E'\u2570', E' '), (E'\u2571', E' '), (E'\u2572', E' '), (E'\u2573', E' '), (E'\u2574', E' '), (E'\u2575', E' '), (E'\u2576', E' '), (E'\u2577', E' '), (E'\u2578', E' '), (E'\u2579', E' '), (E'\u257a', E' '), (E'\u257b', E' '), (E'\u257c', E' '), (E'\u257d', E' '), (E'\u257e', E' '), (E'\u257f', E' '), (E'\u2580', E' '), (E'\u2581', E' '), (E'\u2582', E' '), (E'\u2583', E' '), (E'\u2584', E' '), (E'\u2585', E' '), (E'\u2586', E' '), (E'\u2587', E' '), (E'\u2588', E' '), (E'\u2589', E' '), (E'\u258a', E' '), (E'\u258b', E' '), (E'\u258c', E' '), (E'\u258d', E' '), (E'\u258e', E' '), (E'\u258f', E' '), (E'\u2590', E' '), (E'\u2591', E' '), (E'\u2592', E' '), (E'\u2593', E' '), (E'\u2594', E' '), (E'\u2595', E' '), (E'\u2596', E' '), (E'\u2597', E' '), (E'\u2598', E' '), (E'\u2599', E' '), (E'\u259a', E' '), (E'\u259b', E' '), (E'\u259c', E' '), (E'\u259d', E' '), (E'\u259e', E' '), (E'\u259f', E' '), (E'\u25a0', E' '), (E'\u25a1', E' '), (E'\u25a2', E' '), (E'\u25a3', E' '), (E'\u25a4', E' '), (E'\u25a5', E' '), (E'\u25a6', E' '), (E'\u25a7', E' '), (E'\u25a8', E' '), (E'\u25a9', E' '), (E'\u25aa', E' '), (E'\u25ab', E' '), (E'\u25ac', E' '), (E'\u25ad', E' '), (E'\u25ae', E' '), (E'\u25af', E' '), (E'\u25b0', E' '), (E'\u25b1', E' '), (E'\u25b2', E' '), (E'\u25b3', E' '), (E'\u25b4', E' '), (E'\u25b5', E' '), (E'\u25b6', E' '), (E'\u25b7', E' '), (E'\u25b8', E' '), (E'\u25b9', E' '), (E'\u25ba', E' '), (E'\u25bb', E' '), (E'\u25bc', E' '), (E'\u25bd', E' '), (E'\u25be', E' '), (E'\u25bf', E' '), (E'\u25c0', E' '), (E'\u25c1', E' '), (E'\u25c2', E' '), (E'\u25c3', E' '), (E'\u25c4', E' '), (E'\u25c5', E' '), (E'\u25c6', E' '), (E'\u25c7', E' '), (E'\u25c8', E' '), (E'\u25c9', E' '), (E'\u25ca', E' '), (E'\u25cb', E' '), (E'\u25cc', E' '), (E'\u25cd', E' '), (E'\u25ce', E' '), (E'\u25cf', E' '), (E'\u25d0', E' '), (E'\u25d1', E' '), (E'\u25d2', E' '), (E'\u25d3', E' '), (E'\u25d4', E' '), (E'\u25d5', E' '), (E'\u25d6', E' '), (E'\u25d7', E' '), (E'\u25d8', E' '), (E'\u25d9', E' '), (E'\u25da', E' '), (E'\u25db', E' '), (E'\u25dc', E' '), (E'\u25dd', E' '), (E'\u25de', E' '), (E'\u25df', E' '), (E'\u25e0', E' '), (E'\u25e1', E' '), (E'\u25e2', E' '), (E'\u25e3', E' '), (E'\u25e4', E' '), (E'\u25e5', E' '), (E'\u25e6', E' '), (E'\u25e7', E' '), (E'\u25e8', E' '), (E'\u25e9', E' '), (E'\u25ea', E' '), (E'\u25eb', E' '), (E'\u25ec', E' '), (E'\u25ed', E' '), (E'\u25ee', E' '), (E'\u25ef', E' '), (E'\u25f0', E' '), (E'\u25f1', E' '), (E'\u25f2', E' '), (E'\u25f3', E' '), (E'\u25f4', E' '), (E'\u25f5', E' '), (E'\u25f6', E' '), (E'\u25f7', E' '), (E'\u25f8', E' '), (E'\u25f9', E' '), (E'\u25fa', E' '), (E'\u25fb', E' '), (E'\u25fc', E' '), (E'\u25fd', E' '), (E'\u25fe', E' '), (E'\u25ff', E' '), (E'\u2600', E' '), (E'\u2601', E' '), (E'\u2602', E' '), (E'\u2603', E' '), (E'\u2604', E' '), (E'\u2605', E' '), (E'\u2606', E' '), (E'\u2607', E' '), (E'\u2608', E' '), (E'\u2609', E' '), (E'\u260a', E' '), (E'\u260b', E' '), (E'\u260c', E' '), (E'\u260d', E' '), (E'\u260e', E' '), (E'\u260f', E' '), (E'\u2610', E' '), (E'\u2611', E' '), (E'\u2612', E' '), (E'\u2613', E' '), (E'\u2614', E' '), (E'\u2615', E' '), (E'\u2616', E' '), (E'\u2617', E' '), (E'\u2618', E' '), (E'\u2619', E' '), (E'\u261a', E' '), (E'\u261b', E' '), (E'\u261c', E' '), (E'\u261d', E' '), (E'\u261e', E' '), (E'\u261f', E' '), (E'\u2620', E' '), (E'\u2621', E' '), (E'\u2622', E' '), (E'\u2623', E' '), (E'\u2624', E' '), (E'\u2625', E' '), (E'\u2626', E' '), (E'\u2627', E' '), (E'\u2628', E' '), (E'\u2629', E' '), (E'\u262a', E' '), (E'\u262b', E' '), (E'\u262c', E' '), (E'\u262d', E' '), (E'\u262e', E' '), (E'\u262f', E' '), (E'\u2630', E' '), (E'\u2631', E' '), (E'\u2632', E' '), (E'\u2633', E' '), (E'\u2634', E' '), (E'\u2635', E' '), (E'\u2636', E' '), (E'\u2637', E' '), (E'\u2638', E' '), (E'\u2639', E' '), (E'\u263a', E' '), (E'\u263b', E' '), (E'\u263c', E' '), (E'\u263d', E' '), (E'\u263e', E' '), (E'\u263f', E' '), (E'\u2640', E' '), (E'\u2641', E' '), (E'\u2642', E' '), (E'\u2643', E' '), (E'\u2644', E' '), (E'\u2645', E' '), (E'\u2646', E' '), (E'\u2647', E' '), (E'\u2648', E' '), (E'\u2649', E' '), (E'\u264a', E' '), (E'\u264b', E' '), (E'\u264c', E' '), (E'\u264d', E' '), (E'\u264e', E' '), (E'\u264f', E' '), (E'\u2650', E' '), (E'\u2651', E' '), (E'\u2652', E' '), (E'\u2653', E' '), (E'\u2654', E' '), (E'\u2655', E' '), (E'\u2656', E' '), (E'\u2657', E' '), (E'\u2658', E' '), (E'\u2659', E' '), (E'\u265a', E' '), (E'\u265b', E' '), (E'\u265c', E' '), (E'\u265d', E' '), (E'\u265e', E' '), (E'\u265f', E' '), (E'\u2660', E' '), (E'\u2661', E' '), (E'\u2662', E' '), (E'\u2663', E' '), (E'\u2664', E' '), (E'\u2665', E' '), (E'\u2666', E' '), (E'\u2667', E' '), (E'\u2668', E' '), (E'\u2669', E' '), (E'\u266a', E' '), (E'\u266b', E' '), (E'\u266c', E' '), (E'\u266d', E' '), (E'\u266e', E' '), (E'\u266f', E' '), (E'\u2670', E' '), (E'\u2671', E' '), (E'\u2672', E' '), (E'\u2673', E' '), (E'\u2674', E' '), (E'\u2675', E' '), (E'\u2676', E' '), (E'\u2677', E' '), (E'\u2678', E' '), (E'\u2679', E' '), (E'\u267a', E' '), (E'\u267b', E' '), (E'\u267c', E' '), (E'\u267d', E' '), (E'\u267e', E' '), (E'\u267f', E' '), (E'\u2680', E' '), (E'\u2681', E' '), (E'\u2682', E' '), (E'\u2683', E' '), (E'\u2684', E' '), (E'\u2685', E' '), (E'\u2686', E' '), (E'\u2687', E' '), (E'\u2688', E' '), (E'\u2689', E' '), (E'\u268a', E' '), (E'\u268b', E' '), (E'\u268c', E' '), (E'\u268d', E' '), (E'\u268e', E' '), (E'\u268f', E' '), (E'\u2690', E' '), (E'\u2691', E' '), (E'\u2692', E' '), (E'\u2693', E' '), (E'\u2694', E' '), (E'\u2695', E' '), (E'\u2696', E' '), (E'\u2697', E' '), (E'\u2698', E' '), (E'\u2699', E' '), (E'\u269a', E' '), (E'\u269b', E' '), (E'\u269c', E' '), (E'\u269d', E' '), (E'\u269e', E' '), (E'\u269f', E' '), (E'\u26a0', E' '), (E'\u26a1', E' '), (E'\u26a2', E' '), (E'\u26a3', E' '), (E'\u26a4', E' '), (E'\u26a5', E' '), (E'\u26a6', E' '), (E'\u26a7', E' '), (E'\u26a8', E' '), (E'\u26a9', E' '), (E'\u26aa', E' '), (E'\u26ab', E' '), (E'\u26ac', E' '), (E'\u26ad', E' '), (E'\u26ae', E' '), (E'\u26af', E' '), (E'\u26b0', E' '), (E'\u26b1', E' '), (E'\u26b2', E' '), (E'\u26b3', E' '), (E'\u26b4', E' '), (E'\u26b5', E' '), (E'\u26b6', E' '), (E'\u26b7', E' '), (E'\u26b8', E' '), (E'\u26b9', E' '), (E'\u26ba', E' '), (E'\u26bb', E' '), (E'\u26bc', E' '), (E'\u26bd', E' '), (E'\u26be', E' '), (E'\u26bf', E' '), (E'\u26c0', E' '), (E'\u26c1', E' '), (E'\u26c2', E' '), (E'\u26c3', E' '), (E'\u26c4', E' '), (E'\u26c5', E' '), (E'\u26c6', E' '), (E'\u26c7', E' '), (E'\u26c8', E' '), (E'\u26c9', E' '), (E'\u26ca', E' '), (E'\u26cb', E' '), (E'\u26cc', E' '), (E'\u26cd', E' '), (E'\u26ce', E' '), (E'\u26cf', E' '), (E'\u26d0', E' '), (E'\u26d1', E' '), (E'\u26d2', E' '), (E'\u26d3', E' '), (E'\u26d4', E' '), (E'\u26d5', E' '), (E'\u26d6', E' '), (E'\u26d7', E' '), (E'\u26d8', E' '), (E'\u26d9', E' '), (E'\u26da', E' '), (E'\u26db', E' '), (E'\u26dc', E' '), (E'\u26dd', E' '), (E'\u26de', E' '), (E'\u26df', E' '), (E'\u26e0', E' '), (E'\u26e1', E' '), (E'\u26e2', E' '), (E'\u26e3', E' '), (E'\u26e4', E' '), (E'\u26e5', E' '), (E'\u26e6', E' '), (E'\u26e7', E' '), (E'\u26e8', E' '), (E'\u26e9', E' '), (E'\u26ea', E' '), (E'\u26eb', E' '), (E'\u26ec', E' '), (E'\u26ed', E' '), (E'\u26ee', E' '), (E'\u26ef', E' '), (E'\u26f0', E' '), (E'\u26f1', E' '), (E'\u26f2', E' '), (E'\u26f3', E' '), (E'\u26f4', E' '), (E'\u26f5', E' '), (E'\u26f6', E' '), (E'\u26f7', E' '), (E'\u26f8', E' '), (E'\u26f9', E' '), (E'\u26fa', E' '), (E'\u26fb', E' '), (E'\u26fc', E' '), (E'\u26fd', E' '), (E'\u26fe', E' '), (E'\u26ff', E' '), (E'\u2701', E' '), (E'\u2702', E' '), (E'\u2703', E' '), (E'\u2704', E' '), (E'\u2705', E' '), (E'\u2706', E' '), (E'\u2707', E' '), (E'\u2708', E' '), (E'\u2709', E' '), (E'\u270a', E' '), (E'\u270b', E' '), (E'\u270c', E' '), (E'\u270d', E' '), (E'\u270e', E' '), (E'\u270f', E' '), (E'\u2710', E' '), (E'\u2711', E' '), (E'\u2712', E' '), (E'\u2713', E' '), (E'\u2714', E' '), (E'\u2715', E' '), (E'\u2716', E' '), (E'\u2717', E' '), (E'\u2718', E' '), (E'\u2719', E' '), (E'\u271a', E' '), (E'\u271b', E' '), (E'\u271c', E' '), (E'\u271d', E' '), (E'\u271e', E' '), (E'\u271f', E' '), (E'\u2720', E' '), (E'\u2721', E' '), (E'\u2722', E' '), (E'\u2723', E' '), (E'\u2724', E' '), (E'\u2725', E' '), (E'\u2726', E' '), (E'\u2727', E' '), (E'\u2728', E' '), (E'\u2729', E' '), (E'\u272a', E' '), (E'\u272b', E' '), (E'\u272c', E' '), (E'\u272d', E' '), (E'\u272e', E' '), (E'\u272f', E' '), (E'\u2730', E' '), (E'\u2731', E' '), (E'\u2732', E' '), (E'\u2733', E' '), (E'\u2734', E' '), (E'\u2735', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u2736', E' '), (E'\u2737', E' '), (E'\u2738', E' '), (E'\u2739', E' '), (E'\u273a', E' '), (E'\u273b', E' '), (E'\u273c', E' '), (E'\u273d', E' '), (E'\u273e', E' '), (E'\u273f', E' '), (E'\u2740', E' '), (E'\u2741', E' '), (E'\u2742', E' '), (E'\u2743', E' '), (E'\u2744', E' '), (E'\u2745', E' '), (E'\u2746', E' '), (E'\u2747', E' '), (E'\u2748', E' '), (E'\u2749', E' '), (E'\u274a', E' '), (E'\u274b', E' '), (E'\u274c', E' '), (E'\u274d', E' '), (E'\u274e', E' '), (E'\u274f', E' '), (E'\u2750', E' '), (E'\u2751', E' '), (E'\u2752', E' '), (E'\u2753', E' '), (E'\u2754', E' '), (E'\u2755', E' '), (E'\u2756', E' '), (E'\u2757', E' '), (E'\u2758', E' '), (E'\u2759', E' '), (E'\u275a', E' '), (E'\u275b', E' '), (E'\u275c', E' '), (E'\u275d', E' '), (E'\u275e', E' '), (E'\u275f', E' '), (E'\u2760', E' '), (E'\u2761', E' '), (E'\u2762', E' '), (E'\u2763', E' '), (E'\u2764', E' '), (E'\u2765', E' '), (E'\u2766', E' '), (E'\u2767', E' '), (E'\u2768', E' '), (E'\u2769', E' '), (E'\u276a', E' '), (E'\u276b', E' '), (E'\u276c', E' '), (E'\u276d', E' '), (E'\u276e', E' '), (E'\u276f', E' '), (E'\u2770', E' '), (E'\u2771', E' '), (E'\u2772', E' '), (E'\u2773', E' '), (E'\u2774', E' '), (E'\u2775', E' '), (E'\u2794', E' '), (E'\u2795', E' '), (E'\u2796', E' '), (E'\u2797', E' '), (E'\u2798', E' '), (E'\u2799', E' '), (E'\u279a', E' '), (E'\u279b', E' '), (E'\u279c', E' '), (E'\u279d', E' '), (E'\u279e', E' '), (E'\u279f', E' '), (E'\u27a0', E' '), (E'\u27a1', E' '), (E'\u27a2', E' '), (E'\u27a3', E' '), (E'\u27a4', E' '), (E'\u27a5', E' '), (E'\u27a6', E' '), (E'\u27a7', E' '), (E'\u27a8', E' '), (E'\u27a9', E' '), (E'\u27aa', E' '), (E'\u27ab', E' '), (E'\u27ac', E' '), (E'\u27ad', E' '), (E'\u27ae', E' '), (E'\u27af', E' '), (E'\u27b0', E' '), (E'\u27b1', E' '), (E'\u27b2', E' '), (E'\u27b3', E' '), (E'\u27b4', E' '), (E'\u27b5', E' '), (E'\u27b6', E' '), (E'\u27b7', E' '), (E'\u27b8', E' '), (E'\u27b9', E' '), (E'\u27ba', E' '), (E'\u27bb', E' '), (E'\u27bc', E' '), (E'\u27bd', E' '), (E'\u27be', E' '), (E'\u27bf', E' '), (E'\u27c0', E' '), (E'\u27c1', E' '), (E'\u27c2', E' '), (E'\u27c3', E' '), (E'\u27c4', E' '), (E'\u27c5', E' '), (E'\u27c6', E' '), (E'\u27c7', E' '), (E'\u27c8', E' '), (E'\u27c9', E' '), (E'\u27ca', E' '), (E'\u27cb', E' '), (E'\u27cc', E' '), (E'\u27cd', E' '), (E'\u27ce', E' '), (E'\u27cf', E' '), (E'\u27d0', E' '), (E'\u27d1', E' '), (E'\u27d2', E' '), (E'\u27d3', E' '), (E'\u27d4', E' '), (E'\u27d5', E' '), (E'\u27d6', E' '), (E'\u27d7', E' '), (E'\u27d8', E' '), (E'\u27d9', E' '), (E'\u27da', E' '), (E'\u27db', E' '), (E'\u27dc', E' '), (E'\u27dd', E' '), (E'\u27de', E' '), (E'\u27df', E' '), (E'\u27e0', E' '), (E'\u27e1', E' '), (E'\u27e2', E' '), (E'\u27e3', E' '), (E'\u27e4', E' '), (E'\u27e5', E' '), (E'\u27e6', E' '), (E'\u27e7', E' '), (E'\u27e8', E' '), (E'\u27e9', E' '), (E'\u27ea', E' '), (E'\u27eb', E' '), (E'\u27ec', E' '), (E'\u27ed', E' '), (E'\u27ee', E' '), (E'\u27ef', E' '), (E'\u27f0', E' '), (E'\u27f1', E' '), (E'\u27f2', E' '), (E'\u27f3', E' '), (E'\u27f4', E' '), (E'\u27f5', E' '), (E'\u27f6', E' '), (E'\u27f7', E' '), (E'\u27f8', E' '), (E'\u27f9', E' '), (E'\u27fa', E' '), (E'\u27fb', E' '), (E'\u27fc', E' '), (E'\u27fd', E' '), (E'\u27fe', E' '), (E'\u27ff', E' '), (E'\u2800', E' '), (E'\u2801', E' '), (E'\u2802', E' '), (E'\u2803', E' '), (E'\u2804', E' '), (E'\u2805', E' '), (E'\u2806', E' '), (E'\u2807', E' '), (E'\u2808', E' '), (E'\u2809', E' '), (E'\u280a', E' '), (E'\u280b', E' '), (E'\u280c', E' '), (E'\u280d', E' '), (E'\u280e', E' '), (E'\u280f', E' '), (E'\u2810', E' '), (E'\u2811', E' '), (E'\u2812', E' '), (E'\u2813', E' '), (E'\u2814', E' '), (E'\u2815', E' '), (E'\u2816', E' '), (E'\u2817', E' '), (E'\u2818', E' '), (E'\u2819', E' '), (E'\u281a', E' '), (E'\u281b', E' '), (E'\u281c', E' '), (E'\u281d', E' '), (E'\u281e', E' '), (E'\u281f', E' '), (E'\u2820', E' '), (E'\u2821', E' '), (E'\u2822', E' '), (E'\u2823', E' '), (E'\u2824', E' '), (E'\u2825', E' '), (E'\u2826', E' '), (E'\u2827', E' '), (E'\u2828', E' '), (E'\u2829', E' '), (E'\u282a', E' '), (E'\u282b', E' '), (E'\u282c', E' '), (E'\u282d', E' '), (E'\u282e', E' '), (E'\u282f', E' '), (E'\u2830', E' '), (E'\u2831', E' '), (E'\u2832', E' '), (E'\u2833', E' '), (E'\u2834', E' '), (E'\u2835', E' '), (E'\u2836', E' '), (E'\u2837', E' '), (E'\u2838', E' '), (E'\u2839', E' '), (E'\u283a', E' '), (E'\u283b', E' '), (E'\u283c', E' '), (E'\u283d', E' '), (E'\u283e', E' '), (E'\u283f', E' '), (E'\u2840', E' '), (E'\u2841', E' '), (E'\u2842', E' '), (E'\u2843', E' '), (E'\u2844', E' '), (E'\u2845', E' '), (E'\u2846', E' '), (E'\u2847', E' '), (E'\u2848', E' '), (E'\u2849', E' '), (E'\u284a', E' '), (E'\u284b', E' '), (E'\u284c', E' '), (E'\u284d', E' '), (E'\u284e', E' '), (E'\u284f', E' '), (E'\u2850', E' '), (E'\u2851', E' '), (E'\u2852', E' '), (E'\u2853', E' '), (E'\u2854', E' '), (E'\u2855', E' '), (E'\u2856', E' '), (E'\u2857', E' '), (E'\u2858', E' '), (E'\u2859', E' '), (E'\u285a', E' '), (E'\u285b', E' '), (E'\u285c', E' '), (E'\u285d', E' '), (E'\u285e', E' '), (E'\u285f', E' '), (E'\u2860', E' '), (E'\u2861', E' '), (E'\u2862', E' '), (E'\u2863', E' '), (E'\u2864', E' '), (E'\u2865', E' '), (E'\u2866', E' '), (E'\u2867', E' '), (E'\u2868', E' '), (E'\u2869', E' '), (E'\u286a', E' '), (E'\u286b', E' '), (E'\u286c', E' '), (E'\u286d', E' '), (E'\u286e', E' '), (E'\u286f', E' '), (E'\u2870', E' '), (E'\u2871', E' '), (E'\u2872', E' '), (E'\u2873', E' '), (E'\u2874', E' '), (E'\u2875', E' '), (E'\u2876', E' '), (E'\u2877', E' '), (E'\u2878', E' '), (E'\u2879', E' '), (E'\u287a', E' '), (E'\u287b', E' '), (E'\u287c', E' '), (E'\u287d', E' '), (E'\u287e', E' '), (E'\u287f', E' '), (E'\u2880', E' '), (E'\u2881', E' '), (E'\u2882', E' '), (E'\u2883', E' '), (E'\u2884', E' '), (E'\u2885', E' '), (E'\u2886', E' '), (E'\u2887', E' '), (E'\u2888', E' '), (E'\u2889', E' '), (E'\u288a', E' '), (E'\u288b', E' '), (E'\u288c', E' '), (E'\u288d', E' '), (E'\u288e', E' '), (E'\u288f', E' '), (E'\u2890', E' '), (E'\u2891', E' '), (E'\u2892', E' '), (E'\u2893', E' '), (E'\u2894', E' '), (E'\u2895', E' '), (E'\u2896', E' '), (E'\u2897', E' '), (E'\u2898', E' '), (E'\u2899', E' '), (E'\u289a', E' '), (E'\u289b', E' '), (E'\u289c', E' '), (E'\u289d', E' '), (E'\u289e', E' '), (E'\u289f', E' '), (E'\u28a0', E' '), (E'\u28a1', E' '), (E'\u28a2', E' '), (E'\u28a3', E' '), (E'\u28a4', E' '), (E'\u28a5', E' '), (E'\u28a6', E' '), (E'\u28a7', E' '), (E'\u28a8', E' '), (E'\u28a9', E' '), (E'\u28aa', E' '), (E'\u28ab', E' '), (E'\u28ac', E' '), (E'\u28ad', E' '), (E'\u28ae', E' '), (E'\u28af', E' '), (E'\u28b0', E' '), (E'\u28b1', E' '), (E'\u28b2', E' '), (E'\u28b3', E' '), (E'\u28b4', E' '), (E'\u28b5', E' '), (E'\u28b6', E' '), (E'\u28b7', E' '), (E'\u28b8', E' '), (E'\u28b9', E' '), (E'\u28ba', E' '), (E'\u28bb', E' '), (E'\u28bc', E' '), (E'\u28bd', E' '), (E'\u28be', E' '), (E'\u28bf', E' '), (E'\u28c0', E' '), (E'\u28c1', E' '), (E'\u28c2', E' '), (E'\u28c3', E' '), (E'\u28c4', E' '), (E'\u28c5', E' '), (E'\u28c6', E' '), (E'\u28c7', E' '), (E'\u28c8', E' '), (E'\u28c9', E' '), (E'\u28ca', E' '), (E'\u28cb', E' '), (E'\u28cc', E' '), (E'\u28cd', E' '), (E'\u28ce', E' '), (E'\u28cf', E' '), (E'\u28d0', E' '), (E'\u28d1', E' '), (E'\u28d2', E' '), (E'\u28d3', E' '), (E'\u28d4', E' '), (E'\u28d5', E' '), (E'\u28d6', E' '), (E'\u28d7', E' '), (E'\u28d8', E' '), (E'\u28d9', E' '), (E'\u28da', E' '), (E'\u28db', E' '), (E'\u28dc', E' '), (E'\u28dd', E' '), (E'\u28de', E' '), (E'\u28df', E' '), (E'\u28e0', E' '), (E'\u28e1', E' '), (E'\u28e2', E' '), (E'\u28e3', E' '), (E'\u28e4', E' '), (E'\u28e5', E' '), (E'\u28e6', E' '), (E'\u28e7', E' '), (E'\u28e8', E' '), (E'\u28e9', E' '), (E'\u28ea', E' '), (E'\u28eb', E' '), (E'\u28ec', E' '), (E'\u28ed', E' '), (E'\u28ee', E' '), (E'\u28ef', E' '), (E'\u28f0', E' '), (E'\u28f1', E' '), (E'\u28f2', E' '), (E'\u28f3', E' '), (E'\u28f4', E' '), (E'\u28f5', E' '), (E'\u28f6', E' '), (E'\u28f7', E' '), (E'\u28f8', E' '), (E'\u28f9', E' '), (E'\u28fa', E' '), (E'\u28fb', E' '), (E'\u28fc', E' '), (E'\u28fd', E' '), (E'\u28fe', E' '), (E'\u28ff', E' '), (E'\u2900', E' '), (E'\u2901', E' '), (E'\u2902', E' '), (E'\u2903', E' '), (E'\u2904', E' '), (E'\u2905', E' '), (E'\u2906', E' '), (E'\u2907', E' '), (E'\u2908', E' '), (E'\u2909', E' '), (E'\u290a', E' '), (E'\u290b', E' '), (E'\u290c', E' '), (E'\u290d', E' '), (E'\u290e', E' '), (E'\u290f', E' '), (E'\u2910', E' '), (E'\u2911', E' '), (E'\u2912', E' '), (E'\u2913', E' '), (E'\u2914', E' '), (E'\u2915', E' '), (E'\u2916', E' '), (E'\u2917', E' '), (E'\u2918', E' '), (E'\u2919', E' '), (E'\u291a', E' '), (E'\u291b', E' '), (E'\u291c', E' '), (E'\u291d', E' '), (E'\u291e', E' '), (E'\u291f', E' '), (E'\u2920', E' '), (E'\u2921', E' '), (E'\u2922', E' '), (E'\u2923', E' '), (E'\u2924', E' '), (E'\u2925', E' '), (E'\u2926', E' '), (E'\u2927', E' '), (E'\u2928', E' '), (E'\u2929', E' '), (E'\u292a', E' '), (E'\u292b', E' '), (E'\u292c', E' '), (E'\u292d', E' '), (E'\u292e', E' '), (E'\u292f', E' '), (E'\u2930', E' '), (E'\u2931', E' '), (E'\u2932', E' '), (E'\u2933', E' '), (E'\u2934', E' '), (E'\u2935', E' '), (E'\u2936', E' '), (E'\u2937', E' '), (E'\u2938', E' '), (E'\u2939', E' '), (E'\u293a', E' '), (E'\u293b', E' '), (E'\u293c', E' '), (E'\u293d', E' '), (E'\u293e', E' '), (E'\u293f', E' '), (E'\u2940', E' '), (E'\u2941', E' '), (E'\u2942', E' '), (E'\u2943', E' '), (E'\u2944', E' '), (E'\u2945', E' '), (E'\u2946', E' '), (E'\u2947', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u2948', E' '), (E'\u2949', E' '), (E'\u294a', E' '), (E'\u294b', E' '), (E'\u294c', E' '), (E'\u294d', E' '), (E'\u294e', E' '), (E'\u294f', E' '), (E'\u2950', E' '), (E'\u2951', E' '), (E'\u2952', E' '), (E'\u2953', E' '), (E'\u2954', E' '), (E'\u2955', E' '), (E'\u2956', E' '), (E'\u2957', E' '), (E'\u2958', E' '), (E'\u2959', E' '), (E'\u295a', E' '), (E'\u295b', E' '), (E'\u295c', E' '), (E'\u295d', E' '), (E'\u295e', E' '), (E'\u295f', E' '), (E'\u2960', E' '), (E'\u2961', E' '), (E'\u2962', E' '), (E'\u2963', E' '), (E'\u2964', E' '), (E'\u2965', E' '), (E'\u2966', E' '), (E'\u2967', E' '), (E'\u2968', E' '), (E'\u2969', E' '), (E'\u296a', E' '), (E'\u296b', E' '), (E'\u296c', E' '), (E'\u296d', E' '), (E'\u296e', E' '), (E'\u296f', E' '), (E'\u2970', E' '), (E'\u2971', E' '), (E'\u2972', E' '), (E'\u2973', E' '), (E'\u2974', E' '), (E'\u2975', E' '), (E'\u2976', E' '), (E'\u2977', E' '), (E'\u2978', E' '), (E'\u2979', E' '), (E'\u297a', E' '), (E'\u297b', E' '), (E'\u297c', E' '), (E'\u297d', E' '), (E'\u297e', E' '), (E'\u297f', E' '), (E'\u2980', E' '), (E'\u2981', E' '), (E'\u2982', E' '), (E'\u2983', E' '), (E'\u2984', E' '), (E'\u2985', E' '), (E'\u2986', E' '), (E'\u2987', E' '), (E'\u2988', E' '), (E'\u2989', E' '), (E'\u298a', E' '), (E'\u298b', E' '), (E'\u298c', E' '), (E'\u298d', E' '), (E'\u298e', E' '), (E'\u298f', E' '), (E'\u2990', E' '), (E'\u2991', E' '), (E'\u2992', E' '), (E'\u2993', E' '), (E'\u2994', E' '), (E'\u2995', E' '), (E'\u2996', E' '), (E'\u2997', E' '), (E'\u2998', E' '), (E'\u2999', E' '), (E'\u299a', E' '), (E'\u299b', E' '), (E'\u299c', E' '), (E'\u299d', E' '), (E'\u299e', E' '), (E'\u299f', E' '), (E'\u29a0', E' '), (E'\u29a1', E' '), (E'\u29a2', E' '), (E'\u29a3', E' '), (E'\u29a4', E' '), (E'\u29a5', E' '), (E'\u29a6', E' '), (E'\u29a7', E' '), (E'\u29a8', E' '), (E'\u29a9', E' '), (E'\u29aa', E' '), (E'\u29ab', E' '), (E'\u29ac', E' '), (E'\u29ad', E' '), (E'\u29ae', E' '), (E'\u29af', E' '), (E'\u29b0', E' '), (E'\u29b1', E' '), (E'\u29b2', E' '), (E'\u29b3', E' '), (E'\u29b4', E' '), (E'\u29b5', E' '), (E'\u29b6', E' '), (E'\u29b7', E' '), (E'\u29b8', E' '), (E'\u29b9', E' '), (E'\u29ba', E' '), (E'\u29bb', E' '), (E'\u29bc', E' '), (E'\u29bd', E' '), (E'\u29be', E' '), (E'\u29bf', E' '), (E'\u29c0', E' '), (E'\u29c1', E' '), (E'\u29c2', E' '), (E'\u29c3', E' '), (E'\u29c4', E' '), (E'\u29c5', E' '), (E'\u29c6', E' '), (E'\u29c7', E' '), (E'\u29c8', E' '), (E'\u29c9', E' '), (E'\u29ca', E' '), (E'\u29cb', E' '), (E'\u29cc', E' '), (E'\u29cd', E' '), (E'\u29ce', E' '), (E'\u29cf', E' '), (E'\u29d0', E' '), (E'\u29d1', E' '), (E'\u29d2', E' '), (E'\u29d3', E' '), (E'\u29d4', E' '), (E'\u29d5', E' '), (E'\u29d6', E' '), (E'\u29d7', E' '), (E'\u29d8', E' '), (E'\u29d9', E' '), (E'\u29da', E' '), (E'\u29db', E' '), (E'\u29dc', E' '), (E'\u29dd', E' '), (E'\u29de', E' '), (E'\u29df', E' '), (E'\u29e0', E' '), (E'\u29e1', E' '), (E'\u29e2', E' '), (E'\u29e3', E' '), (E'\u29e4', E' '), (E'\u29e5', E' '), (E'\u29e6', E' '), (E'\u29e7', E' '), (E'\u29e8', E' '), (E'\u29e9', E' '), (E'\u29ea', E' '), (E'\u29eb', E' '), (E'\u29ec', E' '), (E'\u29ed', E' '), (E'\u29ee', E' '), (E'\u29ef', E' '), (E'\u29f0', E' '), (E'\u29f1', E' '), (E'\u29f2', E' '), (E'\u29f3', E' '), (E'\u29f4', E' '), (E'\u29f5', E' '), (E'\u29f6', E' '), (E'\u29f7', E' '), (E'\u29f8', E' '), (E'\u29f9', E' '), (E'\u29fa', E' '), (E'\u29fb', E' '), (E'\u29fc', E' '), (E'\u29fd', E' '), (E'\u29fe', E' '), (E'\u29ff', E' '), (E'\u2a00', E' '), (E'\u2a01', E' '), (E'\u2a02', E' '), (E'\u2a03', E' '), (E'\u2a04', E' '), (E'\u2a05', E' '), (E'\u2a06', E' '), (E'\u2a07', E' '), (E'\u2a08', E' '), (E'\u2a09', E' '), (E'\u2a0a', E' '), (E'\u2a0b', E' '), (E'\u2a0c', E' '), (E'\u2a0d', E' '), (E'\u2a0e', E' '), (E'\u2a0f', E' '), (E'\u2a10', E' '), (E'\u2a11', E' '), (E'\u2a12', E' '), (E'\u2a13', E' '), (E'\u2a14', E' '), (E'\u2a15', E' '), (E'\u2a16', E' '), (E'\u2a17', E' '), (E'\u2a18', E' '), (E'\u2a19', E' '), (E'\u2a1a', E' '), (E'\u2a1b', E' '), (E'\u2a1c', E' '), (E'\u2a1d', E' '), (E'\u2a1e', E' '), (E'\u2a1f', E' '), (E'\u2a20', E' '), (E'\u2a21', E' '), (E'\u2a22', E' '), (E'\u2a23', E' '), (E'\u2a24', E' '), (E'\u2a25', E' '), (E'\u2a26', E' '), (E'\u2a27', E' '), (E'\u2a28', E' '), (E'\u2a29', E' '), (E'\u2a2a', E' '), (E'\u2a2b', E' '), (E'\u2a2c', E' '), (E'\u2a2d', E' '), (E'\u2a2e', E' '), (E'\u2a2f', E' '), (E'\u2a30', E' '), (E'\u2a31', E' '), (E'\u2a32', E' '), (E'\u2a33', E' '), (E'\u2a34', E' '), (E'\u2a35', E' '), (E'\u2a36', E' '), (E'\u2a37', E' '), (E'\u2a38', E' '), (E'\u2a39', E' '), (E'\u2a3a', E' '), (E'\u2a3b', E' '), (E'\u2a3c', E' '), (E'\u2a3d', E' '), (E'\u2a3e', E' '), (E'\u2a3f', E' '), (E'\u2a40', E' '), (E'\u2a41', E' '), (E'\u2a42', E' '), (E'\u2a43', E' '), (E'\u2a44', E' '), (E'\u2a45', E' '), (E'\u2a46', E' '), (E'\u2a47', E' '), (E'\u2a48', E' '), (E'\u2a49', E' '), (E'\u2a4a', E' '), (E'\u2a4b', E' '), (E'\u2a4c', E' '), (E'\u2a4d', E' '), (E'\u2a4e', E' '), (E'\u2a4f', E' '), (E'\u2a50', E' '), (E'\u2a51', E' '), (E'\u2a52', E' '), (E'\u2a53', E' '), (E'\u2a54', E' '), (E'\u2a55', E' '), (E'\u2a56', E' '), (E'\u2a57', E' '), (E'\u2a58', E' '), (E'\u2a59', E' '), (E'\u2a5a', E' '), (E'\u2a5b', E' '), (E'\u2a5c', E' '), (E'\u2a5d', E' '), (E'\u2a5e', E' '), (E'\u2a5f', E' '), (E'\u2a60', E' '), (E'\u2a61', E' '), (E'\u2a62', E' '), (E'\u2a63', E' '), (E'\u2a64', E' '), (E'\u2a65', E' '), (E'\u2a66', E' '), (E'\u2a67', E' '), (E'\u2a68', E' '), (E'\u2a69', E' '), (E'\u2a6a', E' '), (E'\u2a6b', E' '), (E'\u2a6c', E' '), (E'\u2a6d', E' '), (E'\u2a6e', E' '), (E'\u2a6f', E' '), (E'\u2a70', E' '), (E'\u2a71', E' '), (E'\u2a72', E' '), (E'\u2a73', E' '), (E'\u2a74', E' '), (E'\u2a75', E' '), (E'\u2a76', E' '), (E'\u2a77', E' '), (E'\u2a78', E' '), (E'\u2a79', E' '), (E'\u2a7a', E' '), (E'\u2a7b', E' '), (E'\u2a7c', E' '), (E'\u2a7d', E' '), (E'\u2a7e', E' '), (E'\u2a7f', E' '), (E'\u2a80', E' '), (E'\u2a81', E' '), (E'\u2a82', E' '), (E'\u2a83', E' '), (E'\u2a84', E' '), (E'\u2a85', E' '), (E'\u2a86', E' '), (E'\u2a87', E' '), (E'\u2a88', E' '), (E'\u2a89', E' '), (E'\u2a8a', E' '), (E'\u2a8b', E' '), (E'\u2a8c', E' '), (E'\u2a8d', E' '), (E'\u2a8e', E' '), (E'\u2a8f', E' '), (E'\u2a90', E' '), (E'\u2a91', E' '), (E'\u2a92', E' '), (E'\u2a93', E' '), (E'\u2a94', E' '), (E'\u2a95', E' '), (E'\u2a96', E' '), (E'\u2a97', E' '), (E'\u2a98', E' '), (E'\u2a99', E' '), (E'\u2a9a', E' '), (E'\u2a9b', E' '), (E'\u2a9c', E' '), (E'\u2a9d', E' '), (E'\u2a9e', E' '), (E'\u2a9f', E' '), (E'\u2aa0', E' '), (E'\u2aa1', E' '), (E'\u2aa2', E' '), (E'\u2aa3', E' '), (E'\u2aa4', E' '), (E'\u2aa5', E' '), (E'\u2aa6', E' '), (E'\u2aa7', E' '), (E'\u2aa8', E' '), (E'\u2aa9', E' '), (E'\u2aaa', E' '), (E'\u2aab', E' '), (E'\u2aac', E' '), (E'\u2aad', E' '), (E'\u2aae', E' '), (E'\u2aaf', E' '), (E'\u2ab0', E' '), (E'\u2ab1', E' '), (E'\u2ab2', E' '), (E'\u2ab3', E' '), (E'\u2ab4', E' '), (E'\u2ab5', E' '), (E'\u2ab6', E' '), (E'\u2ab7', E' '), (E'\u2ab8', E' '), (E'\u2ab9', E' '), (E'\u2aba', E' '), (E'\u2abb', E' '), (E'\u2abc', E' '), (E'\u2abd', E' '), (E'\u2abe', E' '), (E'\u2abf', E' '), (E'\u2ac0', E' '), (E'\u2ac1', E' '), (E'\u2ac2', E' '), (E'\u2ac3', E' '), (E'\u2ac4', E' '), (E'\u2ac5', E' '), (E'\u2ac6', E' '), (E'\u2ac7', E' '), (E'\u2ac8', E' '), (E'\u2ac9', E' '), (E'\u2aca', E' '), (E'\u2acb', E' '), (E'\u2acc', E' '), (E'\u2acd', E' '), (E'\u2ace', E' '), (E'\u2acf', E' '), (E'\u2ad0', E' '), (E'\u2ad1', E' '), (E'\u2ad2', E' '), (E'\u2ad3', E' '), (E'\u2ad4', E' '), (E'\u2ad5', E' '), (E'\u2ad6', E' '), (E'\u2ad7', E' '), (E'\u2ad8', E' '), (E'\u2ad9', E' '), (E'\u2ada', E' '), (E'\u2adb', E' '), (E'\u2adc', E' '), (E'\u2add', E' '), (E'\u2ade', E' '), (E'\u2adf', E' '), (E'\u2ae0', E' '), (E'\u2ae1', E' '), (E'\u2ae2', E' '), (E'\u2ae3', E' '), (E'\u2ae4', E' '), (E'\u2ae5', E' '), (E'\u2ae6', E' '), (E'\u2ae7', E' '), (E'\u2ae8', E' '), (E'\u2ae9', E' '), (E'\u2aea', E' '), (E'\u2aeb', E' '), (E'\u2aec', E' '), (E'\u2aed', E' '), (E'\u2aee', E' '), (E'\u2aef', E' '), (E'\u2af0', E' '), (E'\u2af1', E' '), (E'\u2af2', E' '), (E'\u2af3', E' '), (E'\u2af4', E' '), (E'\u2af5', E' '), (E'\u2af6', E' '), (E'\u2af7', E' '), (E'\u2af8', E' '), (E'\u2af9', E' '), (E'\u2afa', E' '), (E'\u2afb', E' '), (E'\u2afc', E' '), (E'\u2afd', E' '), (E'\u2afe', E' '), (E'\u2aff', E' '), (E'\u2b00', E' '), (E'\u2b01', E' '), (E'\u2b02', E' '), (E'\u2b03', E' '), (E'\u2b04', E' '), (E'\u2b05', E' '), (E'\u2b06', E' '), (E'\u2b07', E' '), (E'\u2b08', E' '), (E'\u2b09', E' '), (E'\u2b0a', E' '), (E'\u2b0b', E' '), (E'\u2b0c', E' '), (E'\u2b0d', E' '), (E'\u2b0e', E' '), (E'\u2b0f', E' '), (E'\u2b10', E' '), (E'\u2b11', E' '), (E'\u2b12', E' '), (E'\u2b13', E' '), (E'\u2b14', E' '), (E'\u2b15', E' '), (E'\u2b16', E' '), (E'\u2b17', E' '), (E'\u2b18', E' '), (E'\u2b19', E' '), (E'\u2b1a', E' '), (E'\u2b1b', E' '), (E'\u2b1c', E' '), (E'\u2b1d', E' '), (E'\u2b1e', E' '), (E'\u2b1f', E' '), (E'\u2b20', E' '), (E'\u2b21', E' '), (E'\u2b22', E' '), (E'\u2b23', E' '), (E'\u2b24', E' '), (E'\u2b25', E' '), (E'\u2b26', E' '), (E'\u2b27', E' '), (E'\u2b28', E' '), (E'\u2b29', E' '), (E'\u2b2a', E' '), (E'\u2b2b', E' '), (E'\u2b2c', E' '), (E'\u2b2d', E' '), (E'\u2b2e', E' '), (E'\u2b2f', E' '), (E'\u2b30', E' '), (E'\u2b31', E' '), (E'\u2b32', E' '), (E'\u2b33', E' '), (E'\u2b34', E' '), (E'\u2b35', E' '), (E'\u2b36', E' '), (E'\u2b37', E' '), (E'\u2b38', E' '), (E'\u2b39', E' '), (E'\u2b3a', E' '), (E'\u2b3b', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u2b3c', E' '), (E'\u2b3d', E' '), (E'\u2b3e', E' '), (E'\u2b3f', E' '), (E'\u2b40', E' '), (E'\u2b41', E' '), (E'\u2b42', E' '), (E'\u2b43', E' '), (E'\u2b44', E' '), (E'\u2b45', E' '), (E'\u2b46', E' '), (E'\u2b47', E' '), (E'\u2b48', E' '), (E'\u2b49', E' '), (E'\u2b4a', E' '), (E'\u2b4b', E' '), (E'\u2b4c', E' '), (E'\u2b50', E' '), (E'\u2b51', E' '), (E'\u2b52', E' '), (E'\u2b53', E' '), (E'\u2b54', E' '), (E'\u2b55', E' '), (E'\u2b56', E' '), (E'\u2b57', E' '), (E'\u2b58', E' '), (E'\u2b59', E' '), (E'\u2ce5', E' '), (E'\u2ce6', E' '), (E'\u2ce7', E' '), (E'\u2ce8', E' '), (E'\u2ce9', E' '), (E'\u2cea', E' '), (E'\u2cf9', E' '), (E'\u2cfa', E' '), (E'\u2cfb', E' '), (E'\u2cfc', E' '), (E'\u2cfe', E' '), (E'\u2cff', E' '), (E'\u2d70', E' '), (E'\u2e00', E' '), (E'\u2e01', E' '), (E'\u2e02', E' '), (E'\u2e03', E' '), (E'\u2e04', E' '), (E'\u2e05', E' '), (E'\u2e06', E' '), (E'\u2e07', E' '), (E'\u2e08', E' '), (E'\u2e09', E' '), (E'\u2e0a', E' '), (E'\u2e0b', E' '), (E'\u2e0c', E' '), (E'\u2e0d', E' '), (E'\u2e0e', E' '), (E'\u2e0f', E' '), (E'\u2e10', E' '), (E'\u2e11', E' '), (E'\u2e12', E' '), (E'\u2e13', E' '), (E'\u2e14', E' '), (E'\u2e15', E' '), (E'\u2e16', E' '), (E'\u2e17', E' '), (E'\u2e18', E' '), (E'\u2e19', E' '), (E'\u2e1a', E' '), (E'\u2e1b', E' '), (E'\u2e1c', E' '), (E'\u2e1d', E' '), (E'\u2e1e', E' '), (E'\u2e1f', E' '), (E'\u2e20', E' '), (E'\u2e21', E' '), (E'\u2e22', E' '), (E'\u2e23', E' '), (E'\u2e24', E' '), (E'\u2e25', E' '), (E'\u2e26', E' '), (E'\u2e27', E' '), (E'\u2e28', E' '), (E'\u2e29', E' '), (E'\u2e2a', E' '), (E'\u2e2b', E' '), (E'\u2e2c', E' '), (E'\u2e2d', E' '), (E'\u2e2e', E' '), (E'\u2e30', E' '), (E'\u2e31', E' '), (E'\u2e32', E' '), (E'\u2e33', E' '), (E'\u2e34', E' '), (E'\u2e35', E' '), (E'\u2e36', E' '), (E'\u2e37', E' '), (E'\u2e38', E' '), (E'\u2e39', E' '), (E'\u2e3a', E' '), (E'\u2e3b', E' '), (E'\u2e80', E' '), (E'\u2e81', E' '), (E'\u2e82', E' '), (E'\u2e83', E' '), (E'\u2e84', E' '), (E'\u2e85', E' '), (E'\u2e86', E' '), (E'\u2e87', E' '), (E'\u2e88', E' '), (E'\u2e89', E' '), (E'\u2e8a', E' '), (E'\u2e8b', E' '), (E'\u2e8c', E' '), (E'\u2e8d', E' '), (E'\u2e8e', E' '), (E'\u2e8f', E' '), (E'\u2e90', E' '), (E'\u2e91', E' '), (E'\u2e92', E' '), (E'\u2e93', E' '), (E'\u2e94', E' '), (E'\u2e95', E' '), (E'\u2e96', E' '), (E'\u2e97', E' '), (E'\u2e98', E' '), (E'\u2e99', E' '), (E'\u2e9b', E' '), (E'\u2e9c', E' '), (E'\u2e9d', E' '), (E'\u2e9e', E' '), (E'\u2e9f', E' '), (E'\u2ea0', E' '), (E'\u2ea1', E' '), (E'\u2ea2', E' '), (E'\u2ea3', E' '), (E'\u2ea4', E' '), (E'\u2ea5', E' '), (E'\u2ea6', E' '), (E'\u2ea7', E' '), (E'\u2ea8', E' '), (E'\u2ea9', E' '), (E'\u2eaa', E' '), (E'\u2eab', E' '), (E'\u2eac', E' '), (E'\u2ead', E' '), (E'\u2eae', E' '), (E'\u2eaf', E' '), (E'\u2eb0', E' '), (E'\u2eb1', E' '), (E'\u2eb2', E' '), (E'\u2eb3', E' '), (E'\u2eb4', E' '), (E'\u2eb5', E' '), (E'\u2eb6', E' '), (E'\u2eb7', E' '), (E'\u2eb8', E' '), (E'\u2eb9', E' '), (E'\u2eba', E' '), (E'\u2ebb', E' '), (E'\u2ebc', E' '), (E'\u2ebd', E' '), (E'\u2ebe', E' '), (E'\u2ebf', E' '), (E'\u2ec0', E' '), (E'\u2ec1', E' '), (E'\u2ec2', E' '), (E'\u2ec3', E' '), (E'\u2ec4', E' '), (E'\u2ec5', E' '), (E'\u2ec6', E' '), (E'\u2ec7', E' '), (E'\u2ec8', E' '), (E'\u2ec9', E' '), (E'\u2eca', E' '), (E'\u2ecb', E' '), (E'\u2ecc', E' '), (E'\u2ecd', E' '), (E'\u2ece', E' '), (E'\u2ecf', E' '), (E'\u2ed0', E' '), (E'\u2ed1', E' '), (E'\u2ed2', E' '), (E'\u2ed3', E' '), (E'\u2ed4', E' '), (E'\u2ed5', E' '), (E'\u2ed6', E' '), (E'\u2ed7', E' '), (E'\u2ed8', E' '), (E'\u2ed9', E' '), (E'\u2eda', E' '), (E'\u2edb', E' '), (E'\u2edc', E' '), (E'\u2edd', E' '), (E'\u2ede', E' '), (E'\u2edf', E' '), (E'\u2ee0', E' '), (E'\u2ee1', E' '), (E'\u2ee2', E' '), (E'\u2ee3', E' '), (E'\u2ee4', E' '), (E'\u2ee5', E' '), (E'\u2ee6', E' '), (E'\u2ee7', E' '), (E'\u2ee8', E' '), (E'\u2ee9', E' '), (E'\u2eea', E' '), (E'\u2eeb', E' '), (E'\u2eec', E' '), (E'\u2eed', E' '), (E'\u2eee', E' '), (E'\u2eef', E' '), (E'\u2ef0', E' '), (E'\u2ef1', E' '), (E'\u2ef2', E' '), (E'\u2ef3', E' '), (E'\u2f00', E' '), (E'\u2f01', E' '), (E'\u2f02', E' '), (E'\u2f03', E' '), (E'\u2f04', E' '), (E'\u2f05', E' '), (E'\u2f06', E' '), (E'\u2f07', E' '), (E'\u2f08', E' '), (E'\u2f09', E' '), (E'\u2f0a', E' '), (E'\u2f0b', E' '), (E'\u2f0c', E' '), (E'\u2f0d', E' '), (E'\u2f0e', E' '), (E'\u2f0f', E' '), (E'\u2f10', E' '), (E'\u2f11', E' '), (E'\u2f12', E' '), (E'\u2f13', E' '), (E'\u2f14', E' '), (E'\u2f15', E' '), (E'\u2f16', E' '), (E'\u2f17', E' '), (E'\u2f18', E' '), (E'\u2f19', E' '), (E'\u2f1a', E' '), (E'\u2f1b', E' '), (E'\u2f1c', E' '), (E'\u2f1d', E' '), (E'\u2f1e', E' '), (E'\u2f1f', E' '), (E'\u2f20', E' '), (E'\u2f21', E' '), (E'\u2f22', E' '), (E'\u2f23', E' '), (E'\u2f24', E' '), (E'\u2f25', E' '), (E'\u2f26', E' '), (E'\u2f27', E' '), (E'\u2f28', E' '), (E'\u2f29', E' '), (E'\u2f2a', E' '), (E'\u2f2b', E' '), (E'\u2f2c', E' '), (E'\u2f2d', E' '), (E'\u2f2e', E' '), (E'\u2f2f', E' '), (E'\u2f30', E' '), (E'\u2f31', E' '), (E'\u2f32', E' '), (E'\u2f33', E' '), (E'\u2f34', E' '), (E'\u2f35', E' '), (E'\u2f36', E' '), (E'\u2f37', E' '), (E'\u2f38', E' '), (E'\u2f39', E' '), (E'\u2f3a', E' '), (E'\u2f3b', E' '), (E'\u2f3c', E' '), (E'\u2f3d', E' '), (E'\u2f3e', E' '), (E'\u2f3f', E' '), (E'\u2f40', E' '), (E'\u2f41', E' '), (E'\u2f42', E' '), (E'\u2f43', E' '), (E'\u2f44', E' '), (E'\u2f45', E' '), (E'\u2f46', E' '), (E'\u2f47', E' '), (E'\u2f48', E' '), (E'\u2f49', E' '), (E'\u2f4a', E' '), (E'\u2f4b', E' '), (E'\u2f4c', E' '), (E'\u2f4d', E' '), (E'\u2f4e', E' '), (E'\u2f4f', E' '), (E'\u2f50', E' '), (E'\u2f51', E' '), (E'\u2f52', E' '), (E'\u2f53', E' '), (E'\u2f54', E' '), (E'\u2f55', E' '), (E'\u2f56', E' '), (E'\u2f57', E' '), (E'\u2f58', E' '), (E'\u2f59', E' '), (E'\u2f5a', E' '), (E'\u2f5b', E' '), (E'\u2f5c', E' '), (E'\u2f5d', E' '), (E'\u2f5e', E' '), (E'\u2f5f', E' '), (E'\u2f60', E' '), (E'\u2f61', E' '), (E'\u2f62', E' '), (E'\u2f63', E' '), (E'\u2f64', E' '), (E'\u2f65', E' '), (E'\u2f66', E' '), (E'\u2f67', E' '), (E'\u2f68', E' '), (E'\u2f69', E' '), (E'\u2f6a', E' '), (E'\u2f6b', E' '), (E'\u2f6c', E' '), (E'\u2f6d', E' '), (E'\u2f6e', E' '), (E'\u2f6f', E' '), (E'\u2f70', E' '), (E'\u2f71', E' '), (E'\u2f72', E' '), (E'\u2f73', E' '), (E'\u2f74', E' '), (E'\u2f75', E' '), (E'\u2f76', E' '), (E'\u2f77', E' '), (E'\u2f78', E' '), (E'\u2f79', E' '), (E'\u2f7a', E' '), (E'\u2f7b', E' '), (E'\u2f7c', E' '), (E'\u2f7d', E' '), (E'\u2f7e', E' '), (E'\u2f7f', E' '), (E'\u2f80', E' '), (E'\u2f81', E' '), (E'\u2f82', E' '), (E'\u2f83', E' '), (E'\u2f84', E' '), (E'\u2f85', E' '), (E'\u2f86', E' '), (E'\u2f87', E' '), (E'\u2f88', E' '), (E'\u2f89', E' '), (E'\u2f8a', E' '), (E'\u2f8b', E' '), (E'\u2f8c', E' '), (E'\u2f8d', E' '), (E'\u2f8e', E' '), (E'\u2f8f', E' '), (E'\u2f90', E' '), (E'\u2f91', E' '), (E'\u2f92', E' '), (E'\u2f93', E' '), (E'\u2f94', E' '), (E'\u2f95', E' '), (E'\u2f96', E' '), (E'\u2f97', E' '), (E'\u2f98', E' '), (E'\u2f99', E' '), (E'\u2f9a', E' '), (E'\u2f9b', E' '), (E'\u2f9c', E' '), (E'\u2f9d', E' '), (E'\u2f9e', E' '), (E'\u2f9f', E' '), (E'\u2fa0', E' '), (E'\u2fa1', E' '), (E'\u2fa2', E' '), (E'\u2fa3', E' '), (E'\u2fa4', E' '), (E'\u2fa5', E' '), (E'\u2fa6', E' '), (E'\u2fa7', E' '), (E'\u2fa8', E' '), (E'\u2fa9', E' '), (E'\u2faa', E' '), (E'\u2fab', E' '), (E'\u2fac', E' '), (E'\u2fad', E' '), (E'\u2fae', E' '), (E'\u2faf', E' '), (E'\u2fb0', E' '), (E'\u2fb1', E' '), (E'\u2fb2', E' '), (E'\u2fb3', E' '), (E'\u2fb4', E' '), (E'\u2fb5', E' '), (E'\u2fb6', E' '), (E'\u2fb7', E' '), (E'\u2fb8', E' '), (E'\u2fb9', E' '), (E'\u2fba', E' '), (E'\u2fbb', E' '), (E'\u2fbc', E' '), (E'\u2fbd', E' '), (E'\u2fbe', E' '), (E'\u2fbf', E' '), (E'\u2fc0', E' '), (E'\u2fc1', E' '), (E'\u2fc2', E' '), (E'\u2fc3', E' '), (E'\u2fc4', E' '), (E'\u2fc5', E' '), (E'\u2fc6', E' '), (E'\u2fc7', E' '), (E'\u2fc8', E' '), (E'\u2fc9', E' '), (E'\u2fca', E' '), (E'\u2fcb', E' '), (E'\u2fcc', E' '), (E'\u2fcd', E' '), (E'\u2fce', E' '), (E'\u2fcf', E' '), (E'\u2fd0', E' '), (E'\u2fd1', E' '), (E'\u2fd2', E' '), (E'\u2fd3', E' '), (E'\u2fd4', E' '), (E'\u2fd5', E' '), (E'\u2ff0', E' '), (E'\u2ff1', E' '), (E'\u2ff2', E' '), (E'\u2ff3', E' '), (E'\u2ff4', E' '), (E'\u2ff5', E' '), (E'\u2ff6', E' '), (E'\u2ff7', E' '), (E'\u2ff8', E' '), (E'\u2ff9', E' '), (E'\u2ffa', E' '), (E'\u2ffb', E' '), (E'\u3000', E' '), (E'\u3001', E' '), (E'\u3002', E' '), (E'\u3003', E' '), (E'\u3004', E' '), (E'\u3008', E' '), (E'\u3009', E' '), (E'\u300a', E' '), (E'\u300b', E' '), (E'\u300c', E' '), (E'\u300d', E' '), (E'\u300e', E' '), (E'\u300f', E' '), (E'\u3010', E' '), (E'\u3011', E' '), (E'\u3012', E' '), (E'\u3013', E' '), (E'\u3014', E' '), (E'\u3015', E' '), (E'\u3016', E' '), (E'\u3017', E' '), (E'\u3018', E' '), (E'\u3019', E' '), (E'\u301a', E' '), (E'\u301b', E' '), (E'\u301c', E' '), (E'\u301d', E' '), (E'\u301e', E' '), (E'\u301f', E' '), (E'\u3020', E' '), (E'\u3030', E' '), (E'\u3036', E' '), (E'\u3037', E' '), (E'\u303d', E' '), (E'\u303e', E' '), (E'\u303f', E' '), (E'\u309b', E' '), (E'\u309c', E' '), (E'\u30a0', E' '), (E'\u30fb', E' '), (E'\u3190', E' '), (E'\u3191', E' '), (E'\u3196', E' '), (E'\u3197', E' '), (E'\u3198', E' '), (E'\u3199', E' '), (E'\u319a', E' '), (E'\u319b', E' '), (E'\u319c', E' '), (E'\u319d', E' '), (E'\u319e', E' '), (E'\u319f', E' '), (E'\u31c0', E' '), (E'\u31c1', E' '), (E'\u31c2', E' '), (E'\u31c3', E' '), (E'\u31c4', E' '), (E'\u31c5', E' '), (E'\u31c6', E' '), (E'\u31c7', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u31c8', E' '), (E'\u31c9', E' '), (E'\u31ca', E' '), (E'\u31cb', E' '), (E'\u31cc', E' '), (E'\u31cd', E' '), (E'\u31ce', E' '), (E'\u31cf', E' '), (E'\u31d0', E' '), (E'\u31d1', E' '), (E'\u31d2', E' '), (E'\u31d3', E' '), (E'\u31d4', E' '), (E'\u31d5', E' '), (E'\u31d6', E' '), (E'\u31d7', E' '), (E'\u31d8', E' '), (E'\u31d9', E' '), (E'\u31da', E' '), (E'\u31db', E' '), (E'\u31dc', E' '), (E'\u31dd', E' '), (E'\u31de', E' '), (E'\u31df', E' '), (E'\u31e0', E' '), (E'\u31e1', E' '), (E'\u31e2', E' '), (E'\u31e3', E' '), (E'\u3200', E' '), (E'\u3201', E' '), (E'\u3202', E' '), (E'\u3203', E' '), (E'\u3204', E' '), (E'\u3205', E' '), (E'\u3206', E' '), (E'\u3207', E' '), (E'\u3208', E' '), (E'\u3209', E' '), (E'\u320a', E' '), (E'\u320b', E' '), (E'\u320c', E' '), (E'\u320d', E' '), (E'\u320e', E' '), (E'\u320f', E' '), (E'\u3210', E' '), (E'\u3211', E' '), (E'\u3212', E' '), (E'\u3213', E' '), (E'\u3214', E' '), (E'\u3215', E' '), (E'\u3216', E' '), (E'\u3217', E' '), (E'\u3218', E' '), (E'\u3219', E' '), (E'\u321a', E' '), (E'\u321b', E' '), (E'\u321c', E' '), (E'\u321d', E' '), (E'\u321e', E' '), (E'\u322a', E' '), (E'\u322b', E' '), (E'\u322c', E' '), (E'\u322d', E' '), (E'\u322e', E' '), (E'\u322f', E' '), (E'\u3230', E' '), (E'\u3231', E' '), (E'\u3232', E' '), (E'\u3233', E' '), (E'\u3234', E' '), (E'\u3235', E' '), (E'\u3236', E' '), (E'\u3237', E' '), (E'\u3238', E' '), (E'\u3239', E' '), (E'\u323a', E' '), (E'\u323b', E' '), (E'\u323c', E' '), (E'\u323d', E' '), (E'\u323e', E' '), (E'\u323f', E' '), (E'\u3240', E' '), (E'\u3241', E' '), (E'\u3242', E' '), (E'\u3243', E' '), (E'\u3244', E' '), (E'\u3245', E' '), (E'\u3246', E' '), (E'\u3247', E' '), (E'\u3250', E' '), (E'\u3260', E' '), (E'\u3261', E' '), (E'\u3262', E' '), (E'\u3263', E' '), (E'\u3264', E' '), (E'\u3265', E' '), (E'\u3266', E' '), (E'\u3267', E' '), (E'\u3268', E' '), (E'\u3269', E' '), (E'\u326a', E' '), (E'\u326b', E' '), (E'\u326c', E' '), (E'\u326d', E' '), (E'\u326e', E' '), (E'\u326f', E' '), (E'\u3270', E' '), (E'\u3271', E' '), (E'\u3272', E' '), (E'\u3273', E' '), (E'\u3274', E' '), (E'\u3275', E' '), (E'\u3276', E' '), (E'\u3277', E' '), (E'\u3278', E' '), (E'\u3279', E' '), (E'\u327a', E' '), (E'\u327b', E' '), (E'\u327c', E' '), (E'\u327d', E' '), (E'\u327e', E' '), (E'\u327f', E' '), (E'\u328a', E' '), (E'\u328b', E' '), (E'\u328c', E' '), (E'\u328d', E' '), (E'\u328e', E' '), (E'\u328f', E' '), (E'\u3290', E' '), (E'\u3291', E' '), (E'\u3292', E' '), (E'\u3293', E' '), (E'\u3294', E' '), (E'\u3295', E' '), (E'\u3296', E' '), (E'\u3297', E' '), (E'\u3298', E' '), (E'\u3299', E' '), (E'\u329a', E' '), (E'\u329b', E' '), (E'\u329c', E' '), (E'\u329d', E' '), (E'\u329e', E' '), (E'\u329f', E' '), (E'\u32a0', E' '), (E'\u32a1', E' '), (E'\u32a2', E' '), (E'\u32a3', E' '), (E'\u32a4', E' '), (E'\u32a5', E' '), (E'\u32a6', E' '), (E'\u32a7', E' '), (E'\u32a8', E' '), (E'\u32a9', E' '), (E'\u32aa', E' '), (E'\u32ab', E' '), (E'\u32ac', E' '), (E'\u32ad', E' '), (E'\u32ae', E' '), (E'\u32af', E' '), (E'\u32b0', E' '), (E'\u32c0', E' '), (E'\u32c1', E' '), (E'\u32c2', E' '), (E'\u32c3', E' '), (E'\u32c4', E' '), (E'\u32c5', E' '), (E'\u32c6', E' '), (E'\u32c7', E' '), (E'\u32c8', E' '), (E'\u32c9', E' '), (E'\u32ca', E' '), (E'\u32cb', E' '), (E'\u32cc', E' '), (E'\u32cd', E' '), (E'\u32ce', E' '), (E'\u32cf', E' '), (E'\u32d0', E' '), (E'\u32d1', E' '), (E'\u32d2', E' '), (E'\u32d3', E' '), (E'\u32d4', E' '), (E'\u32d5', E' '), (E'\u32d6', E' '), (E'\u32d7', E' '), (E'\u32d8', E' '), (E'\u32d9', E' '), (E'\u32da', E' '), (E'\u32db', E' '), (E'\u32dc', E' '), (E'\u32dd', E' '), (E'\u32de', E' '), (E'\u32df', E' '), (E'\u32e0', E' '), (E'\u32e1', E' '), (E'\u32e2', E' '), (E'\u32e3', E' '), (E'\u32e4', E' '), (E'\u32e5', E' '), (E'\u32e6', E' '), (E'\u32e7', E' '), (E'\u32e8', E' '), (E'\u32e9', E' '), (E'\u32ea', E' '), (E'\u32eb', E' '), (E'\u32ec', E' '), (E'\u32ed', E' '), (E'\u32ee', E' '), (E'\u32ef', E' '), (E'\u32f0', E' '), (E'\u32f1', E' '), (E'\u32f2', E' '), (E'\u32f3', E' '), (E'\u32f4', E' '), (E'\u32f5', E' '), (E'\u32f6', E' '), (E'\u32f7', E' '), (E'\u32f8', E' '), (E'\u32f9', E' '), (E'\u32fa', E' '), (E'\u32fb', E' '), (E'\u32fc', E' '), (E'\u32fd', E' '), (E'\u32fe', E' '), (E'\u3300', E' '), (E'\u3301', E' '), (E'\u3302', E' '), (E'\u3303', E' '), (E'\u3304', E' '), (E'\u3305', E' '), (E'\u3306', E' '), (E'\u3307', E' '), (E'\u3308', E' '), (E'\u3309', E' '), (E'\u330a', E' '), (E'\u330b', E' '), (E'\u330c', E' '), (E'\u330d', E' '), (E'\u330e', E' '), (E'\u330f', E' '), (E'\u3310', E' '), (E'\u3311', E' '), (E'\u3312', E' '), (E'\u3313', E' '), (E'\u3314', E' '), (E'\u3315', E' '), (E'\u3316', E' '), (E'\u3317', E' '), (E'\u3318', E' '), (E'\u3319', E' '), (E'\u331a', E' '), (E'\u331b', E' '), (E'\u331c', E' '), (E'\u331d', E' '), (E'\u331e', E' '), (E'\u331f', E' '), (E'\u3320', E' '), (E'\u3321', E' '), (E'\u3322', E' '), (E'\u3323', E' '), (E'\u3324', E' '), (E'\u3325', E' '), (E'\u3326', E' '), (E'\u3327', E' '), (E'\u3328', E' '), (E'\u3329', E' '), (E'\u332a', E' '), (E'\u332b', E' '), (E'\u332c', E' '), (E'\u332d', E' '), (E'\u332e', E' '), (E'\u332f', E' '), (E'\u3330', E' '), (E'\u3331', E' '), (E'\u3332', E' '), (E'\u3333', E' '), (E'\u3334', E' '), (E'\u3335', E' '), (E'\u3336', E' '), (E'\u3337', E' '), (E'\u3338', E' '), (E'\u3339', E' '), (E'\u333a', E' '), (E'\u333b', E' '), (E'\u333c', E' '), (E'\u333d', E' '), (E'\u333e', E' '), (E'\u333f', E' '), (E'\u3340', E' '), (E'\u3341', E' '), (E'\u3342', E' '), (E'\u3343', E' '), (E'\u3344', E' '), (E'\u3345', E' '), (E'\u3346', E' '), (E'\u3347', E' '), (E'\u3348', E' '), (E'\u3349', E' '), (E'\u334a', E' '), (E'\u334b', E' '), (E'\u334c', E' '), (E'\u334d', E' '), (E'\u334e', E' '), (E'\u334f', E' '), (E'\u3350', E' '), (E'\u3351', E' '), (E'\u3352', E' '), (E'\u3353', E' '), (E'\u3354', E' '), (E'\u3355', E' '), (E'\u3356', E' '), (E'\u3357', E' '), (E'\u3358', E' '), (E'\u3359', E' '), (E'\u335a', E' '), (E'\u335b', E' '), (E'\u335c', E' '), (E'\u335d', E' '), (E'\u335e', E' '), (E'\u335f', E' '), (E'\u3360', E' '), (E'\u3361', E' '), (E'\u3362', E' '), (E'\u3363', E' '), (E'\u3364', E' '), (E'\u3365', E' '), (E'\u3366', E' '), (E'\u3367', E' '), (E'\u3368', E' '), (E'\u3369', E' '), (E'\u336a', E' '), (E'\u336b', E' '), (E'\u336c', E' '), (E'\u336d', E' '), (E'\u336e', E' '), (E'\u336f', E' '), (E'\u3370', E' '), (E'\u3371', E' '), (E'\u3372', E' '), (E'\u3373', E' '), (E'\u3374', E' '), (E'\u3375', E' '), (E'\u3376', E' '), (E'\u3377', E' '), (E'\u3378', E' '), (E'\u3379', E' '), (E'\u337a', E' '), (E'\u337b', E' '), (E'\u337c', E' '), (E'\u337d', E' '), (E'\u337e', E' '), (E'\u337f', E' '), (E'\u3380', E' '), (E'\u3381', E' '), (E'\u3382', E' '), (E'\u3383', E' '), (E'\u3384', E' '), (E'\u3385', E' '), (E'\u3386', E' '), (E'\u3387', E' '), (E'\u3388', E' '), (E'\u3389', E' '), (E'\u338a', E' '), (E'\u338b', E' '), (E'\u338c', E' '), (E'\u338d', E' '), (E'\u338e', E' '), (E'\u338f', E' '), (E'\u3390', E' '), (E'\u3391', E' '), (E'\u3392', E' '), (E'\u3393', E' '), (E'\u3394', E' '), (E'\u3395', E' '), (E'\u3396', E' '), (E'\u3397', E' '), (E'\u3398', E' '), (E'\u3399', E' '), (E'\u339a', E' '), (E'\u339b', E' '), (E'\u339c', E' '), (E'\u339d', E' '), (E'\u339e', E' '), (E'\u339f', E' '), (E'\u33a0', E' '), (E'\u33a1', E' '), (E'\u33a2', E' '), (E'\u33a3', E' '), (E'\u33a4', E' '), (E'\u33a5', E' '), (E'\u33a6', E' '), (E'\u33a7', E' '), (E'\u33a8', E' '), (E'\u33a9', E' '), (E'\u33aa', E' '), (E'\u33ab', E' '), (E'\u33ac', E' '), (E'\u33ad', E' '), (E'\u33ae', E' '), (E'\u33af', E' '), (E'\u33b0', E' '), (E'\u33b1', E' '), (E'\u33b2', E' '), (E'\u33b3', E' '), (E'\u33b4', E' '), (E'\u33b5', E' '), (E'\u33b6', E' '), (E'\u33b7', E' '), (E'\u33b8', E' '), (E'\u33b9', E' '), (E'\u33ba', E' '), (E'\u33bb', E' '), (E'\u33bc', E' '), (E'\u33bd', E' '), (E'\u33be', E' '), (E'\u33bf', E' '), (E'\u33c0', E' '), (E'\u33c1', E' '), (E'\u33c2', E' '), (E'\u33c3', E' '), (E'\u33c4', E' '), (E'\u33c5', E' '), (E'\u33c6', E' '), (E'\u33c7', E' '), (E'\u33c8', E' '), (E'\u33c9', E' '), (E'\u33ca', E' '), (E'\u33cb', E' '), (E'\u33cc', E' '), (E'\u33cd', E' '), (E'\u33ce', E' '), (E'\u33cf', E' '), (E'\u33d0', E' '), (E'\u33d1', E' '), (E'\u33d2', E' '), (E'\u33d3', E' '), (E'\u33d4', E' '), (E'\u33d5', E' '), (E'\u33d6', E' '), (E'\u33d7', E' '), (E'\u33d8', E' '), (E'\u33d9', E' '), (E'\u33da', E' '), (E'\u33db', E' '), (E'\u33dc', E' '), (E'\u33dd', E' '), (E'\u33de', E' '), (E'\u33df', E' '), (E'\u33e0', E' '), (E'\u33e1', E' '), (E'\u33e2', E' '), (E'\u33e3', E' '), (E'\u33e4', E' '), (E'\u33e5', E' '), (E'\u33e6', E' '), (E'\u33e7', E' '), (E'\u33e8', E' '), (E'\u33e9', E' '), (E'\u33ea', E' '), (E'\u33eb', E' '), (E'\u33ec', E' '), (E'\u33ed', E' '), (E'\u33ee', E' '), (E'\u33ef', E' '), (E'\u33f0', E' '), (E'\u33f1', E' '), (E'\u33f2', E' '), (E'\u33f3', E' '), (E'\u33f4', E' '), (E'\u33f5', E' '), (E'\u33f6', E' '), (E'\u33f7', E' '), (E'\u33f8', E' '), (E'\u33f9', E' '), (E'\u33fa', E' '), (E'\u33fb', E' '), (E'\u33fc', E' '), (E'\u33fd', E' '), (E'\u33fe', E' '), (E'\u33ff', E' '), (E'\u4dc0', E' '), (E'\u4dc1', E' '), (E'\u4dc2', E' '), (E'\u4dc3', E' '), (E'\u4dc4', E' '), (E'\u4dc5', E' '), (E'\u4dc6', E' '), (E'\u4dc7', E' '), (E'\u4dc8', E' '), (E'\u4dc9', E' '), (E'\u4dca', E' '), (E'\u4dcb', E' '), (E'\u4dcc', E' '), (E'\u4dcd', E' '), (E'\u4dce', E' '), (E'\u4dcf', E' '), (E'\u4dd0', E' '), (E'\u4dd1', E' '), (E'\u4dd2', E' '), (E'\u4dd3', E' ');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u4dd4', E' '), (E'\u4dd5', E' '), (E'\u4dd6', E' '), (E'\u4dd7', E' '), (E'\u4dd8', E' '), (E'\u4dd9', E' '), (E'\u4dda', E' '), (E'\u4ddb', E' '), (E'\u4ddc', E' '), (E'\u4ddd', E' '), (E'\u4dde', E' '), (E'\u4ddf', E' '), (E'\u4de0', E' '), (E'\u4de1', E' '), (E'\u4de2', E' '), (E'\u4de3', E' '), (E'\u4de4', E' '), (E'\u4de5', E' '), (E'\u4de6', E' '), (E'\u4de7', E' '), (E'\u4de8', E' '), (E'\u4de9', E' '), (E'\u4dea', E' '), (E'\u4deb', E' '), (E'\u4dec', E' '), (E'\u4ded', E' '), (E'\u4dee', E' '), (E'\u4def', E' '), (E'\u4df0', E' '), (E'\u4df1', E' '), (E'\u4df2', E' '), (E'\u4df3', E' '), (E'\u4df4', E' '), (E'\u4df5', E' '), (E'\u4df6', E' '), (E'\u4df7', E' '), (E'\u4df8', E' '), (E'\u4df9', E' '), (E'\u4dfa', E' '), (E'\u4dfb', E' '), (E'\u4dfc', E' '), (E'\u4dfd', E' '), (E'\u4dfe', E' '), (E'\u4dff', E' '), (E'\ua490', E' '), (E'\ua491', E' '), (E'\ua492', E' '), (E'\ua493', E' '), (E'\ua494', E' '), (E'\ua495', E' '), (E'\ua496', E' '), (E'\ua497', E' '), (E'\ua498', E' '), (E'\ua499', E' '), (E'\ua49a', E' '), (E'\ua49b', E' '), (E'\ua49c', E' '), (E'\ua49d', E' '), (E'\ua49e', E' '), (E'\ua49f', E' '), (E'\ua4a0', E' '), (E'\ua4a1', E' '), (E'\ua4a2', E' '), (E'\ua4a3', E' '), (E'\ua4a4', E' '), (E'\ua4a5', E' '), (E'\ua4a6', E' '), (E'\ua4a7', E' '), (E'\ua4a8', E' '), (E'\ua4a9', E' '), (E'\ua4aa', E' '), (E'\ua4ab', E' '), (E'\ua4ac', E' '), (E'\ua4ad', E' '), (E'\ua4ae', E' '), (E'\ua4af', E' '), (E'\ua4b0', E' '), (E'\ua4b1', E' '), (E'\ua4b2', E' '), (E'\ua4b3', E' '), (E'\ua4b4', E' '), (E'\ua4b5', E' '), (E'\ua4b6', E' '), (E'\ua4b7', E' '), (E'\ua4b8', E' '), (E'\ua4b9', E' '), (E'\ua4ba', E' '), (E'\ua4bb', E' '), (E'\ua4bc', E' '), (E'\ua4bd', E' '), (E'\ua4be', E' '), (E'\ua4bf', E' '), (E'\ua4c0', E' '), (E'\ua4c1', E' '), (E'\ua4c2', E' '), (E'\ua4c3', E' '), (E'\ua4c4', E' '), (E'\ua4c5', E' '), (E'\ua4c6', E' '), (E'\ua4fe', E' '), (E'\ua4ff', E' '), (E'\ua60d', E' '), (E'\ua60e', E' '), (E'\ua60f', E' '), (E'\ua670', E' '), (E'\ua671', E' '), (E'\ua672', E' '), (E'\ua673', E' '), (E'\ua67e', E' '), (E'\ua6f2', E' '), (E'\ua6f3', E' '), (E'\ua6f4', E' '), (E'\ua6f5', E' '), (E'\ua6f6', E' '), (E'\ua6f7', E' '), (E'\ua700', E' '), (E'\ua701', E' '), (E'\ua702', E' '), (E'\ua703', E' '), (E'\ua704', E' '), (E'\ua705', E' '), (E'\ua706', E' '), (E'\ua707', E' '), (E'\ua708', E' '), (E'\ua709', E' '), (E'\ua70a', E' '), (E'\ua70b', E' '), (E'\ua70c', E' '), (E'\ua70d', E' '), (E'\ua70e', E' '), (E'\ua70f', E' '), (E'\ua710', E' '), (E'\ua711', E' '), (E'\ua712', E' '), (E'\ua713', E' '), (E'\ua714', E' '), (E'\ua715', E' '), (E'\ua716', E' '), (E'\ua720', E' '), (E'\ua721', E' '), (E'\ua789', E' '), (E'\ua78a', E' '), (E'\ua828', E' '), (E'\ua829', E' '), (E'\ua82a', E' '), (E'\ua82b', E' '), (E'\ua836', E' '), (E'\ua837', E' '), (E'\ua838', E' '), (E'\ua839', E' '), (E'\ua874', E' '), (E'\ua875', E' '), (E'\ua876', E' '), (E'\ua877', E' '), (E'\ua8ce', E' '), (E'\ua8cf', E' '), (E'\ua8f8', E' '), (E'\ua8f9', E' '), (E'\ua8fa', E' '), (E'\ua92e', E' '), (E'\ua92f', E' '), (E'\ua95f', E' '), (E'\ua9c1', E' '), (E'\ua9c2', E' '), (E'\ua9c3', E' '), (E'\ua9c4', E' '), (E'\ua9c5', E' '), (E'\ua9c6', E' '), (E'\ua9c7', E' '), (E'\ua9c8', E' '), (E'\ua9c9', E' '), (E'\ua9ca', E' '), (E'\ua9cb', E' '), (E'\ua9cc', E' '), (E'\ua9cd', E' '), (E'\ua9de', E' '), (E'\ua9df', E' '), (E'\uaa5c', E' '), (E'\uaa5d', E' '), (E'\uaa5e', E' '), (E'\uaa5f', E' '), (E'\uaa77', E' '), (E'\uaa78', E' '), (E'\uaa79', E' '), (E'\uaade', E' '), (E'\uaadf', E' '), (E'\uaaf0', E' '), (E'\uaaf1', E' '), (E'\uabeb', E' '), (E'\ufb29', E' '), (E'\ufbb2', E' '), (E'\ufbb3', E' '), (E'\ufbb4', E' '), (E'\ufbb5', E' '), (E'\ufbb6', E' '), (E'\ufbb7', E' '), (E'\ufbb8', E' '), (E'\ufbb9', E' '), (E'\ufbba', E' '), (E'\ufbbb', E' '), (E'\ufbbc', E' '), (E'\ufbbd', E' '), (E'\ufbbe', E' '), (E'\ufbbf', E' '), (E'\ufbc0', E' '), (E'\ufbc1', E' '), (E'\ufd3e', E' '), (E'\ufd3f', E' '), (E'\ufdfc', E' '), (E'\ufdfd', E' '), (E'\ufe10', E' '), (E'\ufe11', E' '), (E'\ufe12', E' '), (E'\ufe13', E' '), (E'\ufe14', E' '), (E'\ufe15', E' '), (E'\ufe16', E' '), (E'\ufe17', E' '), (E'\ufe18', E' '), (E'\ufe19', E' '), (E'\ufe30', E' '), (E'\ufe31', E' '), (E'\ufe32', E' '), (E'\ufe33', E' '), (E'\ufe34', E' '), (E'\ufe35', E' '), (E'\ufe36', E' '), (E'\ufe37', E' '), (E'\ufe38', E' '), (E'\ufe39', E' '), (E'\ufe3a', E' '), (E'\ufe3b', E' '), (E'\ufe3c', E' '), (E'\ufe3d', E' '), (E'\ufe3e', E' '), (E'\ufe3f', E' '), (E'\ufe40', E' '), (E'\ufe41', E' '), (E'\ufe42', E' '), (E'\ufe43', E' '), (E'\ufe44', E' '), (E'\ufe45', E' '), (E'\ufe46', E' '), (E'\ufe47', E' '), (E'\ufe48', E' '), (E'\ufe49', E' '), (E'\ufe4a', E' '), (E'\ufe4b', E' '), (E'\ufe4c', E' '), (E'\ufe4d', E' '), (E'\ufe4e', E' '), (E'\ufe4f', E' '), (E'\ufe50', E' '), (E'\ufe51', E' '), (E'\ufe52', E' '), (E'\ufe54', E' '), (E'\ufe55', E' '), (E'\ufe56', E' '), (E'\ufe57', E' '), (E'\ufe58', E' '), (E'\ufe59', E' '), (E'\ufe5a', E' '), (E'\ufe5b', E' '), (E'\ufe5c', E' '), (E'\ufe5d', E' '), (E'\ufe5e', E' '), (E'\ufe5f', E' '), (E'\ufe60', E' '), (E'\ufe61', E' '), (E'\ufe62', E' '), (E'\ufe63', E' '), (E'\ufe64', E' '), (E'\ufe65', E' '), (E'\ufe66', E' '), (E'\ufe68', E' '), (E'\ufe69', E' '), (E'\ufe6a', E' '), (E'\ufe6b', E' '), (E'\ufeff', E' '), (E'\uff01', E' '), (E'\uff02', E' '), (E'\uff03', E' '), (E'\uff04', E' '), (E'\uff05', E' '), (E'\uff06', E' '), (E'\uff07', E' '), (E'\uff08', E' '), (E'\uff09', E' '), (E'\uff0a', E' '), (E'\uff0b', E' '), (E'\uff0c', E' '), (E'\uff0d', E' '), (E'\uff0e', E' '), (E'\uff0f', E' '), (E'\uff1a', E' '), (E'\uff1b', E' '), (E'\uff1c', E' '), (E'\uff1d', E' '), (E'\uff1e', E' '), (E'\uff1f', E' '), (E'\uff20', E' '), (E'\uff3b', E' '), (E'\uff3c', E' '), (E'\uff3d', E' '), (E'\uff3e', E' '), (E'\uff3f', E' '), (E'\uff40', E' '), (E'\uff5b', E' '), (E'\uff5c', E' '), (E'\uff5d', E' '), (E'\uff5e', E' '), (E'\uff5f', E' '), (E'\uff60', E' '), (E'\uff61', E' '), (E'\uff62', E' '), (E'\uff63', E' '), (E'\uff64', E' '), (E'\uff65', E' '), (E'\uffe0', E' '), (E'\uffe1', E' '), (E'\uffe2', E' '), (E'\uffe3', E' '), (E'\uffe4', E' '), (E'\uffe5', E' '), (E'\uffe6', E' '), (E'\uffe8', E' '), (E'\uffe9', E' '), (E'\uffea', E' '), (E'\uffeb', E' '), (E'\uffec', E' '), (E'\uffed', E' '), (E'\uffee', E' '), (E'\ufff9', E' '), (E'\ufffa', E' '), (E'\ufffb', E' '), (E'\ufffc', E' '), (E'\ufffd', E' '), (E'\ufffe', E' '), (E'\uffff', E' '), (E'\u0300', E''), (E'\u0301', E''), (E'\u0302', E''), (E'\u0303', E''), (E'\u0304', E''), (E'\u0306', E''), (E'\u0307', E''), (E'\u0308', E''), (E'\u0309', E''), (E'\u030a', E''), (E'\u030b', E''), (E'\u030c', E''), (E'\u030f', E''), (E'\u0311', E''), (E'\u031b', E''), (E'\u0323', E''), (E'\u0324', E''), (E'\u0325', E''), (E'\u0326', E''), (E'\u0327', E''), (E'\u0328', E''), (E'\u032d', E''), (E'\u032e', E''), (E'\u0330', E''), (E'\u0331', E''), (E'\u00b5', E'\u03bc'), (E'\u00c0', E'a'), (E'\u00c1', E'a'), (E'\u00c2', E'a'), (E'\u00c3', E'a'), (E'\u00c4', E'a'), (E'\u00c5', E'a'), (E'\u00c6', E'\u00e6'), (E'\u00c7', E'c'), (E'\u00c8', E'e'), (E'\u00c9', E'e'), (E'\u00ca', E'e'), (E'\u00cb', E'e'), (E'\u00cc', E'i'), (E'\u00cd', E'i'), (E'\u00ce', E'i'), (E'\u00cf', E'i'), (E'\u00d0', E'\u00f0'), (E'\u00d1', E'n'), (E'\u00d2', E'o'), (E'\u00d3', E'o'), (E'\u00d4', E'o'), (E'\u00d5', E'o'), (E'\u00d6', E'o'), (E'\u00d8', E'\u00f8'), (E'\u00d9', E'u'), (E'\u00da', E'u'), (E'\u00db', E'u'), (E'\u00dc', E'u'), (E'\u00dd', E'y'), (E'\u00de', E'\u00fe'), (E'\u00e0', E'a'), (E'\u00e1', E'a'), (E'\u00e2', E'a'), (E'\u00e3', E'a'), (E'\u00e4', E'a'), (E'\u00e5', E'a'), (E'\u00e7', E'c'), (E'\u00e8', E'e'), (E'\u00e9', E'e'), (E'\u00ea', E'e'), (E'\u00eb', E'e'), (E'\u00ec', E'i'), (E'\u00ed', E'i'), (E'\u00ee', E'i'), (E'\u00ef', E'i'), (E'\u00f1', E'n'), (E'\u00f2', E'o'), (E'\u00f3', E'o'), (E'\u00f4', E'o'), (E'\u00f5', E'o'), (E'\u00f6', E'o'), (E'\u00f9', E'u'), (E'\u00fa', E'u'), (E'\u00fb', E'u'), (E'\u00fc', E'u'), (E'\u00fd', E'y'), (E'\u00ff', E'y'), (E'\u0100', E'a'), (E'\u0101', E'a'), (E'\u0102', E'a'), (E'\u0103', E'a'), (E'\u0104', E'a'), (E'\u0105', E'a'), (E'\u0106', E'c'), (E'\u0107', E'c'), (E'\u0108', E'c'), (E'\u0109', E'c'), (E'\u010a', E'c'), (E'\u010b', E'c'), (E'\u010c', E'c'), (E'\u010d', E'c'), (E'\u010e', E'd'), (E'\u010f', E'd'), (E'\u0110', E'\u0111'), (E'\u0112', E'e'), (E'\u0113', E'e'), (E'\u0114', E'e'), (E'\u0115', E'e'), (E'\u0116', E'e'), (E'\u0117', E'e'), (E'\u0118', E'e'), (E'\u0119', E'e'), (E'\u011a', E'e'), (E'\u011b', E'e'), (E'\u011c', E'g'), (E'\u011d', E'g'), (E'\u011e', E'g'), (E'\u011f', E'g'), (E'\u0120', E'g'), (E'\u0121', E'g'), (E'\u0122', E'g'), (E'\u0123', E'g'), (E'\u0124', E'h'), (E'\u0125', E'h'), (E'\u0126', E'\u0127'), (E'\u0128', E'i'), (E'\u0129', E'i'), (E'\u012a', E'i'), (E'\u012b', E'i'), (E'\u012c', E'i'), (E'\u012d', E'i'), (E'\u012e', E'i'), (E'\u012f', E'i'), (E'\u0130', E'i'), (E'\u0132', E'\u0133'), (E'\u0134', E'j'), (E'\u0135', E'j'), (E'\u0136', E'k'), (E'\u0137', E'k'), (E'\u0139', E'l'), (E'\u013a', E'l'), (E'\u013b', E'l'), (E'\u013c', E'l'), (E'\u013d', E'l'), (E'\u013e', E'l'), (E'\u013f', E'\u0140'), (E'\u0141', E'\u0142'), (E'\u0143', E'n'), (E'\u0144', E'n'), (E'\u0145', E'n'), (E'\u0146', E'n'), (E'\u0147', E'n'), (E'\u0148', E'n'), (E'\u014a', E'\u014b'), (E'\u014c', E'o'), (E'\u014d', E'o'), (E'\u014e', E'o'), (E'\u014f', E'o'), (E'\u0150', E'o'), (E'\u0151', E'o'), (E'\u0152', E'\u0153'), (E'\u0154', E'r'), (E'\u0155', E'r'), (E'\u0156', E'r'), (E'\u0157', E'r');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u0158', E'r'), (E'\u0159', E'r'), (E'\u015a', E's'), (E'\u015b', E's'), (E'\u015c', E's'), (E'\u015d', E's'), (E'\u015e', E's'), (E'\u015f', E's'), (E'\u0160', E's'), (E'\u0161', E's'), (E'\u0162', E't'), (E'\u0163', E't'), (E'\u0164', E't'), (E'\u0165', E't'), (E'\u0166', E'\u0167'), (E'\u0168', E'u'), (E'\u0169', E'u'), (E'\u016a', E'u'), (E'\u016b', E'u'), (E'\u016c', E'u'), (E'\u016d', E'u'), (E'\u016e', E'u'), (E'\u016f', E'u'), (E'\u0170', E'u'), (E'\u0171', E'u'), (E'\u0172', E'u'), (E'\u0173', E'u'), (E'\u0174', E'w'), (E'\u0175', E'w'), (E'\u0176', E'y'), (E'\u0177', E'y'), (E'\u0178', E'y'), (E'\u0179', E'z'), (E'\u017a', E'z'), (E'\u017b', E'z'), (E'\u017c', E'z'), (E'\u017d', E'z'), (E'\u017e', E'z'), (E'\u017f', E's'), (E'\u0181', E'\u0253'), (E'\u0182', E'\u0183'), (E'\u0184', E'\u0185'), (E'\u0186', E'\u0254'), (E'\u0187', E'\u0188'), (E'\u0189', E'\u0256'), (E'\u018a', E'\u0257'), (E'\u018b', E'\u018c'), (E'\u018e', E'\u01dd'), (E'\u018f', E'\u0259'), (E'\u0190', E'\u025b'), (E'\u0191', E'\u0192'), (E'\u0193', E'\u0260'), (E'\u0194', E'\u0263'), (E'\u0196', E'\u0269'), (E'\u0197', E'\u0268'), (E'\u0198', E'\u0199'), (E'\u019c', E'\u026f'), (E'\u019d', E'\u0272'), (E'\u019f', E'\u0275'), (E'\u01a0', E'o'), (E'\u01a1', E'o'), (E'\u01a2', E'\u01a3'), (E'\u01a4', E'\u01a5'), (E'\u01a6', E'\u0280'), (E'\u01a7', E'\u01a8'), (E'\u01a9', E'\u0283'), (E'\u01ac', E'\u01ad'), (E'\u01ae', E'\u0288'), (E'\u01af', E'u'), (E'\u01b0', E'u'), (E'\u01b1', E'\u028a'), (E'\u01b2', E'\u028b'), (E'\u01b3', E'\u01b4'), (E'\u01b5', E'\u01b6'), (E'\u01b7', E'\u0292'), (E'\u01b8', E'\u01b9'), (E'\u01bc', E'\u01bd'), (E'\u01c4', E'\u01c6'), (E'\u01c5', E'\u01c6'), (E'\u01c7', E'\u01c9'), (E'\u01c8', E'\u01c9'), (E'\u01ca', E'\u01cc'), (E'\u01cb', E'\u01cc'), (E'\u01cd', E'a'), (E'\u01ce', E'a'), (E'\u01cf', E'i'), (E'\u01d0', E'i'), (E'\u01d1', E'o'), (E'\u01d2', E'o'), (E'\u01d3', E'u'), (E'\u01d4', E'u'), (E'\u01d5', E'u'), (E'\u01d6', E'u'), (E'\u01d7', E'u'), (E'\u01d8', E'u'), (E'\u01d9', E'u'), (E'\u01da', E'u'), (E'\u01db', E'u'), (E'\u01dc', E'u'), (E'\u01de', E'a'), (E'\u01df', E'a'), (E'\u01e0', E'\u01e1'), (E'\u01e2', E'\u01e3'), (E'\u01e4', E'\u01e5'), (E'\u01e6', E'g'), (E'\u01e7', E'g'), (E'\u01e8', E'k'), (E'\u01e9', E'k'), (E'\u01ea', E'o'), (E'\u01eb', E'o'), (E'\u01ec', E'o'), (E'\u01ed', E'o'), (E'\u01ee', E'\u01ef'), (E'\u01f0', E'j'), (E'\u01f1', E'\u01f3'), (E'\u01f2', E'\u01f3'), (E'\u01f4', E'g'), (E'\u01f5', E'g'), (E'\u01f6', E'\u0195'), (E'\u01f7', E'\u01bf'), (E'\u01f8', E'n'), (E'\u01f9', E'n'), (E'\u01fa', E'a'), (E'\u01fb', E'a'), (E'\u01fc', E'\u01fd'), (E'\u01fe', E'\u01ff'), (E'\u0200', E'a'), (E'\u0201', E'a'), (E'\u0202', E'a'), (E'\u0203', E'a'), (E'\u0204', E'e'), (E'\u0205', E'e'), (E'\u0206', E'e'), (E'\u0207', E'e'), (E'\u0208', E'i'), (E'\u0209', E'i'), (E'\u020a', E'i'), (E'\u020b', E'i'), (E'\u020c', E'o'), (E'\u020d', E'o'), (E'\u020e', E'o'), (E'\u020f', E'o'), (E'\u0210', E'r'), (E'\u0211', E'r'), (E'\u0212', E'r'), (E'\u0213', E'r'), (E'\u0214', E'u'), (E'\u0215', E'u'), (E'\u0216', E'u'), (E'\u0217', E'u'), (E'\u0218', E's'), (E'\u0219', E's'), (E'\u021a', E't'), (E'\u021b', E't'), (E'\u021c', E'\u021d'), (E'\u021e', E'h'), (E'\u021f', E'h'), (E'\u0220', E'\u019e'), (E'\u0222', E'\u0223'), (E'\u0224', E'\u0225'), (E'\u0226', E'a'), (E'\u0227', E'a'), (E'\u0228', E'e'), (E'\u0229', E'e'), (E'\u022a', E'o'), (E'\u022b', E'o'), (E'\u022c', E'o'), (E'\u022d', E'o'), (E'\u022e', E'o'), (E'\u022f', E'o'), (E'\u0230', E'o'), (E'\u0231', E'o'), (E'\u0232', E'y'), (E'\u0233', E'y'), (E'\u023a', E'\u2c65'), (E'\u023b', E'\u023c'), (E'\u023d', E'\u019a'), (E'\u023e', E'\u2c66'), (E'\u0241', E'\u0242'), (E'\u0243', E'\u0180'), (E'\u0244', E'\u0289'), (E'\u0245', E'\u028c'), (E'\u0246', E'\u0247'), (E'\u0248', E'\u0249'), (E'\u024a', E'\u024b'), (E'\u024c', E'\u024d'), (E'\u024e', E'\u024f'), (E'\u0345', E'\u03b9'), (E'\u0370', E'\u0371'), (E'\u0372', E'\u0373'), (E'\u0376', E'\u0377'), (E'\u0386', E'\u03ac'), (E'\u0388', E'\u03ad'), (E'\u0389', E'\u03ae'), (E'\u038a', E'\u03af'), (E'\u038c', E'\u03cc'), (E'\u038e', E'\u03cd'), (E'\u038f', E'\u03ce'), (E'\u0391', E'\u03b1'), (E'\u0392', E'\u03b2'), (E'\u0393', E'\u03b3'), (E'\u0394', E'\u03b4'), (E'\u0395', E'\u03b5'), (E'\u0396', E'\u03b6'), (E'\u0397', E'\u03b7'), (E'\u0398', E'\u03b8'), (E'\u0399', E'\u03b9'), (E'\u039a', E'\u03ba'), (E'\u039b', E'\u03bb'), (E'\u039c', E'\u03bc'), (E'\u039d', E'\u03bd'), (E'\u039e', E'\u03be'), (E'\u039f', E'\u03bf'), (E'\u03a0', E'\u03c0'), (E'\u03a1', E'\u03c1'), (E'\u03a3', E'\u03c3'), (E'\u03a4', E'\u03c4'), (E'\u03a5', E'\u03c5'), (E'\u03a6', E'\u03c6'), (E'\u03a7', E'\u03c7'), (E'\u03a8', E'\u03c8'), (E'\u03a9', E'\u03c9'), (E'\u03aa', E'\u03ca'), (E'\u03ab', E'\u03cb'), (E'\u03c2', E'\u03c3'), (E'\u03cf', E'\u03d7'), (E'\u03d0', E'\u03b2'), (E'\u03d1', E'\u03b8'), (E'\u03d5', E'\u03c6'), (E'\u03d6', E'\u03c0'), (E'\u03d8', E'\u03d9'), (E'\u03da', E'\u03db'), (E'\u03dc', E'\u03dd'), (E'\u03de', E'\u03df'), (E'\u03e0', E'\u03e1'), (E'\u03e2', E'\u03e3'), (E'\u03e4', E'\u03e5'), (E'\u03e6', E'\u03e7'), (E'\u03e8', E'\u03e9'), (E'\u03ea', E'\u03eb'), (E'\u03ec', E'\u03ed'), (E'\u03ee', E'\u03ef'), (E'\u03f0', E'\u03ba'), (E'\u03f1', E'\u03c1'), (E'\u03f4', E'\u03b8'), (E'\u03f5', E'\u03b5'), (E'\u03f7', E'\u03f8'), (E'\u03f9', E'\u03f2'), (E'\u03fa', E'\u03fb'), (E'\u03fd', E'\u037b'), (E'\u03fe', E'\u037c'), (E'\u03ff', E'\u037d'), (E'\u0400', E'\u0450'), (E'\u0401', E'\u0451'), (E'\u0402', E'\u0452'), (E'\u0403', E'\u0453'), (E'\u0404', E'\u0454'), (E'\u0405', E'\u0455'), (E'\u0406', E'\u0456'), (E'\u0407', E'\u0457'), (E'\u0408', E'\u0458'), (E'\u0409', E'\u0459'), (E'\u040a', E'\u045a'), (E'\u040b', E'\u045b'), (E'\u040c', E'\u045c'), (E'\u040d', E'\u045d'), (E'\u040e', E'\u045e'), (E'\u040f', E'\u045f'), (E'\u0410', E'\u0430'), (E'\u0411', E'\u0431'), (E'\u0412', E'\u0432'), (E'\u0413', E'\u0433'), (E'\u0414', E'\u0434'), (E'\u0415', E'\u0435'), (E'\u0416', E'\u0436'), (E'\u0417', E'\u0437'), (E'\u0418', E'\u0438'), (E'\u0419', E'\u0439'), (E'\u041a', E'\u043a'), (E'\u041b', E'\u043b'), (E'\u041c', E'\u043c'), (E'\u041d', E'\u043d'), (E'\u041e', E'\u043e'), (E'\u041f', E'\u043f'), (E'\u0420', E'\u0440'), (E'\u0421', E'\u0441'), (E'\u0422', E'\u0442'), (E'\u0423', E'\u0443'), (E'\u0424', E'\u0444'), (E'\u0425', E'\u0445'), (E'\u0426', E'\u0446'), (E'\u0427', E'\u0447'), (E'\u0428', E'\u0448'), (E'\u0429', E'\u0449'), (E'\u042a', E'\u044a'), (E'\u042b', E'\u044b'), (E'\u042c', E'\u044c'), (E'\u042d', E'\u044d'), (E'\u042e', E'\u044e'), (E'\u042f', E'\u044f'), (E'\u0460', E'\u0461'), (E'\u0462', E'\u0463'), (E'\u0464', E'\u0465'), (E'\u0466', E'\u0467'), (E'\u0468', E'\u0469'), (E'\u046a', E'\u046b'), (E'\u046c', E'\u046d'), (E'\u046e', E'\u046f'), (E'\u0470', E'\u0471'), (E'\u0472', E'\u0473'), (E'\u0474', E'\u0475'), (E'\u0476', E'\u0477'), (E'\u0478', E'\u0479'), (E'\u047a', E'\u047b'), (E'\u047c', E'\u047d'), (E'\u047e', E'\u047f'), (E'\u0480', E'\u0481'), (E'\u048a', E'\u048b'), (E'\u048c', E'\u048d'), (E'\u048e', E'\u048f'), (E'\u0490', E'\u0491'), (E'\u0492', E'\u0493'), (E'\u0494', E'\u0495'), (E'\u0496', E'\u0497'), (E'\u0498', E'\u0499'), (E'\u049a', E'\u049b'), (E'\u049c', E'\u049d'), (E'\u049e', E'\u049f'), (E'\u04a0', E'\u04a1'), (E'\u04a2', E'\u04a3'), (E'\u04a4', E'\u04a5'), (E'\u04a6', E'\u04a7'), (E'\u04a8', E'\u04a9'), (E'\u04aa', E'\u04ab'), (E'\u04ac', E'\u04ad'), (E'\u04ae', E'\u04af'), (E'\u04b0', E'\u04b1'), (E'\u04b2', E'\u04b3'), (E'\u04b4', E'\u04b5'), (E'\u04b6', E'\u04b7'), (E'\u04b8', E'\u04b9'), (E'\u04ba', E'\u04bb'), (E'\u04bc', E'\u04bd'), (E'\u04be', E'\u04bf'), (E'\u04c0', E'\u04cf'), (E'\u04c1', E'\u04c2'), (E'\u04c3', E'\u04c4'), (E'\u04c5', E'\u04c6'), (E'\u04c7', E'\u04c8'), (E'\u04c9', E'\u04ca'), (E'\u04cb', E'\u04cc'), (E'\u04cd', E'\u04ce'), (E'\u04d0', E'\u04d1'), (E'\u04d2', E'\u04d3'), (E'\u04d4', E'\u04d5'), (E'\u04d6', E'\u04d7'), (E'\u04d8', E'\u04d9'), (E'\u04da', E'\u04db'), (E'\u04dc', E'\u04dd'), (E'\u04de', E'\u04df'), (E'\u04e0', E'\u04e1'), (E'\u04e2', E'\u04e3'), (E'\u04e4', E'\u04e5'), (E'\u04e6', E'\u04e7'), (E'\u04e8', E'\u04e9'), (E'\u04ea', E'\u04eb'), (E'\u04ec', E'\u04ed'), (E'\u04ee', E'\u04ef'), (E'\u04f0', E'\u04f1'), (E'\u04f2', E'\u04f3'), (E'\u04f4', E'\u04f5'), (E'\u04f6', E'\u04f7'), (E'\u04f8', E'\u04f9'), (E'\u04fa', E'\u04fb'), (E'\u04fc', E'\u04fd'), (E'\u04fe', E'\u04ff'), (E'\u0500', E'\u0501'), (E'\u0502', E'\u0503'), (E'\u0504', E'\u0505'), (E'\u0506', E'\u0507'), (E'\u0508', E'\u0509'), (E'\u050a', E'\u050b'), (E'\u050c', E'\u050d'), (E'\u050e', E'\u050f'), (E'\u0510', E'\u0511'), (E'\u0512', E'\u0513'), (E'\u0514', E'\u0515'), (E'\u0516', E'\u0517'), (E'\u0518', E'\u0519'), (E'\u051a', E'\u051b'), (E'\u051c', E'\u051d'), (E'\u051e', E'\u051f'), (E'\u0520', E'\u0521'), (E'\u0522', E'\u0523'), (E'\u0524', E'\u0525'), (E'\u0526', E'\u0527'), (E'\u0531', E'\u0561'), (E'\u0532', E'\u0562'), (E'\u0533', E'\u0563'), (E'\u0534', E'\u0564'), (E'\u0535', E'\u0565'), (E'\u0536', E'\u0566'), (E'\u0537', E'\u0567'), (E'\u0538', E'\u0568'), (E'\u0539', E'\u0569'), (E'\u053a', E'\u056a'), (E'\u053b', E'\u056b'), (E'\u053c', E'\u056c'), (E'\u053d', E'\u056d'), (E'\u053e', E'\u056e'), (E'\u053f', E'\u056f'), (E'\u0540', E'\u0570'), (E'\u0541', E'\u0571'), (E'\u0542', E'\u0572'), (E'\u0543', E'\u0573'), (E'\u0544', E'\u0574'), (E'\u0545', E'\u0575'), (E'\u0546', E'\u0576'), (E'\u0547', E'\u0577'), (E'\u0548', E'\u0578'), (E'\u0549', E'\u0579'), (E'\u054a', E'\u057a'), (E'\u054b', E'\u057b'), (E'\u054c', E'\u057c'), (E'\u054d', E'\u057d'), (E'\u054e', E'\u057e'), (E'\u054f', E'\u057f'), (E'\u0550', E'\u0580'), (E'\u0551', E'\u0581'), (E'\u0552', E'\u0582'), (E'\u0553', E'\u0583'), (E'\u0554', E'\u0584'), (E'\u0555', E'\u0585'), (E'\u0556', E'\u0586'), (E'\u10a0', E'\u2d00'), (E'\u10a1', E'\u2d01'), (E'\u10a2', E'\u2d02'), (E'\u10a3', E'\u2d03'), (E'\u10a4', E'\u2d04'), (E'\u10a5', E'\u2d05'), (E'\u10a6', E'\u2d06'), (E'\u10a7', E'\u2d07'), (E'\u10a8', E'\u2d08'), (E'\u10a9', E'\u2d09'), (E'\u10aa', E'\u2d0a'), (E'\u10ab', E'\u2d0b'), (E'\u10ac', E'\u2d0c'), (E'\u10ad', E'\u2d0d'), (E'\u10ae', E'\u2d0e'), (E'\u10af', E'\u2d0f'), (E'\u10b0', E'\u2d10'), (E'\u10b1', E'\u2d11'), (E'\u10b2', E'\u2d12'), (E'\u10b3', E'\u2d13'), (E'\u10b4', E'\u2d14'), (E'\u10b5', E'\u2d15'), (E'\u10b6', E'\u2d16'), (E'\u10b7', E'\u2d17'), (E'\u10b8', E'\u2d18'), (E'\u10b9', E'\u2d19'), (E'\u10ba', E'\u2d1a'), (E'\u10bb', E'\u2d1b'), (E'\u10bc', E'\u2d1c'), (E'\u10bd', E'\u2d1d'), (E'\u10be', E'\u2d1e'), (E'\u10bf', E'\u2d1f'), (E'\u10c0', E'\u2d20'), (E'\u10c1', E'\u2d21'), (E'\u10c2', E'\u2d22'), (E'\u10c3', E'\u2d23'), (E'\u10c4', E'\u2d24'), (E'\u10c5', E'\u2d25'), (E'\u10c7', E'\u2d27'), (E'\u10cd', E'\u2d2d'), (E'\u1e00', E'a'), (E'\u1e01', E'a'), (E'\u1e02', E'b'), (E'\u1e03', E'b'), (E'\u1e04', E'b'), (E'\u1e05', E'b'), (E'\u1e06', E'b'), (E'\u1e07', E'b'), (E'\u1e08', E'c'), (E'\u1e09', E'c'), (E'\u1e0a', E'd'), (E'\u1e0b', E'd'), (E'\u1e0c', E'd'), (E'\u1e0d', E'd'), (E'\u1e0e', E'd'), (E'\u1e0f', E'd'), (E'\u1e10', E'd'), (E'\u1e11', E'd'), (E'\u1e12', E'd'), (E'\u1e13', E'd'), (E'\u1e14', E'e'), (E'\u1e15', E'e'), (E'\u1e16', E'e'), (E'\u1e17', E'e'), (E'\u1e18', E'e'), (E'\u1e19', E'e');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\u1e1a', E'e'), (E'\u1e1b', E'e'), (E'\u1e1c', E'e'), (E'\u1e1d', E'e'), (E'\u1e1e', E'f'), (E'\u1e1f', E'f'), (E'\u1e20', E'g'), (E'\u1e21', E'g'), (E'\u1e22', E'h'), (E'\u1e23', E'h'), (E'\u1e24', E'h'), (E'\u1e25', E'h'), (E'\u1e26', E'h'), (E'\u1e27', E'h'), (E'\u1e28', E'h'), (E'\u1e29', E'h'), (E'\u1e2a', E'h'), (E'\u1e2b', E'h'), (E'\u1e2c', E'i'), (E'\u1e2d', E'i'), (E'\u1e2e', E'i'), (E'\u1e2f', E'i'), (E'\u1e30', E'k'), (E'\u1e31', E'k'), (E'\u1e32', E'k'), (E'\u1e33', E'k'), (E'\u1e34', E'k'), (E'\u1e35', E'k'), (E'\u1e36', E'l'), (E'\u1e37', E'l'), (E'\u1e38', E'l'), (E'\u1e39', E'l'), (E'\u1e3a', E'l'), (E'\u1e3b', E'l'), (E'\u1e3c', E'l'), (E'\u1e3d', E'l'), (E'\u1e3e', E'm'), (E'\u1e3f', E'm'), (E'\u1e40', E'm'), (E'\u1e41', E'm'), (E'\u1e42', E'm'), (E'\u1e43', E'm'), (E'\u1e44', E'n'), (E'\u1e45', E'n'), (E'\u1e46', E'n'), (E'\u1e47', E'n'), (E'\u1e48', E'n'), (E'\u1e49', E'n'), (E'\u1e4a', E'n'), (E'\u1e4b', E'n'), (E'\u1e4c', E'o'), (E'\u1e4d', E'o'), (E'\u1e4e', E'o'), (E'\u1e4f', E'o'), (E'\u1e50', E'o'), (E'\u1e51', E'o'), (E'\u1e52', E'o'), (E'\u1e53', E'o'), (E'\u1e54', E'p'), (E'\u1e55', E'p'), (E'\u1e56', E'p'), (E'\u1e57', E'p'), (E'\u1e58', E'r'), (E'\u1e59', E'r'), (E'\u1e5a', E'r'), (E'\u1e5b', E'r'), (E'\u1e5c', E'r'), (E'\u1e5d', E'r'), (E'\u1e5e', E'r'), (E'\u1e5f', E'r'), (E'\u1e60', E's'), (E'\u1e61', E's'), (E'\u1e62', E's'), (E'\u1e63', E's'), (E'\u1e64', E's'), (E'\u1e65', E's'), (E'\u1e66', E's'), (E'\u1e67', E's'), (E'\u1e68', E's'), (E'\u1e69', E's'), (E'\u1e6a', E't'), (E'\u1e6b', E't'), (E'\u1e6c', E't'), (E'\u1e6d', E't'), (E'\u1e6e', E't'), (E'\u1e6f', E't'), (E'\u1e70', E't'), (E'\u1e71', E't'), (E'\u1e72', E'u'), (E'\u1e73', E'u'), (E'\u1e74', E'u'), (E'\u1e75', E'u'), (E'\u1e76', E'u'), (E'\u1e77', E'u'), (E'\u1e78', E'u'), (E'\u1e79', E'u'), (E'\u1e7a', E'u'), (E'\u1e7b', E'u'), (E'\u1e7c', E'v'), (E'\u1e7d', E'v'), (E'\u1e7e', E'v'), (E'\u1e7f', E'v'), (E'\u1e80', E'w'), (E'\u1e81', E'w'), (E'\u1e82', E'w'), (E'\u1e83', E'w'), (E'\u1e84', E'w'), (E'\u1e85', E'w'), (E'\u1e86', E'w'), (E'\u1e87', E'w'), (E'\u1e88', E'w'), (E'\u1e89', E'w'), (E'\u1e8a', E'x'), (E'\u1e8b', E'x'), (E'\u1e8c', E'x'), (E'\u1e8d', E'x'), (E'\u1e8e', E'y'), (E'\u1e8f', E'y'), (E'\u1e90', E'z'), (E'\u1e91', E'z'), (E'\u1e92', E'z'), (E'\u1e93', E'z'), (E'\u1e94', E'z'), (E'\u1e95', E'z'), (E'\u1e96', E'h'), (E'\u1e97', E't'), (E'\u1e98', E'w'), (E'\u1e99', E'y'), (E'\u1e9b', E's'), (E'\u1e9e', E'\u00df'), (E'\u1ea0', E'a'), (E'\u1ea1', E'a'), (E'\u1ea2', E'a'), (E'\u1ea3', E'a'), (E'\u1ea4', E'a'), (E'\u1ea5', E'a'), (E'\u1ea6', E'a'), (E'\u1ea7', E'a'), (E'\u1ea8', E'a'), (E'\u1ea9', E'a'), (E'\u1eaa', E'a'), (E'\u1eab', E'a'), (E'\u1eac', E'a'), (E'\u1ead', E'a'), (E'\u1eae', E'a'), (E'\u1eaf', E'a'), (E'\u1eb0', E'a'), (E'\u1eb1', E'a'), (E'\u1eb2', E'a'), (E'\u1eb3', E'a'), (E'\u1eb4', E'a'), (E'\u1eb5', E'a'), (E'\u1eb6', E'a'), (E'\u1eb7', E'a'), (E'\u1eb8', E'e'), (E'\u1eb9', E'e'), (E'\u1eba', E'e'), (E'\u1ebb', E'e'), (E'\u1ebc', E'e'), (E'\u1ebd', E'e'), (E'\u1ebe', E'e'), (E'\u1ebf', E'e'), (E'\u1ec0', E'e'), (E'\u1ec1', E'e'), (E'\u1ec2', E'e'), (E'\u1ec3', E'e'), (E'\u1ec4', E'e'), (E'\u1ec5', E'e'), (E'\u1ec6', E'e'), (E'\u1ec7', E'e'), (E'\u1ec8', E'i'), (E'\u1ec9', E'i'), (E'\u1eca', E'i'), (E'\u1ecb', E'i'), (E'\u1ecc', E'o'), (E'\u1ecd', E'o'), (E'\u1ece', E'o'), (E'\u1ecf', E'o'), (E'\u1ed0', E'o'), (E'\u1ed1', E'o'), (E'\u1ed2', E'o'), (E'\u1ed3', E'o'), (E'\u1ed4', E'o'), (E'\u1ed5', E'o'), (E'\u1ed6', E'o'), (E'\u1ed7', E'o'), (E'\u1ed8', E'o'), (E'\u1ed9', E'o'), (E'\u1eda', E'o'), (E'\u1edb', E'o'), (E'\u1edc', E'o'), (E'\u1edd', E'o'), (E'\u1ede', E'o'), (E'\u1edf', E'o'), (E'\u1ee0', E'o'), (E'\u1ee1', E'o'), (E'\u1ee2', E'o'), (E'\u1ee3', E'o'), (E'\u1ee4', E'u'), (E'\u1ee5', E'u'), (E'\u1ee6', E'u'), (E'\u1ee7', E'u'), (E'\u1ee8', E'u'), (E'\u1ee9', E'u'), (E'\u1eea', E'u'), (E'\u1eeb', E'u'), (E'\u1eec', E'u'), (E'\u1eed', E'u'), (E'\u1eee', E'u'), (E'\u1eef', E'u'), (E'\u1ef0', E'u'), (E'\u1ef1', E'u'), (E'\u1ef2', E'y'), (E'\u1ef3', E'y'), (E'\u1ef4', E'y'), (E'\u1ef5', E'y'), (E'\u1ef6', E'y'), (E'\u1ef7', E'y'), (E'\u1ef8', E'y'), (E'\u1ef9', E'y'), (E'\u1efa', E'\u1efb'), (E'\u1efc', E'\u1efd'), (E'\u1efe', E'\u1eff'), (E'\u1f08', E'\u1f00'), (E'\u1f09', E'\u1f01'), (E'\u1f0a', E'\u1f02'), (E'\u1f0b', E'\u1f03'), (E'\u1f0c', E'\u1f04'), (E'\u1f0d', E'\u1f05'), (E'\u1f0e', E'\u1f06'), (E'\u1f0f', E'\u1f07'), (E'\u1f18', E'\u1f10'), (E'\u1f19', E'\u1f11'), (E'\u1f1a', E'\u1f12'), (E'\u1f1b', E'\u1f13'), (E'\u1f1c', E'\u1f14'), (E'\u1f1d', E'\u1f15'), (E'\u1f28', E'\u1f20'), (E'\u1f29', E'\u1f21'), (E'\u1f2a', E'\u1f22'), (E'\u1f2b', E'\u1f23'), (E'\u1f2c', E'\u1f24'), (E'\u1f2d', E'\u1f25'), (E'\u1f2e', E'\u1f26'), (E'\u1f2f', E'\u1f27'), (E'\u1f38', E'\u1f30'), (E'\u1f39', E'\u1f31'), (E'\u1f3a', E'\u1f32'), (E'\u1f3b', E'\u1f33'), (E'\u1f3c', E'\u1f34'), (E'\u1f3d', E'\u1f35'), (E'\u1f3e', E'\u1f36'), (E'\u1f3f', E'\u1f37'), (E'\u1f48', E'\u1f40'), (E'\u1f49', E'\u1f41'), (E'\u1f4a', E'\u1f42'), (E'\u1f4b', E'\u1f43'), (E'\u1f4c', E'\u1f44'), (E'\u1f4d', E'\u1f45'), (E'\u1f59', E'\u1f51'), (E'\u1f5b', E'\u1f53'), (E'\u1f5d', E'\u1f55'), (E'\u1f5f', E'\u1f57'), (E'\u1f68', E'\u1f60'), (E'\u1f69', E'\u1f61'), (E'\u1f6a', E'\u1f62'), (E'\u1f6b', E'\u1f63'), (E'\u1f6c', E'\u1f64'), (E'\u1f6d', E'\u1f65'), (E'\u1f6e', E'\u1f66'), (E'\u1f6f', E'\u1f67'), (E'\u1f88', E'\u1f80'), (E'\u1f89', E'\u1f81'), (E'\u1f8a', E'\u1f82'), (E'\u1f8b', E'\u1f83'), (E'\u1f8c', E'\u1f84'), (E'\u1f8d', E'\u1f85'), (E'\u1f8e', E'\u1f86'), (E'\u1f8f', E'\u1f87'), (E'\u1f98', E'\u1f90'), (E'\u1f99', E'\u1f91'), (E'\u1f9a', E'\u1f92'), (E'\u1f9b', E'\u1f93'), (E'\u1f9c', E'\u1f94'), (E'\u1f9d', E'\u1f95'), (E'\u1f9e', E'\u1f96'), (E'\u1f9f', E'\u1f97'), (E'\u1fa8', E'\u1fa0'), (E'\u1fa9', E'\u1fa1'), (E'\u1faa', E'\u1fa2'), (E'\u1fab', E'\u1fa3'), (E'\u1fac', E'\u1fa4'), (E'\u1fad', E'\u1fa5'), (E'\u1fae', E'\u1fa6'), (E'\u1faf', E'\u1fa7'), (E'\u1fb8', E'\u1fb0'), (E'\u1fb9', E'\u1fb1'), (E'\u1fba', E'\u1f70'), (E'\u1fbb', E'\u1f71'), (E'\u1fbc', E'\u1fb3'), (E'\u1fbe', E'\u03b9'), (E'\u1fc8', E'\u1f72'), (E'\u1fc9', E'\u1f73'), (E'\u1fca', E'\u1f74'), (E'\u1fcb', E'\u1f75'), (E'\u1fcc', E'\u1fc3'), (E'\u1fd8', E'\u1fd0'), (E'\u1fd9', E'\u1fd1'), (E'\u1fda', E'\u1f76'), (E'\u1fdb', E'\u1f77'), (E'\u1fe8', E'\u1fe0'), (E'\u1fe9', E'\u1fe1'), (E'\u1fea', E'\u1f7a'), (E'\u1feb', E'\u1f7b'), (E'\u1fec', E'\u1fe5'), (E'\u1ff8', E'\u1f78'), (E'\u1ff9', E'\u1f79'), (E'\u1ffa', E'\u1f7c'), (E'\u1ffb', E'\u1f7d'), (E'\u1ffc', E'\u1ff3'), (E'\u2126', E'\u03c9'), (E'\u212a', E'k'), (E'\u212b', E'a'), (E'\u2132', E'\u214e'), (E'\u2160', E'\u2170'), (E'\u2161', E'\u2171'), (E'\u2162', E'\u2172'), (E'\u2163', E'\u2173'), (E'\u2164', E'\u2174'), (E'\u2165', E'\u2175'), (E'\u2166', E'\u2176'), (E'\u2167', E'\u2177'), (E'\u2168', E'\u2178'), (E'\u2169', E'\u2179'), (E'\u216a', E'\u217a'), (E'\u216b', E'\u217b'), (E'\u216c', E'\u217c'), (E'\u216d', E'\u217d'), (E'\u216e', E'\u217e'), (E'\u216f', E'\u217f'), (E'\u2183', E'\u2184'), (E'\u2c00', E'\u2c30'), (E'\u2c01', E'\u2c31'), (E'\u2c02', E'\u2c32'), (E'\u2c03', E'\u2c33'), (E'\u2c04', E'\u2c34'), (E'\u2c05', E'\u2c35'), (E'\u2c06', E'\u2c36'), (E'\u2c07', E'\u2c37'), (E'\u2c08', E'\u2c38'), (E'\u2c09', E'\u2c39'), (E'\u2c0a', E'\u2c3a'), (E'\u2c0b', E'\u2c3b'), (E'\u2c0c', E'\u2c3c'), (E'\u2c0d', E'\u2c3d'), (E'\u2c0e', E'\u2c3e'), (E'\u2c0f', E'\u2c3f'), (E'\u2c10', E'\u2c40'), (E'\u2c11', E'\u2c41'), (E'\u2c12', E'\u2c42'), (E'\u2c13', E'\u2c43'), (E'\u2c14', E'\u2c44'), (E'\u2c15', E'\u2c45'), (E'\u2c16', E'\u2c46'), (E'\u2c17', E'\u2c47'), (E'\u2c18', E'\u2c48'), (E'\u2c19', E'\u2c49'), (E'\u2c1a', E'\u2c4a'), (E'\u2c1b', E'\u2c4b'), (E'\u2c1c', E'\u2c4c'), (E'\u2c1d', E'\u2c4d'), (E'\u2c1e', E'\u2c4e'), (E'\u2c1f', E'\u2c4f'), (E'\u2c20', E'\u2c50'), (E'\u2c21', E'\u2c51'), (E'\u2c22', E'\u2c52'), (E'\u2c23', E'\u2c53'), (E'\u2c24', E'\u2c54'), (E'\u2c25', E'\u2c55'), (E'\u2c26', E'\u2c56'), (E'\u2c27', E'\u2c57'), (E'\u2c28', E'\u2c58'), (E'\u2c29', E'\u2c59'), (E'\u2c2a', E'\u2c5a'), (E'\u2c2b', E'\u2c5b'), (E'\u2c2c', E'\u2c5c'), (E'\u2c2d', E'\u2c5d'), (E'\u2c2e', E'\u2c5e'), (E'\u2c60', E'\u2c61'), (E'\u2c62', E'\u026b'), (E'\u2c63', E'\u1d7d'), (E'\u2c64', E'\u027d'), (E'\u2c67', E'\u2c68'), (E'\u2c69', E'\u2c6a'), (E'\u2c6b', E'\u2c6c'), (E'\u2c6d', E'\u0251'), (E'\u2c6e', E'\u0271'), (E'\u2c6f', E'\u0250'), (E'\u2c70', E'\u0252'), (E'\u2c72', E'\u2c73'), (E'\u2c75', E'\u2c76'), (E'\u2c7e', E'\u023f'), (E'\u2c7f', E'\u0240'), (E'\u2c80', E'\u2c81'), (E'\u2c82', E'\u2c83'), (E'\u2c84', E'\u2c85'), (E'\u2c86', E'\u2c87'), (E'\u2c88', E'\u2c89'), (E'\u2c8a', E'\u2c8b'), (E'\u2c8c', E'\u2c8d'), (E'\u2c8e', E'\u2c8f'), (E'\u2c90', E'\u2c91'), (E'\u2c92', E'\u2c93'), (E'\u2c94', E'\u2c95'), (E'\u2c96', E'\u2c97'), (E'\u2c98', E'\u2c99'), (E'\u2c9a', E'\u2c9b'), (E'\u2c9c', E'\u2c9d'), (E'\u2c9e', E'\u2c9f'), (E'\u2ca0', E'\u2ca1'), (E'\u2ca2', E'\u2ca3'), (E'\u2ca4', E'\u2ca5'), (E'\u2ca6', E'\u2ca7'), (E'\u2ca8', E'\u2ca9'), (E'\u2caa', E'\u2cab'), (E'\u2cac', E'\u2cad'), (E'\u2cae', E'\u2caf'), (E'\u2cb0', E'\u2cb1'), (E'\u2cb2', E'\u2cb3'), (E'\u2cb4', E'\u2cb5'), (E'\u2cb6', E'\u2cb7'), (E'\u2cb8', E'\u2cb9'), (E'\u2cba', E'\u2cbb'), (E'\u2cbc', E'\u2cbd'), (E'\u2cbe', E'\u2cbf'), (E'\u2cc0', E'\u2cc1'), (E'\u2cc2', E'\u2cc3'), (E'\u2cc4', E'\u2cc5'), (E'\u2cc6', E'\u2cc7'), (E'\u2cc8', E'\u2cc9'), (E'\u2cca', E'\u2ccb'), (E'\u2ccc', E'\u2ccd'), (E'\u2cce', E'\u2ccf'), (E'\u2cd0', E'\u2cd1'), (E'\u2cd2', E'\u2cd3'), (E'\u2cd4', E'\u2cd5'), (E'\u2cd6', E'\u2cd7'), (E'\u2cd8', E'\u2cd9'), (E'\u2cda', E'\u2cdb'), (E'\u2cdc', E'\u2cdd'), (E'\u2cde', E'\u2cdf'), (E'\u2ce0', E'\u2ce1'), (E'\u2ce2', E'\u2ce3'), (E'\u2ceb', E'\u2cec'), (E'\u2ced', E'\u2cee'), (E'\u2cf2', E'\u2cf3'), (E'\ua640', E'\ua641'), (E'\ua642', E'\ua643'), (E'\ua644', E'\ua645'), (E'\ua646', E'\ua647'), (E'\ua648', E'\ua649'), (E'\ua64a', E'\ua64b'), (E'\ua64c', E'\ua64d'), (E'\ua64e', E'\ua64f'), (E'\ua650', E'\ua651'), (E'\ua652', E'\ua653'), (E'\ua654', E'\ua655'), (E'\ua656', E'\ua657'), (E'\ua658', E'\ua659'), (E'\ua65a', E'\ua65b'), (E'\ua65c', E'\ua65d'), (E'\ua65e', E'\ua65f'), (E'\ua660', E'\ua661'), (E'\ua662', E'\ua663'), (E'\ua664', E'\ua665'), (E'\ua666', E'\ua667'), (E'\ua668', E'\ua669'), (E'\ua66a', E'\ua66b'), (E'\ua66c', E'\ua66d'), (E'\ua680', E'\ua681'), (E'\ua682', E'\ua683'), (E'\ua684', E'\ua685'), (E'\ua686', E'\ua687'), (E'\ua688', E'\ua689'), (E'\ua68a', E'\ua68b'), (E'\ua68c', E'\ua68d'), (E'\ua68e', E'\ua68f'), (E'\ua690', E'\ua691'), (E'\ua692', E'\ua693'), (E'\ua694', E'\ua695'), (E'\ua696', E'\ua697'), (E'\ua722', E'\ua723'), (E'\ua724', E'\ua725'), (E'\ua726', E'\ua727'), (E'\ua728', E'\ua729'), (E'\ua72a', E'\ua72b'), (E'\ua72c', E'\ua72d'), (E'\ua72e', E'\ua72f'), (E'\ua732', E'\ua733'), (E'\ua734', E'\ua735');
--> statement-breakpoint
INSERT INTO search_fts_fold (ch, folded) VALUES (E'\ua736', E'\ua737'), (E'\ua738', E'\ua739'), (E'\ua73a', E'\ua73b'), (E'\ua73c', E'\ua73d'), (E'\ua73e', E'\ua73f'), (E'\ua740', E'\ua741'), (E'\ua742', E'\ua743'), (E'\ua744', E'\ua745'), (E'\ua746', E'\ua747'), (E'\ua748', E'\ua749'), (E'\ua74a', E'\ua74b'), (E'\ua74c', E'\ua74d'), (E'\ua74e', E'\ua74f'), (E'\ua750', E'\ua751'), (E'\ua752', E'\ua753'), (E'\ua754', E'\ua755'), (E'\ua756', E'\ua757'), (E'\ua758', E'\ua759'), (E'\ua75a', E'\ua75b'), (E'\ua75c', E'\ua75d'), (E'\ua75e', E'\ua75f'), (E'\ua760', E'\ua761'), (E'\ua762', E'\ua763'), (E'\ua764', E'\ua765'), (E'\ua766', E'\ua767'), (E'\ua768', E'\ua769'), (E'\ua76a', E'\ua76b'), (E'\ua76c', E'\ua76d'), (E'\ua76e', E'\ua76f'), (E'\ua779', E'\ua77a'), (E'\ua77b', E'\ua77c'), (E'\ua77d', E'\u1d79'), (E'\ua77e', E'\ua77f'), (E'\ua780', E'\ua781'), (E'\ua782', E'\ua783'), (E'\ua784', E'\ua785'), (E'\ua786', E'\ua787'), (E'\ua78b', E'\ua78c'), (E'\ua78d', E'\u0265'), (E'\ua790', E'\ua791'), (E'\ua792', E'\ua793'), (E'\ua7a0', E'\ua7a1'), (E'\ua7a2', E'\ua7a3'), (E'\ua7a4', E'\ua7a5'), (E'\ua7a6', E'\ua7a7'), (E'\ua7a8', E'\ua7a9'), (E'\ua7aa', E'\u0266'), (E'\uff21', E'\uff41'), (E'\uff22', E'\uff42'), (E'\uff23', E'\uff43'), (E'\uff24', E'\uff44'), (E'\uff25', E'\uff45'), (E'\uff26', E'\uff46'), (E'\uff27', E'\uff47'), (E'\uff28', E'\uff48'), (E'\uff29', E'\uff49'), (E'\uff2a', E'\uff4a'), (E'\uff2b', E'\uff4b'), (E'\uff2c', E'\uff4c'), (E'\uff2d', E'\uff4d'), (E'\uff2e', E'\uff4e'), (E'\uff2f', E'\uff4f'), (E'\uff30', E'\uff50'), (E'\uff31', E'\uff51'), (E'\uff32', E'\uff52'), (E'\uff33', E'\uff53'), (E'\uff34', E'\uff54'), (E'\uff35', E'\uff55'), (E'\uff36', E'\uff56'), (E'\uff37', E'\uff57'), (E'\uff38', E'\uff58'), (E'\uff39', E'\uff59'), (E'\uff3a', E'\uff5a'), (E'\u09dc', E'\u09a1\u09bc'), (E'\u09dd', E'\u09a2\u09bc'), (E'\u09df', E'\u09af\u09bc');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat.search_fts_fold(value text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $search_fold$ SELECT string_agg(coalesce(fold.folded, letter.ch), '' ORDER BY letter.n) FROM unnest(string_to_array(lower(value COLLATE "C"), NULL)) WITH ORDINALITY AS letter(ch, n) LEFT JOIN public.search_fts_fold AS fold ON fold.ch = letter.ch $search_fold$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_insert" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.description_search_text, scalius_compat.search_fts_fold(substr(NEW.description, 1, 20000))), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'products', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_insert"
AFTER INSERT ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_update" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'products' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.description_search_text, scalius_compat.search_fts_fold(substr(NEW.description, 1, 20000))), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'products', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_update"
AFTER UPDATE OF "id" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_update_0" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.name IS DISTINCT FROM NEW.name AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'products' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'products' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_update_0"
AFTER UPDATE OF "name" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_update_1" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((coalesce(OLD.description_search_text, substr(OLD.description, 1, 20000)) IS DISTINCT FROM coalesce(NEW.description_search_text, substr(NEW.description, 1, 20000)) AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'products' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.description_search_text, scalius_compat.search_fts_fold(substr(NEW.description, 1, 20000))), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'products' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_update_1"
AFTER UPDATE OF "description", "description_search_text" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_delete" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'products' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_delete"
AFTER DELETE ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_insert" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.sku, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_variants', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_insert"
AFTER INSERT ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_update" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'product_variants' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.sku, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_variants', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_update"
AFTER UPDATE OF "id" ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_update_0" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.sku IS DISTINCT FROM NEW.sku AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'product_variants' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.sku, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'product_variants' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_update_0"
AFTER UPDATE OF "sku" ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_delete" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'product_variants' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_delete"
AFTER DELETE ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_insert" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.description_search_text, scalius_compat.search_fts_fold(substr(NEW.description, 1, 20000))), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'categories', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_insert"
AFTER INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_update" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'categories' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.description_search_text, scalius_compat.search_fts_fold(substr(NEW.description, 1, 20000))), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'categories', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_update"
AFTER UPDATE OF "id" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_update_0" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.name IS DISTINCT FROM NEW.name AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'categories' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'categories' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_update_0"
AFTER UPDATE OF "name" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_update_1" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((coalesce(OLD.description_search_text, substr(OLD.description, 1, 20000)) IS DISTINCT FROM coalesce(NEW.description_search_text, substr(NEW.description, 1, 20000)) AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'categories' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.description_search_text, scalius_compat.search_fts_fold(substr(NEW.description, 1, 20000))), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'categories' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_update_1"
AFTER UPDATE OF "description", "description_search_text" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_delete" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'categories' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_delete"
AFTER DELETE ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_insert" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.title, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.content_search_text, scalius_compat.search_fts_fold(substr(NEW.content, 1, 20000))), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'pages', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_insert"
AFTER INSERT ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_update" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'pages' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.title, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.content_search_text, scalius_compat.search_fts_fold(substr(NEW.content, 1, 20000))), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'pages', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_update"
AFTER UPDATE OF "id" ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_update_0" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.title IS DISTINCT FROM NEW.title AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'pages' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.title, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'pages' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_update_0"
AFTER UPDATE OF "title" ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_update_1" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((coalesce(OLD.content_search_text, substr(OLD.content, 1, 20000)) IS DISTINCT FROM coalesce(NEW.content_search_text, substr(NEW.content, 1, 20000)) AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'pages' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(coalesce(NEW.content_search_text, scalius_compat.search_fts_fold(substr(NEW.content, 1, 20000))), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'pages' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_update_1"
AFTER UPDATE OF "content", "content_search_text" ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_delete" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'pages' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_delete"
AFTER DELETE ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_insert" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_email, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 3 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.id, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'orders', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_insert"
AFTER INSERT ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_update" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_email, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 3 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.id, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'orders', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_update"
AFTER UPDATE OF "id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_update_0" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.customer_name IS DISTINCT FROM NEW.customer_name AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_name, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'orders' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_update_0"
AFTER UPDATE OF "customer_name" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_update_1" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.customer_phone IS DISTINCT FROM NEW.customer_phone AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'orders' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_update_1"
AFTER UPDATE OF "customer_phone" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_update_2" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_update_2_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.customer_email IS DISTINCT FROM NEW.customer_email AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id AND col = 2 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_email, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'orders' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_update_2"
AFTER UPDATE OF "customer_email" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_update_2_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_delete" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_delete"
AFTER DELETE ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_insert" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.email, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'customers', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_insert"
AFTER INSERT ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_update" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.email, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'customers', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_update"
AFTER UPDATE OF "id" ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_update_0" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.name IS DISTINCT FROM NEW.name AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.name, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'customers' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_update_0"
AFTER UPDATE OF "name" ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_update_1" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.phone IS DISTINCT FROM NEW.phone AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.phone, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'customers' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_update_1"
AFTER UPDATE OF "phone" ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_update_2" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_update_2_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.email IS DISTINCT FROM NEW.email AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id AND col = 2 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.email, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'customers' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_update_2"
AFTER UPDATE OF "email" ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_update_2_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_delete" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_delete"
AFTER DELETE ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_insert" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.checkout_id, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.checkout_data, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'abandoned_checkouts', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_insert"
AFTER INSERT ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_update" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.checkout_id, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.checkout_data, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'abandoned_checkouts', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_update"
AFTER UPDATE OF "id" ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_update_0" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.customer_phone IS DISTINCT FROM NEW.customer_phone AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'abandoned_checkouts' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_update_0"
AFTER UPDATE OF "customer_phone" ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_update_1" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.checkout_id IS DISTINCT FROM NEW.checkout_id AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.checkout_id, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'abandoned_checkouts' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_update_1"
AFTER UPDATE OF "checkout_id" ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_update_2" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_2_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.checkout_data IS DISTINCT FROM NEW.checkout_data AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id AND col = 2 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.checkout_data, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'abandoned_checkouts' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_update_2"
AFTER UPDATE OF "checkout_data" ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_2_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_delete" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_delete"
AFTER DELETE ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_insert" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.label, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.target_value, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.target_id, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'navigation_menu_items', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_insert"
AFTER INSERT ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_update" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.label, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.target_value, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.target_id, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'navigation_menu_items', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_update"
AFTER UPDATE OF "id" ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_update_0" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.label IS DISTINCT FROM NEW.label AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.label, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'navigation_menu_items' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_update_0"
AFTER UPDATE OF "label" ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_update_1" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.target_value IS DISTINCT FROM NEW.target_value AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.target_value, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'navigation_menu_items' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_update_1"
AFTER UPDATE OF "target_value" ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_update_2" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_2_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.target_id IS DISTINCT FROM NEW.target_id AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id AND col = 2 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.target_id, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'navigation_menu_items' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_update_2"
AFTER UPDATE OF "target_id" ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_2_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_delete" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_delete"
AFTER DELETE ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_insert" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.title, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.body, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.author_display_name, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_reviews', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_insert"
AFTER INSERT ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_update" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.title, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.body, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.author_display_name, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_reviews', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_update"
AFTER UPDATE OF "id" ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_update_0" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_0_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.title IS DISTINCT FROM NEW.title AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id AND col = 0 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.title, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'product_reviews' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_update_0"
AFTER UPDATE OF "title" ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_0_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_update_1" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_1_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.body IS DISTINCT FROM NEW.body AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id AND col = 1 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.body, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'product_reviews' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_update_1"
AFTER UPDATE OF "body" ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_1_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_update_2" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_2_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.author_display_name IS DISTINCT FROM NEW.author_display_name AND OLD.id IS NOT DISTINCT FROM NEW.id), false) THEN
    RETURN NEW;
  END IF;
  WITH gone AS (DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id AND col = 2 RETURNING tf), words AS (SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(substr(NEW.author_display_name, 1, 2000)), ' ')) AS word(value) WHERE value <> ''), added AS (INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) UPDATE search_fts_terms SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) WHERE source = 'product_reviews' AND doc_id = NEW.id AND col = -1 AND term = '';
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_update_2"
AFTER UPDATE OF "author_display_name" ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_2_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_delete" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_delete"
AFTER DELETE ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_products_srch" ON "products";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_products_srch_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['srch']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_products_srch"
AFTER UPDATE ON "products"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."name" IS DISTINCT FROM NEW."name" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."category_id" IS DISTINCT FROM NEW."category_id" OR OLD."description_search_text" IS DISTINCT FROM NEW."description_search_text"))
EXECUTE FUNCTION scalius_compat."cdep_products_srch_fn"()
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_categories_srch" ON "categories";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_categories_srch_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['srch']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_categories_srch"
AFTER UPDATE ON "categories"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."name" IS DISTINCT FROM NEW."name" OR OLD."description" IS DISTINCT FROM NEW."description" OR OLD."description_search_text" IS DISTINCT FROM NEW."description_search_text"))
EXECUTE FUNCTION scalius_compat."cdep_categories_srch_fn"()
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cdep_pages_srch" ON "pages";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_pages_srch_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['pg:*']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_pages_srch"
AFTER UPDATE ON "pages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."content_search_text" IS DISTINCT FROM NEW."content_search_text"))
EXECUTE FUNCTION scalius_compat."cdep_pages_srch_fn"()
--> statement-breakpoint
DELETE FROM search_fts_terms WHERE NOT ((source = 'products' AND col = 1) OR (source = 'categories' AND col = 1) OR (source = 'pages' AND col = 1));
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM products AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', src.id, -1, '', coalesce(tokens.n, 0) FROM products AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'products' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM product_variants AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.sku, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', src.id, -1, '', coalesce(tokens.n, 0) FROM product_variants AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'product_variants' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM categories AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', src.id, -1, '', coalesce(tokens.n, 0) FROM categories AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'categories' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM pages AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.title, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', src.id, -1, '', coalesce(tokens.n, 0) FROM pages AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'pages' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.customer_name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.customer_email, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 3 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.id, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', src.id, -1, '', coalesce(tokens.n, 0) FROM orders AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'orders' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM customers AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.name, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM customers AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM customers AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.email, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', src.id, -1, '', coalesce(tokens.n, 0) FROM customers AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'customers' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM abandoned_checkouts AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.customer_phone, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM abandoned_checkouts AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.checkout_id, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM abandoned_checkouts AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.checkout_data, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', src.id, -1, '', coalesce(tokens.n, 0) FROM abandoned_checkouts AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM navigation_menu_items AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.label, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM navigation_menu_items AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.target_value, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM navigation_menu_items AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.target_id, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', src.id, -1, '', coalesce(tokens.n, 0) FROM navigation_menu_items AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'navigation_menu_items' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM product_reviews AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.title, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM product_reviews AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.body, 1, 2000)), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM product_reviews AS src, unnest(string_to_array(scalius_compat.search_fts_fold(substr(src.author_display_name, 1, 2000)), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term;
--> statement-breakpoint
INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', src.id, -1, '', coalesce(tokens.n, 0) FROM product_reviews AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM search_fts_terms WHERE source = 'product_reviews' AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (219, '0219_search_plain_text_and_unicode_fold', '4f88911c6c6e8f281020245d491e3f7291bafd0932369207cc0d18218d2d202c');
