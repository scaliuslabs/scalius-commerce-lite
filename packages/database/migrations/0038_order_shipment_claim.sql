ALTER TABLE `orders` ADD `shipment_claim_id` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `shipment_claim_expires_at` integer;
--> statement-breakpoint
CREATE INDEX `orders_shipment_claim_idx` ON `orders` (`shipment_claim_id`, `shipment_claim_expires_at`);
