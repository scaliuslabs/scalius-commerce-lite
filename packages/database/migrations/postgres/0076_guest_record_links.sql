-- A guest record partly claimed by an account points at it, and the change
-- log records every order that moves between a guest record and an account.
ALTER TABLE "customers" ADD COLUMN "linked_account_id" text;
--> statement-breakpoint
CREATE INDEX "customers_linked_account_idx" ON "customers" ("linked_account_id");
--> statement-breakpoint
ALTER TABLE "customer_history" ADD COLUMN "order_id" text;
--> statement-breakpoint
ALTER TABLE "customer_history" ADD COLUMN "related_customer_id" text;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (76, '0076_guest_record_links', '728ad7d908c014099cbc7bc8a70441867568585ddc9e9ba2dae46776106bbbe6');
