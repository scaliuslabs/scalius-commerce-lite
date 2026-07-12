import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0020_chemical_captain_britain.sql"),
  "utf8",
);
const schemaSource = readFileSync(
  resolve(import.meta.dirname, "../src/schema/products.ts"),
  "utf8",
);
const snapshot = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../migrations/meta/0020_snapshot.json"),
  "utf8",
)) as { tables?: Record<string, unknown> };

describe("final product media cutover migration", () => {
  it("removes the URL-copy table from SQL and the generated schema authority", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        PRAGMA foreign_keys = ON;
        CREATE TABLE product_images (
          id TEXT PRIMARY KEY NOT NULL,
          product_id TEXT NOT NULL,
          url TEXT NOT NULL
        );
        INSERT INTO product_images VALUES ('legacy_image', 'prod_demo', 'https://legacy.invalid/image.jpg');
        ${migration}
        SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'product_images';
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("0");
    expect(migration.trim()).toBe("DROP TABLE `product_images`;");
    expect(schemaSource).not.toContain("export const productImages");
    expect(schemaSource).not.toContain("InferSelectModel<typeof productImages>");
    expect(snapshot.tables).not.toHaveProperty("product_images");
  });
});
