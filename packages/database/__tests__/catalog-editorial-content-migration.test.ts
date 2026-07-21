import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0042_red_spencer_smythe.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

describe("catalog editorial content migration", () => {
  it("adds category and collection copy without changing existing rows", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        CREATE TABLE categories (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          slug text NOT NULL,
          description text
        );
        CREATE TABLE collections (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          presentation text NOT NULL,
          config text NOT NULL
        );
        INSERT INTO categories VALUES ('cat_1', 'Footwear', 'footwear', 'Everyday shoes');
        INSERT INTO collections VALUES ('col_1', 'Summer', 'grid', '{}');
        ${migration}
        UPDATE categories SET content = '<h2>Buying guide</h2>' WHERE id = 'cat_1';
        UPDATE collections SET
          description = '<p>Seasonal picks</p>',
          content = '<h2>How to choose</h2>',
          meta_title = 'Summer essentials',
          meta_description = 'Shop summer essentials'
        WHERE id = 'col_1';
        SELECT id, name, description, content FROM categories;
        SELECT id, name, description, content, meta_title, meta_description FROM collections;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "cat_1|Footwear|Everyday shoes|<h2>Buying guide</h2>",
      "col_1|Summer|<p>Seasonal picks</p>|<h2>How to choose</h2>|Summer essentials|Shop summer essentials",
    ]);
  });
});
