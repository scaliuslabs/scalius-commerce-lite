CREATE INDEX `abandoned_checkouts_created_at_idx` ON `abandoned_checkouts` (`created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `abandoned_checkouts_empty_candidate_idx` ON `abandoned_checkouts` (`customer_phone`, `updated_at`, `id`);
