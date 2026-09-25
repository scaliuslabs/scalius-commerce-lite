-- unixepoch(epoch, 'unixepoch', '+N days|months|years') with SQLite's
-- calendar rules: months and years keep the day of month and let it overflow
-- into the next month (Jan 31 + 1 month = Mar 3 in a common year), as the
-- warranty expiry trigger computes on D1/Turso.
CREATE OR REPLACE FUNCTION public.unixepoch(epoch_seconds bigint, modifier text, shift text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  parts text[];
  amount bigint;
  unit text;
  base_timestamp timestamp;
  total_months bigint;
  seconds_into_day bigint;
BEGIN
  IF lower(modifier) <> 'unixepoch' THEN
    RAISE EXCEPTION 'unsupported unixepoch() modifier: %', modifier USING ERRCODE = '22023';
  END IF;
  parts := regexp_match(shift, '^\s*([+-]?[0-9]+)\s+(days?|months?|years?)\s*$', 'i');
  IF parts IS NULL THEN
    RAISE EXCEPTION 'unsupported unixepoch() modifier: %', shift USING ERRCODE = '22023';
  END IF;
  amount := parts[1]::bigint;
  unit := lower(parts[2]);
  IF unit LIKE 'day%' THEN
    RETURN epoch_seconds + amount * 86400;
  END IF;
  IF unit LIKE 'year%' THEN
    amount := amount * 12;
  END IF;
  base_timestamp := to_timestamp(epoch_seconds) AT TIME ZONE 'UTC';
  total_months := extract(year FROM base_timestamp)::bigint * 12
    + extract(month FROM base_timestamp)::bigint - 1 + amount;
  seconds_into_day := epoch_seconds
    - floor(extract(epoch FROM date_trunc('day', base_timestamp) AT TIME ZONE 'UTC'))::bigint;
  RETURN floor(extract(epoch FROM make_timestamp(
      (total_months / 12)::integer, (total_months % 12 + 1)::integer, 1, 0, 0, 0
    ) AT TIME ZONE 'UTC'))::bigint
    + (extract(day FROM base_timestamp)::bigint - 1) * 86400
    + seconds_into_day;
END
$function$;
--> statement-breakpoint
-- Warranty (Wave B §5, §6.5). Expand-only: new tables, two nullable columns
-- and triggers whose guards are false for everything the previous API writes
-- (it never sets a warranty revision on a line). Policies are reusable and
-- revisioned; revisions are immutable (W2) and the line's revision is frozen
-- at commit. Each fulfilment line of a line with a revision creates exactly one
-- warranty record (W1): it starts at the handover (the fulfilment's time) and
-- expires by the revision's duration using SQLite date arithmetic (month-end
-- overflow included; the PostgreSQL profile mirrors it, W3). Voiding the
-- fulfilment voids its warranties.
CREATE TABLE "warranty_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"duration_value" bigint NOT NULL,
	"duration_unit" text NOT NULL,
	"replacement_days" bigint,
	"terms" text,
	"current_revision_id" text NOT NULL,
	"archived_at" bigint,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "warranty_policies_id_shape" CHECK(substr("warranty_policies"."id", 1, 4) = 'wrp_' AND length("warranty_policies"."id") BETWEEN 12 AND 68),
	CONSTRAINT "warranty_policies_name_length" CHECK(length(trim("warranty_policies"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "warranty_policies_provider_check" CHECK("warranty_policies"."provider" IN ('brand', 'store')),
	CONSTRAINT "warranty_policies_duration_range" CHECK("warranty_policies"."duration_value" BETWEEN 1 AND 120),
	CONSTRAINT "warranty_policies_duration_unit_check" CHECK("warranty_policies"."duration_unit" IN ('days', 'months', 'years')),
	CONSTRAINT "warranty_policies_replacement_range" CHECK("warranty_policies"."replacement_days" IS NULL OR "warranty_policies"."replacement_days" BETWEEN 0 AND 90),
	CONSTRAINT "warranty_policies_terms_length" CHECK("warranty_policies"."terms" IS NULL OR length("warranty_policies"."terms") <= 4000),
	CONSTRAINT "warranty_policies_version_positive" CHECK("warranty_policies"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "warranty_policies_archived_idx" ON "warranty_policies" ("archived_at","name");
--> statement-breakpoint
CREATE TABLE "warranty_policy_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"duration_value" bigint NOT NULL,
	"duration_unit" text NOT NULL,
	"replacement_days" bigint,
	"terms" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("policy_id") REFERENCES "warranty_policies"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "warranty_policy_revisions_id_shape" CHECK(substr("warranty_policy_revisions"."id", 1, 4) = 'wrr_' AND length("warranty_policy_revisions"."id") BETWEEN 12 AND 68),
	CONSTRAINT "warranty_policy_revisions_revision_positive" CHECK("warranty_policy_revisions"."revision" >= 1),
	CONSTRAINT "warranty_policy_revisions_name_length" CHECK(length(trim("warranty_policy_revisions"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "warranty_policy_revisions_provider_check" CHECK("warranty_policy_revisions"."provider" IN ('brand', 'store')),
	CONSTRAINT "warranty_policy_revisions_duration_range" CHECK("warranty_policy_revisions"."duration_value" BETWEEN 1 AND 120),
	CONSTRAINT "warranty_policy_revisions_duration_unit_check" CHECK("warranty_policy_revisions"."duration_unit" IN ('days', 'months', 'years')),
	CONSTRAINT "warranty_policy_revisions_replacement_range" CHECK("warranty_policy_revisions"."replacement_days" IS NULL OR "warranty_policy_revisions"."replacement_days" BETWEEN 0 AND 90),
	CONSTRAINT "warranty_policy_revisions_terms_length" CHECK("warranty_policy_revisions"."terms" IS NULL OR length("warranty_policy_revisions"."terms") <= 4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_policy_revisions_policy_revision_unique" ON "warranty_policy_revisions" ("policy_id","revision");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."warranty_policy_revisions_update_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'warranty policy revisions are immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "warranty_policy_revisions_update_blocked"
BEFORE UPDATE ON "warranty_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."warranty_policy_revisions_update_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."warranty_policy_revisions_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'warranty policy revisions are immutable';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "warranty_policy_revisions_delete_blocked"
BEFORE DELETE ON "warranty_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."warranty_policy_revisions_delete_blocked_fn"();
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "warranty_policy_id" text REFERENCES warranty_policies(id) ON DELETE set null DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX "products_warranty_policy_idx" ON "products" ("warranty_policy_id") WHERE "products"."warranty_policy_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "warranty_revision_id" text REFERENCES warranty_policy_revisions(id) ON DELETE restrict DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_items_warranty_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."warranty_revision_id" IS DISTINCT FROM OLD."warranty_revision_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order line warranty is frozen at commit';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_items_warranty_immutable"
BEFORE UPDATE OF "warranty_revision_id" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_items_warranty_immutable_fn"();
--> statement-breakpoint
CREATE TABLE "order_item_warranties" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"fulfillment_id" text NOT NULL,
	"fulfillment_line_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"quantity" bigint NOT NULL,
	"starts_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"replacement_until" bigint,
	"voided_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("fulfillment_id") REFERENCES "order_fulfillments"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("fulfillment_line_id") REFERENCES "order_fulfillment_lines"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("revision_id") REFERENCES "warranty_policy_revisions"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "order_item_warranties_quantity_positive" CHECK("order_item_warranties"."quantity" > 0),
	CONSTRAINT "order_item_warranties_window" CHECK("order_item_warranties"."expires_at" > "order_item_warranties"."starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_warranties_fulfillment_line_unique" ON "order_item_warranties" ("fulfillment_line_id");
--> statement-breakpoint
CREATE INDEX "order_item_warranties_order_idx" ON "order_item_warranties" ("order_id");
--> statement-breakpoint
CREATE INDEX "order_item_warranties_order_item_idx" ON "order_item_warranties" ("order_item_id");
--> statement-breakpoint
CREATE INDEX "order_item_warranties_fulfillment_idx" ON "order_item_warranties" ("fulfillment_id");
--> statement-breakpoint
CREATE INDEX "order_item_warranties_active_expiry_idx" ON "order_item_warranties" ("expires_at") WHERE "order_item_warranties"."voided_at" IS NULL;
--> statement-breakpoint
-- W1: one warranty per handed-over fulfilment line of a line with a frozen revision.
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillment_lines_warranty_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce(((SELECT i."warranty_revision_id" FROM "order_items" AS i WHERE i."id" = NEW."order_item_id") IS NOT NULL), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "order_item_warranties" ("id", "order_id", "order_item_id", "fulfillment_id", "fulfillment_line_id", "revision_id", "quantity", "starts_at", "expires_at", "replacement_until")
  SELECT 'wty_' || NEW."id", NEW."order_id", NEW."order_item_id", NEW."fulfillment_id", NEW."id", r."id", NEW."quantity", f."created_at",
    unixepoch(f."created_at", 'unixepoch', '+' || r."duration_value" || ' ' || r."duration_unit"),
    f."created_at" + r."replacement_days" * 86400
  FROM "order_items" AS i
  JOIN "warranty_policy_revisions" AS r ON r."id" = i."warranty_revision_id"
  JOIN "order_fulfillments" AS f ON f."id" = NEW."fulfillment_id"
  WHERE i."id" = NEW."order_item_id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillment_lines_warranty_insert"
AFTER INSERT ON "order_fulfillment_lines"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillment_lines_warranty_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."order_fulfillments_warranty_void_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."status" = 'voided' AND OLD."status" IS DISTINCT FROM 'voided'), false) THEN
    RETURN NEW;
  END IF;
  UPDATE "order_item_warranties"
  SET "voided_at" = coalesce(NEW."voided_at", unixepoch())
  WHERE "fulfillment_id" = NEW."id" AND "voided_at" IS NULL;
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "order_fulfillments_warranty_void"
AFTER UPDATE OF "status" ON "order_fulfillments"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."order_fulfillments_warranty_void_fn"();
--> statement-breakpoint
CREATE TABLE "warranty_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"warranty_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"quantity" bigint DEFAULT 1 NOT NULL,
	"opened_by" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"closed_at" bigint,
	FOREIGN KEY ("warranty_id") REFERENCES "order_item_warranties"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "warranty_claims_id_shape" CHECK(substr("warranty_claims"."id", 1, 4) = 'wcl_' AND length("warranty_claims"."id") BETWEEN 12 AND 68),
	CONSTRAINT "warranty_claims_status_check" CHECK("warranty_claims"."status" IN ('open', 'in_progress', 'resolved', 'rejected')),
	CONSTRAINT "warranty_claims_resolution_check" CHECK("warranty_claims"."resolution" IS NULL OR "warranty_claims"."resolution" IN ('repair', 'replacement', 'refund', 'other')),
	CONSTRAINT "warranty_claims_resolved_shape" CHECK("warranty_claims"."status" <> 'resolved' OR "warranty_claims"."resolution" IS NOT NULL),
	CONSTRAINT "warranty_claims_closed_shape" CHECK(("warranty_claims"."status" IN ('resolved', 'rejected') AND "warranty_claims"."closed_at" IS NOT NULL) OR ("warranty_claims"."status" IN ('open', 'in_progress') AND "warranty_claims"."closed_at" IS NULL)),
	CONSTRAINT "warranty_claims_quantity_positive" CHECK("warranty_claims"."quantity" >= 1),
	CONSTRAINT "warranty_claims_opened_by_check" CHECK("warranty_claims"."opened_by" IN ('customer', 'guest_receipt', 'staff')),
	CONSTRAINT "warranty_claims_version_positive" CHECK("warranty_claims"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_claims_conversation_unique" ON "warranty_claims" ("conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_claims_open_unique" ON "warranty_claims" ("warranty_id") WHERE "warranty_claims"."status" IN ('open', 'in_progress');
--> statement-breakpoint
CREATE INDEX "warranty_claims_status_created_idx" ON "warranty_claims" ("status","created_at" DESC,"id");
--> statement-breakpoint
CREATE INDEX "warranty_claims_order_idx" ON "warranty_claims" ("order_id");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (98, '0098_warranty', '14c9d0b08f87f5ad5cd87ec3e57fe5dc119008f3923975f400af5d54ecf3e2d7');
