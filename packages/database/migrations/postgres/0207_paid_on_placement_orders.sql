-- Orders paid as they were placed (a point-of-sale sale; staff's Mark as
-- paid) were committed as net_terms invoices with terms and a due date. They
-- become `manual` with no terms or due date, as orders placed now are.
-- The rewrite is a correction, not news: event demand is held for the update
-- so no order.updated is enqueued, then restored in the same transaction.
-- The analytics triggers re-project each order's facts and unseal its days.
CREATE TABLE "migration_event_demand_hold" ("filter" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO "migration_event_demand_hold" ("filter") SELECT "filter" FROM "event_demand";
--> statement-breakpoint
DELETE FROM "event_demand";
--> statement-breakpoint
-- Exactly the orders paid at creation, proven by their rows: a sale's
-- pos_sale receipt fact (committed with the order); or, for a staff order,
-- the whole total recorded by staff as its first payment, with its timeline
-- line, within 30 seconds of the order (the same request). A real invoice
-- (paid later, in part, by an app or at checkout) never matches.
UPDATE "orders"
SET "payment_method" = 'manual', "payment_terms_days" = NULL, "payment_due_at" = NULL, "updated_at" = unixepoch()
WHERE "payment_method" = 'net_terms'
  AND (
    ("channel" = 'pos' AND EXISTS (
      SELECT 1 FROM "order_events" e WHERE e."order_id" = "orders"."id" AND e."kind" = 'pos_sale'
    ))
    OR ("channel" = 'admin' AND EXISTS (
      SELECT 1 FROM "order_payments" p
      WHERE p."order_id" = "orders"."id"
        AND p."payment_method" = 'manual'
        AND p."payment_type" = 'full'
        AND p."amount_minor" = "orders"."total_amount_minor"
        AND substr((p."metadata"::jsonb ->> 'recordedBy'), 1, 6) = 'staff:'
        AND p."created_at" >= "orders"."created_at"
        AND p."created_at" <= "orders"."created_at" + 30
    ) AND EXISTS (
      SELECT 1 FROM "order_events" e
      WHERE e."order_id" = "orders"."id"
        AND e."kind" = 'payment_recorded'
        AND e."actor_app_id" IS NULL
        AND e."created_at" >= "orders"."created_at"
        AND e."created_at" <= "orders"."created_at" + 30
    ))
  );
--> statement-breakpoint
INSERT INTO "event_demand" ("filter") SELECT "filter" FROM "migration_event_demand_hold";
--> statement-breakpoint
DROP TABLE "migration_event_demand_hold";
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (207, '0207_paid_on_placement_orders', 'e9236af2e594c8f1f5408cb97648236dde46275ff450dcdfe1bdbd7345b14630');
