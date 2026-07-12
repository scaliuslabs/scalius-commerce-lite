import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0010_serious_maverick.sql"),
  "utf8",
);

function execute(rows: string) {
  return spawnSync("sqlite3", [":memory:"], {
    input: `.bail on
      CREATE TABLE collections (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL
      );
      ${rows}
      ${migration}
      SELECT id, presentation, config FROM collections ORDER BY id;
    `,
    encoding: "utf8",
  });
}

describe("canonical collection model migration", () => {
  it("separates presentation from explicit membership source", () => {
    const result = execute(`
      INSERT INTO collections VALUES
        ('dynamic', 'Dynamic', 'dynamic', '{"categoryIds":["cat_1"]}'),
        ('manual', 'Manual', 'manual', '{"specificProductIds":["prod_1"]}'),
        ('invalid', 'Invalid', 'manual', 'not json');
    `);

    expect(result.status, result.stderr).toBe(0);
    const [dynamic, invalid, manual] = result.stdout.trim().split("\n").map((line) => {
      const [id, presentation, config] = line.split("|");
      return { id, presentation, config: JSON.parse(config!) };
    });

    expect(dynamic).toMatchObject({
      id: "dynamic",
      presentation: "carousel",
      config: { source: "dynamic", categoryIds: ["cat_1"], productIds: [] },
    });
    expect(invalid).toMatchObject({
      id: "invalid",
      presentation: "grid",
      config: { source: "manual", categoryIds: [], productIds: [] },
    });
    expect(manual).toMatchObject({
      id: "manual",
      presentation: "grid",
      config: { source: "manual", categoryIds: [], productIds: ["prod_1"] },
    });
    expect(manual!.config).not.toHaveProperty("specificProductIds");
  });
});
