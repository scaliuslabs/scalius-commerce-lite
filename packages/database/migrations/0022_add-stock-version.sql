ALTER TABLE product_variants ADD COLUMN stock_version INTEGER NOT NULL DEFAULT 1;
UPDATE product_variants SET stock_version = version;
