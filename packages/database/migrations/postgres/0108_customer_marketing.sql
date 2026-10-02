-- Customers & marketing (FEATURE-ROADMAP 3-4): marketing consent per customer
-- and channel (email, sms, whatsapp) with a trigger-written audit log and the
-- customer.consent_changed event, customer tags, saved segments, the
-- trigger-maintained customer_order_stats segments filter on, and the
-- promotion to segment link (buyer-visible: it advances promo:<id>).
-- The notification outbox and its receipts accept a 'customer' subject (the
-- e-mail double opt-in confirmation): both tables are rebuilt in a
-- foreign-key-safe order (copy both, drop the child then the parent, rename
-- the parent first so the child's reference follows it), keeping every row.
-- Order statistics are backfilled from existing orders below.
CREATE TABLE "customer_marketing_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"channel" text NOT NULL,
	"previous_state" text,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"actor" text NOT NULL,
	"actor_id" text,
	"note" text,
	"contact" text NOT NULL,
	"consent_text_version" text,
	"consent_text" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "customer_marketing_consent_events_customer_idx" ON "customer_marketing_consent_events" ("customer_id","created_at");
--> statement-breakpoint
CREATE TABLE "customer_marketing_consents" (
	"customer_id" text NOT NULL,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"contact" text NOT NULL,
	"source" text NOT NULL,
	"actor" text NOT NULL,
	"actor_id" text,
	"note" text,
	"consent_text_version" text,
	"consent_text" text,
	"subscribed_at" bigint,
	"unsubscribed_at" bigint,
	"requested_at" bigint,
	"confirmation_hash" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("customer_id", "channel"),
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "customer_marketing_consents_channel_check" CHECK("customer_marketing_consents"."channel" IN ('email', 'sms', 'whatsapp')),
	CONSTRAINT "customer_marketing_consents_state_check" CHECK("customer_marketing_consents"."state" IN ('subscribed', 'unsubscribed', 'pending')),
	CONSTRAINT "customer_marketing_consents_source_check" CHECK("customer_marketing_consents"."source" IN ('checkout', 'account', 'newsletter', 'admin', 'import', 'plugin', 'link')),
	CONSTRAINT "customer_marketing_consents_actor_check" CHECK("customer_marketing_consents"."actor" IN ('buyer', 'staff', 'plugin', 'system')),
	CONSTRAINT "customer_marketing_consents_pending_email" CHECK("customer_marketing_consents"."state" <> 'pending' OR "customer_marketing_consents"."channel" = 'email'),
	CONSTRAINT "customer_marketing_consents_pending_shape" CHECK(("customer_marketing_consents"."state" = 'pending') = ("customer_marketing_consents"."confirmation_hash" IS NOT NULL AND "customer_marketing_consents"."requested_at" IS NOT NULL)),
	CONSTRAINT "customer_marketing_consents_subscribed_shape" CHECK("customer_marketing_consents"."state" <> 'subscribed' OR "customer_marketing_consents"."subscribed_at" IS NOT NULL),
	CONSTRAINT "customer_marketing_consents_contact_length" CHECK(length("customer_marketing_consents"."contact") BETWEEN 3 AND 320),
	CONSTRAINT "customer_marketing_consents_note_length" CHECK("customer_marketing_consents"."note" IS NULL OR length("customer_marketing_consents"."note") BETWEEN 1 AND 500),
	CONSTRAINT "customer_marketing_consents_text_length" CHECK(("customer_marketing_consents"."consent_text_version" IS NULL OR length("customer_marketing_consents"."consent_text_version") BETWEEN 3 AND 64) AND ("customer_marketing_consents"."consent_text" IS NULL OR length("customer_marketing_consents"."consent_text") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_marketing_consents_confirmation_unique" ON "customer_marketing_consents" ("confirmation_hash") WHERE "customer_marketing_consents"."confirmation_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "customer_marketing_consents_channel_state_idx" ON "customer_marketing_consents" ("channel","state","customer_id");
--> statement-breakpoint
CREATE TABLE "customer_order_stats" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"orders_count" bigint DEFAULT 0 NOT NULL,
	"total_spent_minor" bigint DEFAULT 0 NOT NULL,
	"first_order_at" bigint,
	"last_order_at" bigint,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "customer_order_stats_nonnegative" CHECK("customer_order_stats"."orders_count" >= 0 AND "customer_order_stats"."total_spent_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX "customer_order_stats_orders_idx" ON "customer_order_stats" ("orders_count");
--> statement-breakpoint
CREATE INDEX "customer_order_stats_spent_idx" ON "customer_order_stats" ("total_spent_minor");
--> statement-breakpoint
CREATE INDEX "customer_order_stats_first_order_idx" ON "customer_order_stats" ("first_order_at");
--> statement-breakpoint
CREATE INDEX "customer_order_stats_last_order_idx" ON "customer_order_stats" ("last_order_at");
--> statement-breakpoint
CREATE TABLE "customer_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"definition" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "customer_segments_id_shape" CHECK(substr("customer_segments"."id", 1, 4) = 'seg_' AND length("customer_segments"."id") BETWEEN 8 AND 40),
	CONSTRAINT "customer_segments_name_valid" CHECK("customer_segments"."name" = trim("customer_segments"."name") AND length("customer_segments"."name") BETWEEN 1 AND 80),
	CONSTRAINT "customer_segments_description_length" CHECK("customer_segments"."description" IS NULL OR length("customer_segments"."description") BETWEEN 1 AND 300),
	CONSTRAINT "customer_segments_definition_json" CHECK(json_valid("customer_segments"."definition") AND json_type("customer_segments"."definition") = 'object' AND length("customer_segments"."definition") <= 8000),
	CONSTRAINT "customer_segments_revision_positive" CHECK("customer_segments"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_segments_name_unique" ON "customer_segments" (lower("name")) WHERE "customer_segments"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "customer_segments_list_idx" ON "customer_segments" ("deleted_at","updated_at");
--> statement-breakpoint
CREATE TABLE "customer_tag_links" (
	"customer_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("customer_id", "tag"),
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "customer_tag_links_tag_shape" CHECK(length("customer_tag_links"."tag") BETWEEN 1 AND 40 AND "customer_tag_links"."tag" = trim("customer_tag_links"."tag") AND "customer_tag_links"."tag" = lower("customer_tag_links"."tag") AND position('  ' in "customer_tag_links"."tag") = 0 AND position(',' in "customer_tag_links"."tag") = 0)
);
--> statement-breakpoint
CREATE INDEX "customer_tag_links_tag_idx" ON "customer_tag_links" ("tag","customer_id");
--> statement-breakpoint
CREATE TABLE "promotion_customer_segments" (
	"promotion_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("promotion_id", "segment_id"),
	FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("segment_id") REFERENCES "customer_segments"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX "promotion_customer_segments_segment_idx" ON "promotion_customer_segments" ("segment_id");
--> statement-breakpoint
-- Notification outbox and receipts accept the 'customer' subject.
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_subject_type_check", ADD CONSTRAINT "notification_outbox_subject_type_check" CHECK("notification_outbox"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer'));
--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" DROP CONSTRAINT "notification_delivery_receipts_subject_type_check", ADD CONSTRAINT "notification_delivery_receipts_subject_type_check" CHECK("notification_delivery_receipts"."subject_type" IN ('order', 'conversation', 'gift_card', 'digital', 'customer'));
--> statement-breakpoint
-- Consent audit log: every state or address change, with who and why.
CREATE OR REPLACE FUNCTION scalius_compat."customer_marketing_consents_audit_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "customer_marketing_consent_events" ("id", "customer_id", "channel", "previous_state", "state", "source", "actor", "actor_id", "note", "contact", "consent_text_version", "consent_text") VALUES ('mce_' || NEW."customer_id" || '_' || NEW."channel" || '_' || ((SELECT count(*) FROM "customer_marketing_consent_events" WHERE "customer_id" = NEW."customer_id" AND "channel" = NEW."channel") + 1), NEW."customer_id", NEW."channel", NULL, NEW."state", NEW."source", NEW."actor", NEW."actor_id", NEW."note", NEW."contact", NEW."consent_text_version", NEW."consent_text");
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_marketing_consents_audit_ins"
AFTER INSERT ON "customer_marketing_consents"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_marketing_consents_audit_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_marketing_consents_audit_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."state" IS DISTINCT FROM NEW."state" OR OLD."contact" IS DISTINCT FROM NEW."contact"), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_marketing_consent_events" ("id", "customer_id", "channel", "previous_state", "state", "source", "actor", "actor_id", "note", "contact", "consent_text_version", "consent_text") VALUES ('mce_' || NEW."customer_id" || '_' || NEW."channel" || '_' || ((SELECT count(*) FROM "customer_marketing_consent_events" WHERE "customer_id" = NEW."customer_id" AND "channel" = NEW."channel") + 1), NEW."customer_id", NEW."channel", OLD."state", NEW."state", NEW."source", NEW."actor", NEW."actor_id", NEW."note", NEW."contact", NEW."consent_text_version", NEW."consent_text");
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_marketing_consents_audit_upd"
AFTER UPDATE ON "customer_marketing_consents"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_marketing_consents_audit_upd_fn"();
--> statement-breakpoint
-- customer_order_stats: recomputed from the customer's orders on every
-- order write that can change them (no drift; one indexed aggregate).
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."customer_id" IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(max("orders"."paid_amount_minor", 0)), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = NEW."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_order_stats_order_ins"
AFTER INSERT ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_order_stats_order_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."customer_id" IS NOT NULL AND (OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."paid_amount_minor" IS DISTINCT FROM NEW."paid_amount_minor" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR (OLD."status" IS DISTINCT FROM NEW."status" AND (OLD."status" = 'incomplete' OR NEW."status" = 'incomplete')))), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(max("orders"."paid_amount_minor", 0)), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = NEW."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_order_stats_order_upd"
AFTER UPDATE ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_order_stats_order_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."customer_id" IS NOT NULL AND OLD."customer_id" IS DISTINCT FROM NEW."customer_id"), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(max("orders"."paid_amount_minor", 0)), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = OLD."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "customer_order_stats_order_upd_old"
AFTER UPDATE ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_order_stats_order_upd_old_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."customer_order_stats_order_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD."customer_id" IS NOT NULL), false) THEN
    RETURN OLD;
  END IF;
  INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at", "updated_at") SELECT "customers"."id", count("orders"."id"), COALESCE(sum(max("orders"."paid_amount_minor", 0)), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)), unixepoch() FROM "customers" LEFT JOIN "orders" ON "orders"."customer_id" = "customers"."id" AND "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' WHERE "customers"."id" = OLD."customer_id" GROUP BY "customers"."id" ON CONFLICT ("customer_id") DO UPDATE SET "orders_count" = excluded."orders_count", "total_spent_minor" = excluded."total_spent_minor", "first_order_at" = excluded."first_order_at", "last_order_at" = excluded."last_order_at", "updated_at" = excluded."updated_at";
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "customer_order_stats_order_del"
AFTER DELETE ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."customer_order_stats_order_del_fn"();
--> statement-breakpoint
-- customer.consent_changed (event-outbox-triggers.ts, generated).
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_marketing_consents_created_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.consent_changed', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id", 'channel', NEW."channel", 'previousState', NULL, 'state', NEW."state", 'source', NEW."source")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_marketing_consents_created"
AFTER INSERT ON "customer_marketing_consents"
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."evt_customer_marketing_consents_created_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_marketing_consents_changed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.consent_changed', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id", 'channel', NEW."channel", 'previousState', OLD."state", 'state', NEW."state", 'source', NEW."source")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_marketing_consents_changed"
AFTER UPDATE ON "customer_marketing_consents"
FOR EACH ROW
WHEN ((OLD."state" IS DISTINCT FROM NEW."state"))
EXECUTE FUNCTION scalius_compat."evt_customer_marketing_consents_changed_fn"();
--> statement-breakpoint
-- promotion_customer_segments cache dependencies (cache-dep-triggers.ts, generated).
CREATE OR REPLACE FUNCTION scalius_compat."cdep_promotion_customer_segments_ins_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['promo:' || NEW."promotion_id", 'promo:*', 't:promotion_customer_segments']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_promotion_customer_segments_ins"
AFTER INSERT ON "promotion_customer_segments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_promotion_customer_segments_ins_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_promotion_customer_segments_del_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['promo:' || OLD."promotion_id", 'promo:*', 't:promotion_customer_segments']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_promotion_customer_segments_del"
AFTER DELETE ON "promotion_customer_segments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION scalius_compat."cdep_promotion_customer_segments_del_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_promotion_customer_segments_upd_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['promo:' || NEW."promotion_id", 'promo:*', 't:promotion_customer_segments']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_promotion_customer_segments_upd"
AFTER UPDATE ON "promotion_customer_segments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."promotion_id" IS DISTINCT FROM NEW."promotion_id" OR OLD."segment_id" IS DISTINCT FROM NEW."segment_id"))
EXECUTE FUNCTION scalius_compat."cdep_promotion_customer_segments_upd_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."cdep_promotion_customer_segments_upd_old_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  PERFORM scalius_compat."cache_dep_bump"(ARRAY(SELECT key_list.value AS dep FROM unnest(ARRAY['promo:' || OLD."promotion_id", 'promo:*', 't:promotion_customer_segments']::text[]) AS key_list(value)));
  RETURN NULL;
END
$trigger_function$;
CREATE CONSTRAINT TRIGGER "cdep_promotion_customer_segments_upd_old"
AFTER UPDATE ON "promotion_customer_segments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((OLD."promotion_id" IS DISTINCT FROM NEW."promotion_id"))
EXECUTE FUNCTION scalius_compat."cdep_promotion_customer_segments_upd_old_fn"();
--> statement-breakpoint
-- Order statistics for every customer with real orders; a customer without a
-- row has none (readers treat a missing row as zeros).
INSERT INTO "customer_order_stats" ("customer_id", "orders_count", "total_spent_minor", "first_order_at", "last_order_at") SELECT "orders"."customer_id", count(*), COALESCE(sum(max("orders"."paid_amount_minor", 0)), 0), min(CAST("orders"."created_at" AS bigint)), max(CAST("orders"."created_at" AS bigint)) FROM "orders" JOIN "customers" ON "customers"."id" = "orders"."customer_id" WHERE "orders"."deleted_at" IS NULL AND "orders"."status" <> 'incomplete' GROUP BY "orders"."customer_id";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (108, '0108_customer_marketing', 'a4b6972ec3a9e64299d547b220d4682a84a8885d02f78cc2868ae4510e8bb77e');
