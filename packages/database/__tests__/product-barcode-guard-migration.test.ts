import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0011_product_barcode_guard.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const schema = `
  CREATE TABLE product_images (id TEXT PRIMARY KEY, product_id TEXT NOT NULL);
  CREATE TABLE product_variants (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    option_combination_key TEXT,
    image_id TEXT,
    sku TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    barcode TEXT,
    barcode_type TEXT
  );
`;

function execute(sql: string) {
  return spawnSync("sqlite3", [":memory:"], {
    input: `.bail on\n${schema}\n${migration}\n${sql}`,
    encoding: "utf8",
  });
}

describe("product barcode database guard", () => {
  it("accepts the platform internal Code 128 namespace", () => {
    const result = execute(`
      INSERT INTO product_variants (
        id, product_id, option_combination_key, sku, barcode, barcode_type
      ) VALUES (
        'var_1', 'prod_1', 'value_1', 'SKU-1', 'SCALIUS:C128:abc_123', 'code128'
      );
    `);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["unsupported type", "'12345678', 'qr'"],
    ["malformed EAN-13", "'123', 'ean13'"],
    ["non-printable Code 128", "'SCALIUS:C128:' || char(10), 'code128'"],
  ])("rejects %s", (_label, barcodePair) => {
    const result = execute(`
      INSERT INTO product_variants (
        id, product_id, option_combination_key, sku, barcode, barcode_type
      ) VALUES ('var_bad', 'prod_1', 'value_1', 'SKU-BAD', ${barcodePair});
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INVALID_PRODUCT_VARIANT_IDENTITY");
  });

  it("keeps direct image ownership enforcement when replacing the trigger", () => {
    const result = execute(`
      INSERT INTO product_images VALUES ('img_other', 'prod_2');
      INSERT INTO product_variants (
        id, product_id, option_combination_key, image_id, sku
      ) VALUES ('var_bad', 'prod_1', 'value_1', 'img_other', 'SKU-BAD');
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INVALID_PRODUCT_VARIANT_IDENTITY");
  });
});
