import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
    resolve(import.meta.dirname, "../migrations/0018_magenta_scream.sql"),
    "utf8",
);

const oldSchema = `
CREATE TABLE products (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE tax_classes (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE media (
  id TEXT PRIMARY KEY NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE product_images (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  url TEXT NOT NULL,
  alt TEXT,
  is_primary INTEGER DEFAULT 0 NOT NULL,
  sort_order INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER DEFAULT 1 NOT NULL
);
CREATE TABLE product_variants (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  option_combination_key TEXT,
  image_id TEXT,
  weight REAL,
  sku TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER DEFAULT 0 NOT NULL,
  reserved_stock INTEGER DEFAULT 0 NOT NULL,
  preorder_stock INTEGER DEFAULT 0 NOT NULL,
  is_default INTEGER DEFAULT 0 NOT NULL,
  track_inventory INTEGER DEFAULT 1 NOT NULL,
  version INTEGER DEFAULT 1 NOT NULL,
  stock_version INTEGER DEFAULT 1 NOT NULL,
  low_stock_threshold INTEGER,
  allow_preorder INTEGER DEFAULT 0 NOT NULL,
  preorder_date TEXT,
  preorder_message TEXT,
  allow_backorder INTEGER DEFAULT 0 NOT NULL,
  backorder_limit INTEGER DEFAULT 0 NOT NULL,
  tax_class_id TEXT,
  tax_classification_version INTEGER DEFAULT 1 NOT NULL,
  discount_percentage REAL DEFAULT 0,
  discount_type TEXT DEFAULT 'percentage',
  discount_amount REAL DEFAULT 0,
  barcode TEXT,
  barcode_type TEXT,
  created_at INTEGER DEFAULT 1 NOT NULL,
  updated_at INTEGER DEFAULT 1 NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE product_option_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL
);
CREATE TABLE product_option_values (
  id TEXT PRIMARY KEY NOT NULL,
  option_definition_id TEXT NOT NULL
);
CREATE TABLE product_variant_option_values (
  variant_id TEXT NOT NULL,
  option_definition_id TEXT NOT NULL,
  option_value_id TEXT NOT NULL
);
CREATE VIRTUAL TABLE product_variants_fts USING fts5(
  sku,
  content='product_variants',
  content_rowid='rowid'
);
INSERT INTO products VALUES ('prod_one', 'One'), ('prod_two', 'Two');
INSERT INTO media VALUES
  ('media_ready_image', 'ready.webp', 'image', 'ready'),
  ('media_ready_video', 'ready.mp4', 'video', 'ready'),
  ('media_trashed_image', 'trash.webp', 'image', 'trashed');
INSERT INTO product_images VALUES
  ('img_legacy', 'prod_one', 'https://legacy.invalid/image.jpg', NULL, 1, 0, 1);
INSERT INTO product_variants (
  id, product_id, option_combination_key, image_id, sku, price, is_default
) VALUES ('var_legacy', 'prod_one', NULL, 'img_legacy', 'LEGACY', 10, 1);
`;

function runSql(sql: string, bail: "on" | "off" = "on") {
    return spawnSync("sqlite3", [":memory:"], {
        input: `.bail ${bail}\n${oldSchema}\n${migration}\n${sql}`,
        encoding: "utf8",
    });
}

describe("ordered product media migration", () => {
    it("uses remote-D1-safe trigger bodies and clears untrusted legacy SKU images", () => {
        expect(migration).not.toMatch(/BEGIN\s+SELECT CASE WHEN/iu);
        expect(migration).toContain("SELECT \"id\", \"product_id\", \"option_combination_key\", NULL");
        expect(migration).toContain("CREATE TRIGGER `product_media_insert_ready_guard`");
        expect(migration).toContain("CREATE TRIGGER `product_media_identity_update_guard`");
        expect(migration).toContain("CREATE TRIGGER `product_variants_identity_insert_guard`");
        expect(migration).toContain("CREATE TRIGGER `product_variants_identity_update_guard`");

        const result = runSql(`
          SELECT id, image_id FROM product_variants WHERE id = 'var_legacy';
          INSERT INTO product_media (
            id, product_id, media_id, alt_text, is_primary, sort_order
          ) VALUES ('pmed_ready_image', 'prod_one', 'media_ready_image', NULL, 1, 0);
          INSERT INTO product_variants (
            id, product_id, option_combination_key, image_id, sku, price, is_default
          ) VALUES ('var_valid', 'prod_one', 'finish', 'pmed_ready_image', 'VALID', 10, 0);
          UPDATE media SET status = 'trashed' WHERE id = 'media_ready_image';
          UPDATE product_variants SET price = 11 WHERE id = 'var_valid';
          SELECT id, image_id, price FROM product_variants WHERE id = 'var_valid';
        `);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
            "var_legacy|",
            "var_valid|pmed_ready_image|11.0",
        ]);
    });

    it("rejects non-ready attachments, video/cross-product SKU images, and identity reassignment", () => {
        const result = runSql(`
          INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order)
            VALUES ('pmed_ready_image', 'prod_one', 'media_ready_image', 1, 0);
          INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order)
            VALUES ('pmed_ready_video', 'prod_one', 'media_ready_video', 0, 1);
          INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order)
            VALUES ('pmed_trashed_bad', 'prod_one', 'media_trashed_image', 0, 2);
          INSERT INTO product_variants (id, product_id, option_combination_key, image_id, sku, price, is_default)
            VALUES ('var_video_bad', 'prod_one', 'video', 'pmed_ready_video', 'VIDEO-BAD', 10, 0);
          INSERT INTO product_variants (id, product_id, option_combination_key, image_id, sku, price, is_default)
            VALUES ('var_cross_bad', 'prod_two', 'cross', 'pmed_ready_image', 'CROSS-BAD', 10, 0);
          INSERT INTO product_variants (id, product_id, option_combination_key, image_id, sku, price, is_default)
            VALUES ('var_valid', 'prod_one', 'valid', 'pmed_ready_image', 'VALID', 10, 0);
          UPDATE media SET status = 'trashed' WHERE id = 'media_ready_image';
          UPDATE product_variants SET image_id = image_id, price = 12 WHERE id = 'var_valid';
          UPDATE product_variants SET product_id = 'prod_two' WHERE id = 'var_valid';
          UPDATE product_media SET media_id = 'media_ready_video' WHERE id = 'pmed_ready_image';
          SELECT id, product_id, image_id, price FROM product_variants WHERE id = 'var_valid';
        `, "off");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("INVALID_PRODUCT_MEDIA_ASSET");
        expect(result.stderr.match(/INVALID_PRODUCT_VARIANT_IDENTITY/gu)?.length).toBeGreaterThanOrEqual(3);
        expect(result.stderr).toContain("IMMUTABLE_PRODUCT_MEDIA_IDENTITY");
        expect(result.stdout.trim()).toBe("var_valid|prod_one|pmed_ready_image|12.0");
    });
});
