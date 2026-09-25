-- Wave A contract, step 2 (Wave A §5.6): the legacy per-line status and sent
-- count, the parcel's JSON item list and the support case's free-text
-- message. The ledger, its fulfilment lines and the order thread replaced
-- them, and the API released with 0088 neither reads nor writes them. This
-- ships one release after that API is live, because the API that runs while
-- a migration applies must not name a dropped column. Since 0088 recreated the
-- return triggers, no index, trigger or constraint references these columns.
ALTER TABLE "order_items" DROP COLUMN "shipped_quantity";
--> statement-breakpoint
ALTER TABLE "order_items" DROP COLUMN "fulfillment_status";
--> statement-breakpoint
ALTER TABLE "delivery_shipments" DROP COLUMN "shipment_items";
--> statement-breakpoint
ALTER TABLE "order_support_requests" DROP COLUMN "message";
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (89, '0089_wave_a_contract_columns', '8fecfe8de769120f1d525cb7cd0ec5595246074dd46f623e55bd7f3a6f63dc79');
