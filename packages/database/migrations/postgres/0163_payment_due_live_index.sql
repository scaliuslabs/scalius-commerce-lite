-- The overdue index leads with deleted_at: see ../0163_payment_due_live_index.sql.
DROP INDEX "orders_payment_due_idx";
--> statement-breakpoint
CREATE INDEX "orders_payment_due_idx" ON "orders" ("deleted_at","payment_due_at","id") WHERE "orders"."payment_due_at" IS NOT NULL AND "orders"."balance_due_minor" > 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (163, '0163_payment_due_live_index', '0d86bdc0dc918c072882cff7575ef0fb887906812b2fdc13af2ddfa9db942e71');
