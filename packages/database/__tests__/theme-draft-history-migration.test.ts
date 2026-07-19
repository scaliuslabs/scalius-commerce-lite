import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0035_shallow_loki.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const existingThemeSchema = `
  CREATE TABLE theme_settings (
    id TEXT PRIMARY KEY NOT NULL,
    colors TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

describe("theme draft, history, and preview migration", () => {
  it("backfills the exact published document into history and a clean draft", () => {
    const theme = JSON.stringify({
      colors: { primary: "#2563eb" },
      density: "compact",
    });
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${existingThemeSchema}
        INSERT INTO theme_settings VALUES ('default', '${theme}', 6, 10, 20);
        ${migration}
        SELECT published_revision || ':' || source || ':' || theme
          FROM theme_settings_versions;
        SELECT revision || ':' || base_published_revision || ':' || theme
          FROM theme_settings_drafts;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `6:migration:${theme}`,
      `1:6:${theme}`,
    ]);
  });

  it("keeps a fresh store unclaimed and enforces singleton/revision guards", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${existingThemeSchema}
        ${migration}
        SELECT count(*) || ':' || (SELECT count(*) FROM theme_settings_versions)
          FROM theme_settings_drafts;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("0:0");

    const invalid = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${existingThemeSchema}
        ${migration}
        INSERT INTO theme_settings_drafts
          (id, theme, revision, base_published_revision, created_at, updated_at)
        VALUES ('other', '{}', 0, -1, 1, 1);
      `,
      encoding: "utf8",
    });
    expect(invalid.status).not.toBe(0);
  });
});
