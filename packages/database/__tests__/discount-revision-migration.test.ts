import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0026_grey_retro_girl.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const legacySchema = `
  CREATE TABLE discounts (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL,
    value_type TEXT NOT NULL,
    discount_value REAL NOT NULL,
    min_purchase_amount REAL,
    min_quantity INTEGER,
    max_uses_per_order INTEGER,
    max_uses INTEGER,
    limit_one_per_customer INTEGER DEFAULT false NOT NULL,
    combine_with_product_discounts INTEGER DEFAULT false NOT NULL,
    combine_with_order_discounts INTEGER DEFAULT false NOT NULL,
    combine_with_shipping_discounts INTEGER DEFAULT false NOT NULL,
    customer_segment TEXT,
    start_date INTEGER NOT NULL,
    end_date INTEGER,
    is_active INTEGER DEFAULT true NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE UNIQUE INDEX discounts_code_unique_idx ON discounts (code);
  CREATE TABLE discount_products (
    id TEXT PRIMARY KEY NOT NULL,
    discount_id TEXT NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL
  );
`;

describe("discount revision migration", () => {
  it("preserves existing rules and their child references at revision one", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        PRAGMA foreign_keys = ON;
        ${legacySchema}
        INSERT INTO discounts (
          id, code, type, value_type, discount_value, start_date,
          is_active, created_at, updated_at
        ) VALUES (
          'disc_legacy', 'WELCOME10', 'amount_off_order', 'percentage', 10,
          1700000000, true, 1700000000, 1700000000
        );
        INSERT INTO discount_products (id, discount_id, product_id)
        VALUES ('dp_legacy', 'disc_legacy', 'prod_1');
        ${migration}
        SELECT code || ':' || revision FROM discounts;
        SELECT discount_id FROM discount_products;
        PRAGMA foreign_key_check;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "WELCOME10:1",
      "disc_legacy",
    ]);
  });

  it("rejects non-positive revisions after cutover", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        ${migration}
        INSERT INTO discounts (
          id, code, type, value_type, discount_value, revision, start_date,
          is_active, created_at, updated_at
        ) VALUES (
          'disc_invalid', 'INVALID', 'amount_off_order', 'percentage', 10, 0,
          1700000000, true, 1700000000, 1700000000
        );
      `,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/discounts_revision_positive|CHECK constraint failed/u);
  });
});
