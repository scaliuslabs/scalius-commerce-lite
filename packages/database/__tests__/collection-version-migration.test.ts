import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0015_salty_stepford_cuckoos.sql"),
  "utf8",
);

describe("collection version migration", () => {
  it("preserves existing rows and seeds their optimistic concurrency token", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        CREATE TABLE collections (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          presentation text NOT NULL,
          config text NOT NULL,
          sort_order integer DEFAULT 0 NOT NULL,
          is_active integer DEFAULT true NOT NULL,
          canonical_path text,
          no_index integer DEFAULT false NOT NULL,
          exclude_from_sitemap integer DEFAULT false NOT NULL,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          deleted_at integer
        );
        INSERT INTO collections VALUES ('col_1', 'Summer', 'grid', '{}', 3, 1, NULL, 0, 0, 100, 200, NULL);
        ${migration}
        SELECT id, name, sort_order, is_active, version, created_at, updated_at FROM collections;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("col_1|Summer|3|1|1|100|200");
  });

  it("rejects non-positive versions", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        CREATE TABLE collections (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          presentation text NOT NULL,
          config text NOT NULL,
          sort_order integer DEFAULT 0 NOT NULL,
          is_active integer DEFAULT true NOT NULL,
          canonical_path text,
          no_index integer DEFAULT false NOT NULL,
          exclude_from_sitemap integer DEFAULT false NOT NULL,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          deleted_at integer
        );
        ${migration}
        INSERT INTO collections (id, name, presentation, config, version) VALUES ('bad', 'Bad', 'grid', '{}', 0);
      `,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CHECK constraint failed");
  });
});
