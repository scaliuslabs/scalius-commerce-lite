ALTER TABLE `orders` ADD `invoice_number` integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS orders_invoice_number_idx ON orders (invoice_number) WHERE invoice_number IS NOT NULL;