DROP INDEX "promotion_redemptions_order_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_order_promotion_unique" ON "promotion_redemptions" ("order_id", "promotion_id");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (73, '0073_combinable_discount_codes', 'f0cce9701c13e51366a10988ce7595395b1e7763523fa8180acc17b9273ea582');
