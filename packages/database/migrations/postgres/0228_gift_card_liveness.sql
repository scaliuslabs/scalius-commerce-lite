-- See ../0228_gift_card_liveness.sql.
CREATE INDEX "gift_cards_live_idx" ON "gift_cards" ("currency_code", "expires_at") WHERE "gift_cards"."status" = 'active' AND "gift_cards"."balance_minor" > 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_gift_cards_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['gc', 't:gift_cards']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_gift_cards_ins"
AFTER INSERT ON "gift_cards"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_gift_cards_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_gift_cards_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['gc', 't:gift_cards']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_gift_cards_del"
AFTER DELETE ON "gift_cards"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_gift_cards_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_gift_cards_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['gc', 't:gift_cards']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_gift_cards_upd"
AFTER UPDATE ON "gift_cards"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."status" IS DISTINCT FROM NEW."status" OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at"))
EXECUTE FUNCTION scalius_compat."cdep_gift_cards_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_gift_cards_upd_balance_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['gc', 't:gift_cards']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_gift_cards_upd_balance"
AFTER UPDATE ON "gift_cards"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."balance_minor" IS DISTINCT FROM NEW."balance_minor") AND NEW."balance_minor" = 0)
EXECUTE FUNCTION scalius_compat."cdep_gift_cards_upd_balance_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_gift_cards_upd_balance_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['gc', 't:gift_cards']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_gift_cards_upd_balance_old"
AFTER UPDATE ON "gift_cards"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."balance_minor" IS DISTINCT FROM NEW."balance_minor") AND OLD."balance_minor" = 0)
EXECUTE FUNCTION scalius_compat."cdep_gift_cards_upd_balance_old_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (228, '0228_gift_card_liveness', '2cde3162b5fb28753306c6492e12cbac94a6bf3df85e10a8a355b827832a5324');
