import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0006_outgoing_captain_midlands.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const schema = `
  CREATE TABLE products (
    id TEXT PRIMARY KEY NOT NULL,
    meta_description TEXT,
    aggregate_revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE product_variants (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL,
    size TEXT,
    color TEXT,
    sku TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    reserved_stock INTEGER NOT NULL DEFAULT 0,
    preorder_stock INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    stock_version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    barcode TEXT,
    barcode_type TEXT,
    deleted_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX product_variants_sku_unique_idx ON product_variants (sku);
  CREATE INDEX product_variants_barcode_idx ON product_variants (barcode);
  CREATE TABLE inventory_movements (id TEXT PRIMARY KEY, variant_id TEXT NOT NULL);
  CREATE TABLE order_items (id TEXT PRIMARY KEY, variant_id TEXT);
  CREATE TABLE product_low_stock_alerts (id TEXT PRIMARY KEY, variant_id TEXT NOT NULL);
  CREATE TABLE product_variant_image_mappings (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    variant_id TEXT
  );
`;

const mojoVariants = `
  INSERT INTO product_variants (
    id, product_id, size, color, sku, price, stock, reserved_stock,
    preorder_stock, version, stock_version, is_default
  ) VALUES
    ('var_-Dc_ytYPws_H9TIR5Ljns', 'prod_DgYZ43wj5zcNoug7gEdUL', 's', 'Red', 'JDLF01262334', 500, 20, 0, 0, 1, 1, 0),
    ('var_qYyJwKBSsWzNazxVxXv0a', 'prod_DgYZ43wj5zcNoug7gEdUL', 's', 'Red', 'JDLF01262334-COPY', 500, 20, 0, 0, 1, 1, 0),
    ('var_Aqwy-RY7JCgVpbFeypMz-', 'prod_DgYZ43wj5zcNoug7gEdUL', 's', 'Red', 'JDLF01262334aa', 500, 20, 0, 0, 1, 1, 0),
    ('var_v12bGKdJmqUiyRGK6sq6b', 'prod_DgYZ43wj5zcNoug7gEdUL', 's', 'Red', 'JDLF01262334a', 500, 20, 0, 0, 1, 1, 0);
`;

function execute(seed: string, assertions = "") {
  return spawnSync("sqlite3", [":memory:"], {
    input: `.bail on\n${schema}\n${seed}\n${migration}\n${assertions}`,
    encoding: "utf8",
  });
}

describe("catalog identity cutover migration", () => {
  it("repairs audited rows, strips markers, and advances each affected aggregate once", () => {
    const result = execute(`
      INSERT INTO products (id, meta_description) VALUES
        ('prod_DgYZ43wj5zcNoug7gEdUL', NULL),
        ('prod_pfAUHRl7wPSgEZpdcTJms', 'SEO<!--variant_images:option2-->'),
        ('prod_empty_axis', NULL);
      ${mojoVariants}
      INSERT INTO product_variants (
        id, product_id, size, color, sku, price, stock, is_default
      ) VALUES
        ('var_purple', 'prod_pfAUHRl7wPSgEZpdcTJms', 'S', 'Purple ', 'PURPLE-S', 100, 1, 0),
        ('var_empty', 'prod_empty_axis', 'One Size', '', 'ONE-SIZE', 100, 1, 0);
      INSERT INTO product_variant_image_mappings (id, product_id, variant_id)
      VALUES ('map_1', 'prod_pfAUHRl7wPSgEZpdcTJms', NULL);
    `, `
      SELECT count(*) FROM product_variants
      WHERE product_id = 'prod_DgYZ43wj5zcNoug7gEdUL' AND deleted_at IS NULL;
      SELECT count(*) FROM product_variants
      WHERE id IN ('var_qYyJwKBSsWzNazxVxXv0a','var_Aqwy-RY7JCgVpbFeypMz-','var_v12bGKdJmqUiyRGK6sq6b')
        AND deleted_at IS NOT NULL;
      SELECT quote(color) FROM product_variants WHERE id = 'var_purple';
      SELECT quote(color) FROM product_variants WHERE id = 'var_empty';
      SELECT meta_description FROM products WHERE id = 'prod_pfAUHRl7wPSgEZpdcTJms';
      SELECT group_concat(id || ':' || aggregate_revision, ',')
      FROM (SELECT id, aggregate_revision FROM products ORDER BY id);
      SELECT count(*) FROM product_variant_image_mappings;
      SELECT count(*) FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'product_variants_sku_identity_uidx',
        'product_variants_barcode_identity_uidx',
        'product_variants_active_option_identity_uidx'
      );
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "1",
      "3",
      "'Purple'",
      "NULL",
      "SEO",
      "prod_DgYZ43wj5zcNoug7gEdUL:2,prod_empty_axis:2,prod_pfAUHRl7wPSgEZpdcTJms:2",
      "1",
      "3",
    ]);
  });

  it("enforces normalized SKU, barcode, option, and metadata identities", () => {
    const duplicateSku = execute(`
      INSERT INTO products (id) VALUES ('prod_1');
      INSERT INTO product_variants (
        id, product_id, size, sku, price, stock, is_default
      ) VALUES ('var_1', 'prod_1', 'Small', 'SKU-ONE', 100, 1, 0);
    `, `
      INSERT INTO product_variants (
        id, product_id, size, sku, price, stock, is_default
      ) VALUES ('var_2', 'prod_1', 'Large', 'sku-one', 100, 1, 0);
    `);
    expect(duplicateSku.status).not.toBe(0);
    expect(duplicateSku.stderr).toContain("product_variants_sku_identity_uidx");

    const duplicateOption = execute(`
      INSERT INTO products (id) VALUES ('prod_1');
      INSERT INTO product_variants (
        id, product_id, size, color, sku, price, stock, is_default
      ) VALUES ('var_1', 'prod_1', 'Small', 'Red', 'SKU-ONE', 100, 1, 0);
    `, `
      INSERT INTO product_variants (
        id, product_id, size, color, sku, price, stock, is_default
      ) VALUES ('var_2', 'prod_1', 'small', 'red', 'SKU-TWO', 100, 1, 0);
    `);
    expect(duplicateOption.status).not.toBe(0);
    expect(duplicateOption.stderr).toContain("product_variants_active_option_identity_uidx");

    const invalidCanonicalIdentity = execute(`
      INSERT INTO products (id) VALUES ('prod_1');
    `, `
      INSERT INTO product_variants (
        id, product_id, size, sku, price, stock, is_default, barcode, barcode_type
      ) VALUES ('var_bad', 'prod_1', ' Small ', 'SKU-BAD', 100, 1, 0, '123', 'ean13');
    `);
    expect(invalidCanonicalIdentity.status).not.toBe(0);
    expect(invalidCanonicalIdentity.stderr).toContain("INVALID_PRODUCT_VARIANT_IDENTITY");

    const retiredMarker = execute(`
      INSERT INTO products (id) VALUES ('prod_1');
    `, `
      UPDATE products
      SET meta_description = '<!--variant_images:enabled-->'
      WHERE id = 'prod_1';
    `);
    expect(retiredMarker.status).not.toBe(0);
    expect(retiredMarker.stderr).toContain("LEGACY_VARIANT_IMAGE_MARKER_FORBIDDEN");
  });

  it("fails closed for an unaudited normalized option collision", () => {
    const result = execute(`
      INSERT INTO products (id) VALUES ('prod_other');
      INSERT INTO product_variants (
        id, product_id, size, color, sku, price, stock, is_default
      ) VALUES
        ('var_1', 'prod_other', 'M', 'Blue', 'SKU-1', 100, 1, 0),
        ('var_2', 'prod_other', 'm', 'blue', 'SKU-2', 100, 1, 0);
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CATALOG_IDENTITY_CUTOVER_PREFLIGHT_FAILED");
  });
});
