-- Billing addresses (docs/MARKETS-DESIGN.md D7, Shopify's rule). Orders gain
-- the billing-address snapshot: the canonical fields of the shipping snapshot
-- with a billing_ prefix (no Bangladesh City/Thana/Area adapter: couriers do
-- not use a billing address), and billing_same_as_shipping, true when the
-- shipping address is the billing address (the billing columns then stay
-- null). Nothing is backfilled: an order placed before 0119 has no billing
-- address (flag 0, columns null). order_tax_snapshots gains address_source:
-- the address taxed (shipping, billing or origin; null before 0119). The
-- customer address book gains is_default_billing, one per customer. The event
-- triggers of orders and of the address book are re-created with the new
-- columns (packages/database/scripts/event-outbox-triggers.ts). Orders, tax
-- snapshots and the address book are private: no cache dependency.
ALTER TABLE "orders" ADD COLUMN "billing_same_as_shipping" bigint DEFAULT 0 NOT NULL CONSTRAINT "orders_billing_same_as_shipping_flag" CHECK ("billing_same_as_shipping" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_name" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_company" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_address" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_address_line2" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_country_code" text CONSTRAINT "orders_billing_country_shape" CHECK ("billing_country_code" IS NULL OR (length("billing_country_code") = 2 AND "billing_country_code" !~ '[^A-Z]'));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_dependent_locality" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_locality" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_admin_area" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_postal_code" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_phone" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_validation_skipped" bigint DEFAULT 0 NOT NULL CONSTRAINT "orders_billing_validation_skipped_flag" CHECK ("billing_validation_skipped" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "order_tax_snapshots" ADD COLUMN "address_source" text CONSTRAINT "order_tax_snapshots_address_source_check" CHECK ("address_source" IS NULL OR "address_source" IN ('shipping', 'billing', 'origin'));
--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD COLUMN "is_default_billing" bigint DEFAULT 0 NOT NULL CONSTRAINT "customer_addresses_default_billing_flag" CHECK ("is_default_billing" IN (0, 1));
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_addresses_default_billing_unique" ON "customer_addresses" ("customer_id") WHERE "customer_addresses"."is_default_billing" = 1;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_orders_updated" ON "orders";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_orders_updated_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'order.updated', 'order', NEW."id", jsonb_build_object('orderId', NEW."id", 'previousStatus', OLD."status", 'status', NEW."status", 'previousPaymentStatus', OLD."payment_status", 'paymentStatus', NEW."payment_status", 'previousFulfillmentStatus', OLD."fulfillment_status", 'fulfillmentStatus', NEW."fulfillment_status")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_orders_updated"
AFTER UPDATE ON "orders"
FOR EACH ROW
WHEN ((OLD."status" <> 'incomplete' AND NEW."status" <> 'incomplete' AND (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."payment_status" IS DISTINCT FROM NEW."payment_status" OR OLD."fulfillment_status" IS DISTINCT FROM NEW."fulfillment_status" OR OLD."payment_method" IS DISTINCT FROM NEW."payment_method" OR OLD."paid_amount_minor" IS DISTINCT FROM NEW."paid_amount_minor" OR OLD."balance_due_minor" IS DISTINCT FROM NEW."balance_due_minor" OR OLD."subtotal_amount_minor" IS DISTINCT FROM NEW."subtotal_amount_minor" OR OLD."shipping_amount_minor" IS DISTINCT FROM NEW."shipping_amount_minor" OR OLD."discount_amount_minor" IS DISTINCT FROM NEW."discount_amount_minor" OR OLD."tax_amount_minor" IS DISTINCT FROM NEW."tax_amount_minor" OR OLD."total_amount_minor" IS DISTINCT FROM NEW."total_amount_minor" OR OLD."customer_name" IS DISTINCT FROM NEW."customer_name" OR OLD."customer_phone" IS DISTINCT FROM NEW."customer_phone" OR OLD."customer_email" IS DISTINCT FROM NEW."customer_email" OR OLD."customer_whatsapp" IS DISTINCT FROM NEW."customer_whatsapp" OR OLD."shipping_address" IS DISTINCT FROM NEW."shipping_address" OR OLD."shipping_address_line2" IS DISTINCT FROM NEW."shipping_address_line2" OR OLD."shipping_country_code" IS DISTINCT FROM NEW."shipping_country_code" OR OLD."shipping_dependent_locality" IS DISTINCT FROM NEW."shipping_dependent_locality" OR OLD."shipping_locality" IS DISTINCT FROM NEW."shipping_locality" OR OLD."shipping_admin_area" IS DISTINCT FROM NEW."shipping_admin_area" OR OLD."shipping_postal_code" IS DISTINCT FROM NEW."shipping_postal_code" OR OLD."shipping_company" IS DISTINCT FROM NEW."shipping_company" OR OLD."shipping_name" IS DISTINCT FROM NEW."shipping_name" OR OLD."shipping_phone" IS DISTINCT FROM NEW."shipping_phone" OR OLD."shipping_validation_skipped" IS DISTINCT FROM NEW."shipping_validation_skipped" OR OLD."city" IS DISTINCT FROM NEW."city" OR OLD."zone" IS DISTINCT FROM NEW."zone" OR OLD."area" IS DISTINCT FROM NEW."area" OR OLD."billing_same_as_shipping" IS DISTINCT FROM NEW."billing_same_as_shipping" OR OLD."billing_name" IS DISTINCT FROM NEW."billing_name" OR OLD."billing_company" IS DISTINCT FROM NEW."billing_company" OR OLD."billing_address" IS DISTINCT FROM NEW."billing_address" OR OLD."billing_address_line2" IS DISTINCT FROM NEW."billing_address_line2" OR OLD."billing_country_code" IS DISTINCT FROM NEW."billing_country_code" OR OLD."billing_dependent_locality" IS DISTINCT FROM NEW."billing_dependent_locality" OR OLD."billing_locality" IS DISTINCT FROM NEW."billing_locality" OR OLD."billing_admin_area" IS DISTINCT FROM NEW."billing_admin_area" OR OLD."billing_postal_code" IS DISTINCT FROM NEW."billing_postal_code" OR OLD."billing_phone" IS DISTINCT FROM NEW."billing_phone" OR OLD."billing_validation_skipped" IS DISTINCT FROM NEW."billing_validation_skipped" OR OLD."notes" IS DISTINCT FROM NEW."notes" OR OLD."shipping_method_id" IS DISTINCT FROM NEW."shipping_method_id" OR OLD."pickup_ready_at" IS DISTINCT FROM NEW."pickup_ready_at" OR OLD."expected_delivery" IS DISTINCT FROM NEW."expected_delivery" OR OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."channel_source" IS DISTINCT FROM NEW."channel_source" OR OLD."invoice_number" IS DISTINCT FROM NEW."invoice_number" OR OLD."archived_at" IS DISTINCT FROM NEW."archived_at" OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at")))
EXECUTE FUNCTION scalius_compat."evt_orders_updated_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "evt_customer_addresses_changed" ON "customer_addresses";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION scalius_compat."evt_customer_addresses_changed_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  INSERT INTO "event_outbox" ("id", "topic", "resource_type", "resource_id", "data") VALUES ('evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12), 'customer.updated', 'customer', NEW."customer_id", jsonb_build_object('customerId', NEW."customer_id")::text);
  RETURN NULL;
END
$trigger_function$;
CREATE TRIGGER "evt_customer_addresses_changed"
AFTER UPDATE ON "customer_addresses"
FOR EACH ROW
WHEN ((OLD."customer_id" IS DISTINCT FROM NEW."customer_id" OR OLD."is_default" IS DISTINCT FROM NEW."is_default" OR OLD."is_default_billing" IS DISTINCT FROM NEW."is_default_billing" OR OLD."country_code" IS DISTINCT FROM NEW."country_code" OR OLD."name" IS DISTINCT FROM NEW."name" OR OLD."company" IS DISTINCT FROM NEW."company" OR OLD."line1" IS DISTINCT FROM NEW."line1" OR OLD."line2" IS DISTINCT FROM NEW."line2" OR OLD."dependent_locality" IS DISTINCT FROM NEW."dependent_locality" OR OLD."locality" IS DISTINCT FROM NEW."locality" OR OLD."admin_area" IS DISTINCT FROM NEW."admin_area" OR OLD."postal_code" IS DISTINCT FROM NEW."postal_code" OR OLD."phone_e164" IS DISTINCT FROM NEW."phone_e164" OR OLD."phone_raw" IS DISTINCT FROM NEW."phone_raw" OR OLD."city" IS DISTINCT FROM NEW."city" OR OLD."zone" IS DISTINCT FROM NEW."zone" OR OLD."area" IS DISTINCT FROM NEW."area" OR OLD."city_name" IS DISTINCT FROM NEW."city_name" OR OLD."zone_name" IS DISTINCT FROM NEW."zone_name" OR OLD."area_name" IS DISTINCT FROM NEW."area_name" OR OLD."validation_skipped" IS DISTINCT FROM NEW."validation_skipped"))
EXECUTE FUNCTION scalius_compat."evt_customer_addresses_changed_fn"();
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (119, '0119_billing_addresses', 'bb8841b6bea9fc52dc1cbb7f01a3285128e3dfb3eb988447a97512b7af025c8a');
