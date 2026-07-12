import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0023_bouncy_norman_osborn.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const legacySchema = `
  CREATE TABLE hero_sliders (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    images TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
`;

describe("hero slider revision migration", () => {
  it("backfills revisions and deterministically retires duplicate active viewport rows", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        INSERT INTO hero_sliders VALUES
          ('slider_old', 'desktop', '[]', 1, 1, 10, NULL),
          ('slider_new', 'desktop', '[]', 1, 2, 20, NULL),
          ('slider_mobile', 'mobile', '[]', 0, 3, 30, NULL);
        ${migration}
        SELECT id || ':' || revision || ':' || (deleted_at IS NOT NULL)
        FROM hero_sliders ORDER BY id;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "slider_mobile:1:0",
      "slider_new:1:0",
      "slider_old:2:1",
    ]);
  });
});
