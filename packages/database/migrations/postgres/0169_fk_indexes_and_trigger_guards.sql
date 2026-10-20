-- Foreign-key child indexes: see ../0169_fk_indexes_and_trigger_guards.sql.
DROP INDEX "order_holds_open_idx";
--> statement-breakpoint
CREATE INDEX "order_holds_order_idx" ON "order_holds" ("order_id","released_at");
--> statement-breakpoint
DROP INDEX "order_return_lines_order_item_idx";
--> statement-breakpoint
CREATE INDEX "order_return_lines_order_item_idx" ON "order_return_lines" ("order_item_id");
--> statement-breakpoint
DROP INDEX "promotion_redemptions_customer_idx";
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_customer_idx" ON "promotion_redemptions" ("customer_id","promotion_id","created_at");
--> statement-breakpoint
CREATE INDEX "product_facet_values_variant_idx" ON "product_facet_values" ("variant_id") WHERE "product_facet_values"."variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "order_return_receipt_lines_variant_idx" ON "order_return_receipt_lines" ("variant_id") WHERE "order_return_receipt_lines"."variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "inventory_transfer_movements_variant_idx" ON "inventory_transfer_movements" ("variant_id");
--> statement-breakpoint
CREATE INDEX "inventory_transfer_movements_line_idx" ON "inventory_transfer_movements" ("transfer_line_id");
--> statement-breakpoint
CREATE INDEX "purchase_order_receipt_lines_line_idx" ON "purchase_order_receipt_lines" ("purchase_order_line_id");
--> statement-breakpoint
CREATE INDEX "product_reviews_variant_idx" ON "product_reviews" ("variant_id") WHERE "product_reviews"."variant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "digital_licence_keys_entitlement_idx" ON "digital_licence_keys" ("entitlement_id") WHERE "digital_licence_keys"."entitlement_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "gift_card_transactions_order_payment_idx" ON "gift_card_transactions" ("order_payment_id") WHERE "gift_card_transactions"."order_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "gift_cards_source_order_item_idx" ON "gift_cards" ("source_order_item_id") WHERE "gift_cards"."source_order_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "warranty_claims_warranty_idx" ON "warranty_claims" ("warranty_id");
--> statement-breakpoint
CREATE INDEX "warranty_claims_order_item_idx" ON "warranty_claims" ("order_item_id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (169, '0169_fk_indexes_and_trigger_guards', '6e9c8f9b2c33ad0dd44ec64b37f1c641a2d5483ee9ffdf42ceb862e278e7fddb');
