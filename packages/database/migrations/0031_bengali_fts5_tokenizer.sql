-- Bengali FTS5 tokenizer reconfiguration
-- Reconfigures 5 Bengali-content FTS tables with unicode61 tokenizer that preserves
-- Mc (spacing combining marks) and Mn (non-spacing combining marks) categories,
-- keeping Bengali vowel signs attached to their consonants during tokenization.
-- ASCII-only tables (product_variants_fts, discounts_fts, abandoned_checkouts_fts) are NOT touched.

-- Section 1: Drop triggers for 5 tables (20 DROP TRIGGER statements)

DROP TRIGGER IF EXISTS products_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_fts_au;--> statement-breakpoint
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

-- Section 2: Drop 5 FTS virtual tables

DROP TABLE IF EXISTS products_fts;--> statement-breakpoint
DROP TABLE IF EXISTS categories_fts;--> statement-breakpoint
DROP TABLE IF EXISTS pages_fts;--> statement-breakpoint
DROP TABLE IF EXISTS orders_fts;--> statement-breakpoint
DROP TABLE IF EXISTS customers_fts;--> statement-breakpoint

-- Section 3: Recreate 5 FTS virtual tables with Bengali tokenizer

CREATE VIRTUAL TABLE products_fts USING fts5(
  name,
  description,
  content='products',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint

CREATE VIRTUAL TABLE categories_fts USING fts5(
  name,
  description,
  content='categories',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint

CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  content_col,
  content='pages',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint

CREATE VIRTUAL TABLE orders_fts USING fts5(
  customer_name,
  customer_phone,
  order_id,
  content='orders',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint

CREATE VIRTUAL TABLE customers_fts USING fts5(
  name,
  phone,
  email,
  content='customers',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint

-- Section 4: Recreate all 20 triggers (identical to 0016)

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

-- Section 5: Rebuild indexes from existing data

INSERT INTO products_fts(products_fts) VALUES('rebuild');--> statement-breakpoint

INSERT INTO categories_fts(categories_fts) VALUES('rebuild');--> statement-breakpoint

INSERT INTO pages_fts(rowid, title, content_col) SELECT rowid, title, content FROM pages;--> statement-breakpoint

INSERT INTO orders_fts(rowid, customer_name, customer_phone, order_id) SELECT rowid, customer_name, customer_phone, id FROM orders;--> statement-breakpoint

INSERT INTO customers_fts(customers_fts) VALUES('rebuild');