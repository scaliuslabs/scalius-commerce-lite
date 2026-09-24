-- Guest records created by checkout are titled by their phone and never tied
-- to an account until all their orders are proven; the change log says which
-- verified contact linked each order, and who made each change.
ALTER TABLE "customers" ADD COLUMN "origin" text DEFAULT 'order' NOT NULL;
--> statement-breakpoint
UPDATE "customers" SET "origin" = 'account' WHERE "account_claimed_at" IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "customers_linked_account_idx";
--> statement-breakpoint
ALTER TABLE "customers" RENAME COLUMN "linked_account_id" TO "merged_into_customer_id";
--> statement-breakpoint
UPDATE "customers" SET "merged_into_customer_id" = NULL WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "customers_merged_into_idx" ON "customers" ("merged_into_customer_id");
--> statement-breakpoint
ALTER TABLE "customer_history" ADD COLUMN "verified_contact" text;
--> statement-breakpoint
ALTER TABLE "customer_history" ADD COLUMN "actor" text;
--> statement-breakpoint
ALTER TABLE "customer_history" ADD COLUMN "actor_id" text;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (79, '0079_guest_record_origin', '95b284f716293447b94c3474bf53e21d0262ed589ed91ed1087084bcbb7f1c2b');
