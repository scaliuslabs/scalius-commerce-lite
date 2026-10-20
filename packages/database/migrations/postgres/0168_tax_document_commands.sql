-- App tax-provider documents as durable commands (MARKETS-DESIGN D8): the
-- order commit owes the provider a `commit`, a cancellation a `void` and a
-- confirmed refund payment a `refund` with its share of the order's tax.
-- Each command is written by a trigger in the same transaction as the write
-- that owes it, and drained after the response and by the scheduled runner
-- with backoff. Orders on the built-in `system` provider write nothing.
CREATE TABLE "tax_document_commands" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"operation" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"provider_id" text COLLATE "C" NOT NULL,
	"calculation_id" text COLLATE "C" NOT NULL,
	"refund_id" text COLLATE "C",
	"amount_minor" bigint,
	"tax_minor" bigint,
	"status" text COLLATE "C" DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text COLLATE "C",
	"claim_expires_at" bigint,
	"document_id" text COLLATE "C",
	"last_error" text COLLATE "C",
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "tax_document_commands_operation_check" CHECK("tax_document_commands"."operation" IN ('commit', 'void', 'refund')),
	CONSTRAINT "tax_document_commands_status_check" CHECK("tax_document_commands"."status" IN ('pending', 'processing', 'done', 'failed', 'skipped', 'dead')),
	CONSTRAINT "tax_document_commands_refund_shape" CHECK(("tax_document_commands"."operation" = 'refund') = ("tax_document_commands"."refund_id" IS NOT NULL AND "tax_document_commands"."amount_minor" IS NOT NULL AND "tax_document_commands"."tax_minor" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "tax_document_commands_due_idx" ON "tax_document_commands" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "tax_document_commands_claim_idx" ON "tax_document_commands" ("status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "tax_document_commands_order_idx" ON "tax_document_commands" ("order_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_document_commit_on_snapshot_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "tax_document_commands" ("id", "operation", "order_id", "provider_id", "calculation_id")
  VALUES ('tax-commit:' || NEW."order_id", 'commit', NEW."order_id", NEW."provider_id", NEW."provider_calculation_id")
  ON CONFLICT ("id") DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "tax_document_commit_on_snapshot"
AFTER INSERT ON "order_tax_snapshots"
FOR EACH ROW
WHEN (NEW."provider_id" <> 'system' AND NEW."provider_calculation_id" IS NOT NULL)
EXECUTE FUNCTION scalius_compat."tax_document_commit_on_snapshot_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_document_void_on_cancel_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "tax_document_commands" ("id", "operation", "order_id", "provider_id", "calculation_id")
  SELECT 'tax-void:' || "snapshot"."order_id", 'void', "snapshot"."order_id", "snapshot"."provider_id", "snapshot"."provider_calculation_id"
  FROM "order_tax_snapshots" AS "snapshot"
  WHERE "snapshot"."order_id" = NEW."id" AND "snapshot"."provider_id" <> 'system' AND "snapshot"."provider_calculation_id" IS NOT NULL
  ON CONFLICT ("id") DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "tax_document_void_on_cancel"
AFTER UPDATE OF "status" ON "orders"
FOR EACH ROW
WHEN (NEW."status" = 'cancelled' AND OLD."status" IS DISTINCT FROM 'cancelled')
EXECUTE FUNCTION scalius_compat."tax_document_void_on_cancel_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."tax_document_refund_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "tax_document_commands" ("id", "operation", "order_id", "provider_id", "calculation_id", "refund_id", "amount_minor", "tax_minor")
  SELECT 'tax-refund:' || NEW."order_id" || ':' || NEW."id", 'refund', NEW."order_id", "snapshot"."provider_id", "snapshot"."provider_calculation_id", NEW."id", NEW."amount_minor",
    LEAST("taxed"."tax_amount_minor", (NEW."amount_minor" * "taxed"."tax_amount_minor") / GREATEST("taxed"."total_amount_minor", 1))
  FROM "order_tax_snapshots" AS "snapshot"
  INNER JOIN "orders" AS "taxed" ON "taxed"."id" = "snapshot"."order_id"
  WHERE "snapshot"."order_id" = NEW."order_id" AND "snapshot"."provider_id" <> 'system' AND "snapshot"."provider_calculation_id" IS NOT NULL
  ON CONFLICT ("id") DO NOTHING;
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "tax_document_refund_insert"
AFTER INSERT ON "order_payments"
FOR EACH ROW
WHEN (NEW."payment_type" = 'refund' AND NEW."status" = 'refunded')
EXECUTE FUNCTION scalius_compat."tax_document_refund_fn"();
--> statement-breakpoint
CREATE TRIGGER "tax_document_refund_update"
AFTER UPDATE OF "status" ON "order_payments"
FOR EACH ROW
WHEN (NEW."payment_type" = 'refund' AND NEW."status" = 'refunded' AND OLD."status" IS DISTINCT FROM 'refunded')
EXECUTE FUNCTION scalius_compat."tax_document_refund_fn"();
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (168, '0168_tax_document_commands', '4be963196e5a3977f80b9594e3414313266336a813691c57797c73df8e68a3ed');
