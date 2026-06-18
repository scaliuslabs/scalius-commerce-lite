-- Add customer email to the admin order FTS index and cover the default order-list sort.

DROP TRIGGER IF EXISTS orders_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_bd;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_bu;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_fts_au;--> statement-breakpoint

DROP TABLE IF EXISTS orders_fts;--> statement-breakpoint

CREATE VIRTUAL TABLE orders_fts USING fts5(
  customer_name,
  customer_phone,
  customer_email,
  order_id,
  content='orders',
  content_rowid='rowid',
  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint

CREATE TRIGGER orders_fts_ai AFTER INSERT ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id) VALUES (new.rowid, new.customer_name, new.customer_phone, new.customer_email, new.id);
END;--> statement-breakpoint

CREATE TRIGGER orders_fts_bd BEFORE DELETE ON orders BEGIN
  INSERT INTO orders_fts(orders_fts, rowid, customer_name, customer_phone, customer_email, order_id) VALUES('delete', old.rowid, old.customer_name, old.customer_phone, old.customer_email, old.id);
END;--> statement-breakpoint

CREATE TRIGGER orders_fts_bu BEFORE UPDATE ON orders BEGIN
  INSERT INTO orders_fts(orders_fts, rowid, customer_name, customer_phone, customer_email, order_id) VALUES('delete', old.rowid, old.customer_name, old.customer_phone, old.customer_email, old.id);
END;--> statement-breakpoint

CREATE TRIGGER orders_fts_au AFTER UPDATE ON orders BEGIN
  INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id) VALUES (new.rowid, new.customer_name, new.customer_phone, new.customer_email, new.id);
END;--> statement-breakpoint

INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id)
SELECT rowid, customer_name, customer_phone, customer_email, id FROM orders;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS orders_list_updated_at_idx ON orders (deleted_at, updated_at);--> statement-breakpoint
