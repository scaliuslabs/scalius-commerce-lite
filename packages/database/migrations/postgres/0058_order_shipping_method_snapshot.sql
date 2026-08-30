ALTER TABLE "orders" ADD "shipping_method_id" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD "shipping_method_name" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD "shipping_method_description" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD "shipping_method_base_amount_minor" bigint;
--> statement-breakpoint
ALTER TABLE "orders" ADD "shipping_fee_waived" bigint;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (58, '0058_order_shipping_method_snapshot', 'a0c66a84c1652e000e26d37adc8f7331afef9cc5284eb3b152fe63c389545217');
