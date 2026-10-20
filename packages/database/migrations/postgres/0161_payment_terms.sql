-- Deferred payment (net terms): see ../0161_payment_terms.sql.
ALTER TABLE "orders" ADD "payment_terms_days" bigint;
--> statement-breakpoint
ALTER TABLE "orders" ADD "payment_due_at" bigint;
--> statement-breakpoint
CREATE INDEX "orders_payment_due_idx" ON "orders" ("payment_due_at","id") WHERE "orders"."payment_due_at" IS NOT NULL AND "orders"."deleted_at" IS NULL AND "orders"."balance_due_minor" > 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (161, '0161_payment_terms', '6e6ed65780e481fea14f5c00d39d254576d40d60c4153ba4d6ee59cfcbd5d25b');
