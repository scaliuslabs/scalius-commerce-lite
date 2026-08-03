DROP INDEX IF EXISTS "orders_customer_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_archived_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_deleted_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_customer_activity_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_account_owner_customer_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_shipment_claim_idx";--> statement-breakpoint
CREATE INDEX "orders_customer_activity_idx" ON "orders" ("customer_id","deleted_at","created_at") WHERE "orders"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_account_owner_customer_id_idx" ON "orders" ("account_owner_customer_id") WHERE "orders"."account_owner_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_shipment_claim_idx" ON "orders" ("shipment_claim_id","shipment_claim_expires_at") WHERE "orders"."shipment_claim_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (51, '0051_orders_checkout_write_path', 'be810d0a125e0ab2900e89bfa70a05d67b3b280cc0092a19e1016792a09288cc');
