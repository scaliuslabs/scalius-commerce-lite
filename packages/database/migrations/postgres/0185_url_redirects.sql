-- URL redirects (see ../0185_url_redirects.sql).
CREATE TABLE "url_redirects" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"from_path" text COLLATE "C" NOT NULL,
	"to_path" text COLLATE "C" NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "url_redirects_paths" CHECK(substr("from_path", 1, 1) = '/' AND substr("to_path", 1, 1) = '/' AND "from_path" <> "to_path")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "url_redirects_from_path_unique" ON "url_redirects" ("from_path");
--> statement-breakpoint
CREATE INDEX "url_redirects_to_path_idx" ON "url_redirects" ("to_path");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_url_redirects_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['rd', 't:url_redirects']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_url_redirects_ins"
AFTER INSERT ON "url_redirects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_url_redirects_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_url_redirects_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['rd', 't:url_redirects']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_url_redirects_del"
AFTER DELETE ON "url_redirects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_url_redirects_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_url_redirects_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['rd', 't:url_redirects']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_url_redirects_upd"
AFTER UPDATE ON "url_redirects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."id" IS DISTINCT FROM NEW."id" OR OLD."from_path" IS DISTINCT FROM NEW."from_path" OR OLD."to_path" IS DISTINCT FROM NEW."to_path"))
EXECUTE FUNCTION scalius_compat."cdep_url_redirects_upd_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (185, '0185_url_redirects', '13670fb5240828ba6920b7341b8a9ec78294cf1ee48698749e3338b750ecb327');
