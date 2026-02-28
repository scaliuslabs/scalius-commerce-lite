-- FTS5 Full-Text Search tables (external content, no data duplication)
-- Each table references the source table via content= and content_rowid='rowid'

-- Clean up any partial state from a previous failed run
DROP TRIGGER IF EXISTS products_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_variants_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_variants_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_variants_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_variants_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS customers_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS customers_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS customers_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS customers_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS discounts_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS discounts_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS discounts_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS discounts_fts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS abandoned_checkouts_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS abandoned_checkouts_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS abandoned_checkouts_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS abandoned_checkouts_fts_au;--> statement-breakpoint
DROP TABLE IF EXISTS products_fts;--> statement-breakpoint
DROP TABLE IF EXISTS product_variants_fts;--> statement-breakpoint
DROP TABLE IF EXISTS categories_fts;--> statement-breakpoint
DROP TABLE IF EXISTS pages_fts;--> statement-breakpoint
DROP TABLE IF EXISTS orders_fts;--> statement-breakpoint
DROP TABLE IF EXISTS customers_fts;--> statement-breakpoint
DROP TABLE IF EXISTS discounts_fts;--> statement-breakpoint
DROP TABLE IF EXISTS abandoned_checkouts_fts;--> statement-breakpoint

-- Products FTS (name, description)
CREATE VIRTUAL TABLE products_fts USING fts5(
  name,
  description,
  content='products',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint

CREATE TRIGGER products_fts_bd BEFORE DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint

CREATE TRIGGER products_fts_bu BEFORE UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint

CREATE TRIGGER products_fts_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint

INSERT INTO products_fts(products_fts) VALUES('rebuild');--> statement-breakpoint

-- Product Variants FTS (sku)
CREATE VIRTUAL TABLE product_variants_fts USING fts5(
  sku,
  content='product_variants',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER product_variants_fts_ai AFTER INSERT ON product_variants BEGIN
  INSERT INTO product_variants_fts(rowid, sku) VALUES (new.rowid, new.sku);
END;--> statement-breakpoint

CREATE TRIGGER product_variants_fts_bd BEFORE DELETE ON product_variants BEGIN
  INSERT INTO product_variants_fts(product_variants_fts, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;--> statement-breakpoint

CREATE TRIGGER product_variants_fts_bu BEFORE UPDATE ON product_variants BEGIN
  INSERT INTO product_variants_fts(product_variants_fts, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;--> statement-breakpoint

CREATE TRIGGER product_variants_fts_au AFTER UPDATE ON product_variants BEGIN
  INSERT INTO product_variants_fts(rowid, sku) VALUES (new.rowid, new.sku);
END;--> statement-breakpoint

INSERT INTO product_variants_fts(product_variants_fts) VALUES('rebuild');--> statement-breakpoint

-- Categories FTS (name, description)
CREATE VIRTUAL TABLE categories_fts USING fts5(
  name,
  description,
  content='categories',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER categories_fts_ai AFTER INSERT ON categories BEGIN
  INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint

CREATE TRIGGER categories_fts_bd BEFORE DELETE ON categories BEGIN
  INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint

CREATE TRIGGER categories_fts_bu BEFORE UPDATE ON categories BEGIN
  INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
END;--> statement-breakpoint

CREATE TRIGGER categories_fts_au AFTER UPDATE ON categories BEGIN
  INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;--> statement-breakpoint

INSERT INTO categories_fts(categories_fts) VALUES('rebuild');--> statement-breakpoint

-- Pages FTS (title, content)
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  content_col,
  content='pages',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content_col) VALUES (new.rowid, new.title, new.content);
END;--> statement-breakpoint

CREATE TRIGGER pages_fts_bd BEFORE DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content_col) VALUES('delete', old.rowid, old.title, old.content);
END;--> statement-breakpoint

CREATE TRIGGER pages_fts_bu BEFORE UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content_col) VALUES('delete', old.rowid, old.title, old.content);
END;--> statement-breakpoint

CREATE TRIGGER pages_fts_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content_col) VALUES (new.rowid, new.title, new.content);
END;--> statement-breakpoint

INSERT INTO pages_fts(rowid, title, content_col) SELECT rowid, title, content FROM pages;--> statement-breakpoint

-- Orders FTS (customer_name, customer_phone, id)
CREATE VIRTUAL TABLE orders_fts USING fts5(
  customer_name,
  customer_phone,
  order_id,
  content='orders',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER orders_fts_ai AFTER INSERT ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_phone, order_id) VALUES (new.rowid, new.customer_name, new.customer_phone, new.id);
END;--> statement-breakpoint

CREATE TRIGGER orders_fts_bd BEFORE DELETE ON orders BEGIN
  INSERT INTO orders_fts(orders_fts, rowid, customer_name, customer_phone, order_id) VALUES('delete', old.rowid, old.customer_name, old.customer_phone, old.id);
END;--> statement-breakpoint

CREATE TRIGGER orders_fts_bu BEFORE UPDATE ON orders BEGIN
  INSERT INTO orders_fts(orders_fts, rowid, customer_name, customer_phone, order_id) VALUES('delete', old.rowid, old.customer_name, old.customer_phone, old.id);
END;--> statement-breakpoint

CREATE TRIGGER orders_fts_au AFTER UPDATE ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_phone, order_id) VALUES (new.rowid, new.customer_name, new.customer_phone, new.id);
END;--> statement-breakpoint

INSERT INTO orders_fts(rowid, customer_name, customer_phone, order_id) SELECT rowid, customer_name, customer_phone, id FROM orders;--> statement-breakpoint

-- Customers FTS (name, phone, email)
CREATE VIRTUAL TABLE customers_fts USING fts5(
  name,
  phone,
  email,
  content='customers',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER customers_fts_ai AFTER INSERT ON customers BEGIN
  INSERT INTO customers_fts(rowid, name, phone, email) VALUES (new.rowid, new.name, new.phone, new.email);
END;--> statement-breakpoint

CREATE TRIGGER customers_fts_bd BEFORE DELETE ON customers BEGIN
  INSERT INTO customers_fts(customers_fts, rowid, name, phone, email) VALUES('delete', old.rowid, old.name, old.phone, old.email);
END;--> statement-breakpoint

CREATE TRIGGER customers_fts_bu BEFORE UPDATE ON customers BEGIN
  INSERT INTO customers_fts(customers_fts, rowid, name, phone, email) VALUES('delete', old.rowid, old.name, old.phone, old.email);
END;--> statement-breakpoint

CREATE TRIGGER customers_fts_au AFTER UPDATE ON customers BEGIN
  INSERT INTO customers_fts(rowid, name, phone, email) VALUES (new.rowid, new.name, new.phone, new.email);
END;--> statement-breakpoint

INSERT INTO customers_fts(customers_fts) VALUES('rebuild');--> statement-breakpoint

-- Discounts FTS (code)
CREATE VIRTUAL TABLE discounts_fts USING fts5(
  code,
  content='discounts',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER discounts_fts_ai AFTER INSERT ON discounts BEGIN
  INSERT INTO discounts_fts(rowid, code) VALUES (new.rowid, new.code);
END;--> statement-breakpoint

CREATE TRIGGER discounts_fts_bd BEFORE DELETE ON discounts BEGIN
  INSERT INTO discounts_fts(discounts_fts, rowid, code) VALUES('delete', old.rowid, old.code);
END;--> statement-breakpoint

CREATE TRIGGER discounts_fts_bu BEFORE UPDATE ON discounts BEGIN
  INSERT INTO discounts_fts(discounts_fts, rowid, code) VALUES('delete', old.rowid, old.code);
END;--> statement-breakpoint

CREATE TRIGGER discounts_fts_au AFTER UPDATE ON discounts BEGIN
  INSERT INTO discounts_fts(rowid, code) VALUES (new.rowid, new.code);
END;--> statement-breakpoint

INSERT INTO discounts_fts(discounts_fts) VALUES('rebuild');--> statement-breakpoint

-- Abandoned Checkouts FTS (customer_phone, checkout_id, checkout_data)
CREATE VIRTUAL TABLE abandoned_checkouts_fts USING fts5(
  customer_phone,
  checkout_id,
  checkout_data,
  content='abandoned_checkouts',
  content_rowid='rowid'
);--> statement-breakpoint

CREATE TRIGGER abandoned_checkouts_fts_ai AFTER INSERT ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(rowid, customer_phone, checkout_id, checkout_data) VALUES (new.rowid, new.customer_phone, new.checkout_id, new.checkout_data);
END;--> statement-breakpoint

CREATE TRIGGER abandoned_checkouts_fts_bd BEFORE DELETE ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(abandoned_checkouts_fts, rowid, customer_phone, checkout_id, checkout_data) VALUES('delete', old.rowid, old.customer_phone, old.checkout_id, old.checkout_data);
END;--> statement-breakpoint

CREATE TRIGGER abandoned_checkouts_fts_bu BEFORE UPDATE ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(abandoned_checkouts_fts, rowid, customer_phone, checkout_id, checkout_data) VALUES('delete', old.rowid, old.customer_phone, old.checkout_id, old.checkout_data);
END;--> statement-breakpoint

CREATE TRIGGER abandoned_checkouts_fts_au AFTER UPDATE ON abandoned_checkouts BEGIN
  INSERT INTO abandoned_checkouts_fts(rowid, customer_phone, checkout_id, checkout_data) VALUES (new.rowid, new.customer_phone, new.checkout_id, new.checkout_data);
END;--> statement-breakpoint

INSERT INTO abandoned_checkouts_fts(abandoned_checkouts_fts) VALUES('rebuild');