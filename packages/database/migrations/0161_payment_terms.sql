-- Deferred payment (net terms, `@scalius/shared/payment-terms`): a deferred
-- order keeps its terms in days and its due date (placement + terms), both
-- set once at placement and null for every other order. The partial index
-- lists deferred orders with money still due by due date (the overdue list,
-- the Home to-do and the agents' read).
ALTER TABLE `orders` ADD `payment_terms_days` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_due_at` integer;--> statement-breakpoint
CREATE INDEX `orders_payment_due_idx` ON `orders` (`payment_due_at`,`id`) WHERE "orders"."payment_due_at" IS NOT NULL AND "orders"."deleted_at" IS NULL AND "orders"."balance_due_minor" > 0;--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (161, '0161_payment_terms', '6e6ed65780e481fea14f5c00d39d254576d40d60c4153ba4d6ee59cfcbd5d25b');
