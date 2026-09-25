-- Gift cards (Wave B §4, §6.4). Expand-only: new tables and triggers. A card
-- is found by an HMAC of its code and re-shown from a ciphertext (both keyed
-- from CREDENTIAL_ENCRYPTION_KEY). Its balance starts at zero and only the
-- append-only transaction ledger moves it (G1): guards refuse an overdraft, a
-- redemption of a disabled or expired card, and a wrong running balance; the
-- projection then sets the balance, and a guard on the card proves the
-- balance equals the sum of its transactions.
CREATE TABLE "gift_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"code_ciphertext" text NOT NULL,
	"code_last4" text NOT NULL,
	"currency_code" text NOT NULL,
	"initial_amount_minor" bigint NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" bigint,
	"source" text NOT NULL,
	"source_order_id" text,
	"source_order_item_id" text,
	"source_unit_index" bigint,
	"source_refund_attempt_id" text,
	"customer_id" text,
	"recipient_name" text,
	"recipient_email" text,
	"recipient_phone" text,
	"message" text,
	"note" text,
	"issued_by_user_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("source_order_item_id") REFERENCES "order_items"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("source_refund_attempt_id") REFERENCES "refund_attempts"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("issued_by_user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "gift_cards_id_shape" CHECK(substr("gift_cards"."id", 1, 3) = 'gc_' AND length("gift_cards"."id") BETWEEN 11 AND 67),
	CONSTRAINT "gift_cards_last4_shape" CHECK(length("gift_cards"."code_last4") = 4),
	CONSTRAINT "gift_cards_currency_shape" CHECK(length("gift_cards"."currency_code") = 3),
	CONSTRAINT "gift_cards_initial_positive" CHECK("gift_cards"."initial_amount_minor" > 0),
	CONSTRAINT "gift_cards_balance_nonnegative" CHECK("gift_cards"."balance_minor" >= 0),
	CONSTRAINT "gift_cards_status_check" CHECK("gift_cards"."status" IN ('active', 'disabled')),
	CONSTRAINT "gift_cards_source_check" CHECK("gift_cards"."source" IN ('purchase', 'manual', 'refund')),
	CONSTRAINT "gift_cards_purchase_shape" CHECK("gift_cards"."source" <> 'purchase' OR ("gift_cards"."source_order_id" IS NOT NULL AND "gift_cards"."source_order_item_id" IS NOT NULL AND "gift_cards"."source_unit_index" IS NOT NULL AND "gift_cards"."source_unit_index" >= 0)),
	CONSTRAINT "gift_cards_refund_shape" CHECK("gift_cards"."source" <> 'refund' OR "gift_cards"."source_refund_attempt_id" IS NOT NULL),
	CONSTRAINT "gift_cards_recipient_single_contact" CHECK("gift_cards"."recipient_email" IS NULL OR "gift_cards"."recipient_phone" IS NULL),
	CONSTRAINT "gift_cards_recipient_name_length" CHECK("gift_cards"."recipient_name" IS NULL OR length("gift_cards"."recipient_name") BETWEEN 1 AND 120),
	CONSTRAINT "gift_cards_message_length" CHECK("gift_cards"."message" IS NULL OR length("gift_cards"."message") BETWEEN 1 AND 200),
	CONSTRAINT "gift_cards_note_length" CHECK("gift_cards"."note" IS NULL OR length("gift_cards"."note") BETWEEN 1 AND 500),
	CONSTRAINT "gift_cards_version_positive" CHECK("gift_cards"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_hash_unique" ON "gift_cards" ("code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_purchase_unit_unique" ON "gift_cards" ("source_order_item_id","source_unit_index") WHERE "gift_cards"."source" = 'purchase';
--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_refund_attempt_unique" ON "gift_cards" ("source_refund_attempt_id") WHERE "gift_cards"."source" = 'refund';
--> statement-breakpoint
CREATE INDEX "gift_cards_customer_idx" ON "gift_cards" ("customer_id","created_at" DESC) WHERE "gift_cards"."customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "gift_cards_status_created_idx" ON "gift_cards" ("status","created_at" DESC,"id");
--> statement-breakpoint
CREATE INDEX "gift_cards_last4_idx" ON "gift_cards" ("code_last4");
--> statement-breakpoint
CREATE INDEX "gift_cards_source_order_idx" ON "gift_cards" ("source_order_id") WHERE "gift_cards"."source_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "gift_card_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"gift_card_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"order_id" text,
	"order_payment_id" text,
	"refund_attempt_id" text,
	"idempotency_key" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("gift_card_id") REFERENCES "gift_cards"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_payment_id") REFERENCES "order_payments"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("refund_attempt_id") REFERENCES "refund_attempts"("id") ON UPDATE no action ON DELETE restrict DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "gift_card_transactions_id_shape" CHECK(substr("gift_card_transactions"."id", 1, 4) = 'gct_' AND length("gift_card_transactions"."id") BETWEEN 12 AND 68),
	CONSTRAINT "gift_card_transactions_kind_check" CHECK("gift_card_transactions"."kind" IN ('issue', 'redeem', 'release', 'refund', 'adjust')),
	CONSTRAINT "gift_card_transactions_amount_sign" CHECK("gift_card_transactions"."amount_minor" <> 0 AND ("gift_card_transactions"."kind" <> 'redeem' OR "gift_card_transactions"."amount_minor" < 0) AND ("gift_card_transactions"."kind" NOT IN ('issue', 'release', 'refund') OR "gift_card_transactions"."amount_minor" > 0)),
	CONSTRAINT "gift_card_transactions_balance_nonnegative" CHECK("gift_card_transactions"."balance_after_minor" >= 0),
	CONSTRAINT "gift_card_transactions_actor_type_check" CHECK("gift_card_transactions"."actor_type" IN ('system', 'admin', 'customer')),
	CONSTRAINT "gift_card_transactions_idempotency_length" CHECK(length(trim("gift_card_transactions"."idempotency_key")) BETWEEN 1 AND 200),
	CONSTRAINT "gift_card_transactions_reason_length" CHECK("gift_card_transactions"."reason" IS NULL OR length("gift_card_transactions"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "gift_card_transactions_adjust_reason" CHECK("gift_card_transactions"."kind" <> 'adjust' OR "gift_card_transactions"."reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_transactions_idempotency_unique" ON "gift_card_transactions" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "gift_card_transactions_card_created_idx" ON "gift_card_transactions" ("gift_card_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "gift_card_transactions_order_idx" ON "gift_card_transactions" ("order_id") WHERE "gift_card_transactions"."order_id" IS NOT NULL;
--> statement-breakpoint
-- A card is born empty; its `issue` transaction funds it.
CREATE OR REPLACE FUNCTION scalius_compat."gift_cards_insert_zero_balance_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."balance_minor" <> 0), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card balance starts at zero';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_cards_insert_zero_balance"
BEFORE INSERT ON "gift_cards"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_cards_insert_zero_balance_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_cards_identity_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."id" IS DISTINCT FROM OLD."id"
  OR NEW."code_hash" IS DISTINCT FROM OLD."code_hash"
  OR NEW."code_ciphertext" IS DISTINCT FROM OLD."code_ciphertext"
  OR NEW."code_last4" IS DISTINCT FROM OLD."code_last4"
  OR NEW."initial_amount_minor" IS DISTINCT FROM OLD."initial_amount_minor"
  OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
  OR NEW."source" IS DISTINCT FROM OLD."source"
  OR NEW."source_order_id" IS DISTINCT FROM OLD."source_order_id"
  OR NEW."source_order_item_id" IS DISTINCT FROM OLD."source_order_item_id"
  OR NEW."source_unit_index" IS DISTINCT FROM OLD."source_unit_index"
  OR NEW."source_refund_attempt_id" IS DISTINCT FROM OLD."source_refund_attempt_id"), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card identity is immutable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_cards_identity_immutable"
BEFORE UPDATE OF "id", "code_hash", "code_ciphertext", "code_last4", "initial_amount_minor", "currency_code", "source", "source_order_id", "source_order_item_id", "source_unit_index", "source_refund_attempt_id" ON "gift_cards"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_cards_identity_immutable_fn"();
--> statement-breakpoint
-- G1: only the transaction ledger moves a balance.
CREATE OR REPLACE FUNCTION scalius_compat."gift_cards_balance_projection_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."balance_minor" IS DISTINCT FROM (
  SELECT coalesce(sum(t."amount_minor"), 0) FROM "gift_card_transactions" AS t
  WHERE t."gift_card_id" = NEW."id"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card balance moves only through transactions';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_cards_balance_projection_guard"
BEFORE UPDATE OF "balance_minor" ON "gift_cards"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_cards_balance_projection_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_cards_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift cards are durable records';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_cards_delete_blocked"
BEFORE DELETE ON "gift_cards"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_cards_delete_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_card_transactions_balance_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((coalesce((SELECT c."balance_minor" FROM "gift_cards" AS c WHERE c."id" = NEW."gift_card_id"), 0) + NEW."amount_minor" < 0), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card balance';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_card_transactions_balance_guard"
BEFORE INSERT ON "gift_card_transactions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_card_transactions_balance_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_card_transactions_redeem_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."kind" = 'redeem'
  AND NOT EXISTS (
    SELECT 1 FROM "gift_cards" AS c
    WHERE c."id" = NEW."gift_card_id"
      AND c."status" = 'active'
      AND coalesce(c."expires_at", 9223372036854775807) > unixepoch()
  )), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card unavailable';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_card_transactions_redeem_guard"
BEFORE INSERT ON "gift_card_transactions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_card_transactions_redeem_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_card_transactions_balance_after_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((NEW."balance_after_minor" IS DISTINCT FROM (
  SELECT c."balance_minor" + NEW."amount_minor" FROM "gift_cards" AS c WHERE c."id" = NEW."gift_card_id"
)), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card running balance mismatch';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_card_transactions_balance_after_guard"
BEFORE INSERT ON "gift_card_transactions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_card_transactions_balance_after_guard_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_card_transactions_project_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  UPDATE "gift_cards"
  SET "balance_minor" = "balance_minor" + NEW."amount_minor",
      "version" = "version" + 1,
      "updated_at" = unixepoch()
  WHERE "id" = NEW."gift_card_id";
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_card_transactions_project_insert"
AFTER INSERT ON "gift_card_transactions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_card_transactions_project_insert_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_card_transactions_update_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card transactions are append-only';
  RETURN NEW;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_card_transactions_update_blocked"
BEFORE UPDATE ON "gift_card_transactions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_card_transactions_update_blocked_fn"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."gift_card_transactions_delete_blocked_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gift card transactions are append-only';
  RETURN OLD;
END
$trigger_function$;
--> statement-breakpoint
CREATE TRIGGER "gift_card_transactions_delete_blocked"
BEFORE DELETE ON "gift_card_transactions"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."gift_card_transactions_delete_blocked_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (95, '0095_gift_cards', 'fd607d50e3f023546e39295dcef0511471a4437b2fdde71261c0b9fe0dcbd800');
