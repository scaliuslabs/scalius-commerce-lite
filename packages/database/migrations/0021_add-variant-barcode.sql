ALTER TABLE product_variants ADD COLUMN barcode TEXT;
ALTER TABLE product_variants ADD COLUMN barcode_type TEXT;
CREATE INDEX IF NOT EXISTS product_variants_barcode_idx ON product_variants(barcode);
