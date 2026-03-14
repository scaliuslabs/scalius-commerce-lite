-- Add version column for optimistic locking on orders
ALTER TABLE orders ADD COLUMN "version" integer NOT NULL DEFAULT 1;
