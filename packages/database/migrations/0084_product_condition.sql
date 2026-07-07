ALTER TABLE products
  ADD COLUMN product_condition TEXT
  CHECK (product_condition IN ('new', 'refurbished', 'used'));
