ALTER TABLE products ADD COLUMN canonical_path TEXT;

ALTER TABLE categories ADD COLUMN canonical_path TEXT;

ALTER TABLE collections ADD COLUMN canonical_path TEXT;

ALTER TABLE pages ADD COLUMN canonical_path TEXT;
