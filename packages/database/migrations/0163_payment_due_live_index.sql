-- The overdue index leads with `deleted_at`. 0161's `(payment_due_at, id)`
-- partial index was never chosen: without planner statistics (D1 keeps none)
-- the `deleted_at` equality on `orders_list_updated_at_idx` outranks a range
-- on a leading `payment_due_at`, so every overdue count walked every live
-- order. Readers repeat this WHERE verbatim (`overdueOrderCondition`).
DROP INDEX `orders_payment_due_idx`;--> statement-breakpoint
CREATE INDEX `orders_payment_due_idx` ON `orders` (`deleted_at`,`payment_due_at`,`id`) WHERE "orders"."payment_due_at" IS NOT NULL AND "orders"."balance_due_minor" > 0;--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (163, '0163_payment_due_live_index', '0d86bdc0dc918c072882cff7575ef0fb887906812b2fdc13af2ddfa9db942e71');
