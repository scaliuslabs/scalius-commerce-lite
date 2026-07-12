import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0024_kind_spitfire.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const legacySchema = `
  CREATE TABLE settings (
    id TEXT PRIMARY KEY NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    UNIQUE (key, category)
  );
`;

describe("theme settings revision migration", () => {
  it("preserves the legacy storefront palette as revision one", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        INSERT INTO settings (id, key, value, type, category, updated_at)
        VALUES ('legacy_theme', 'storefront_colors', '{"primary":"#2563eb"}', 'json', 'theme', 1);
        ${migration}
        SELECT id || ':' || colors || ':' || revision FROM theme_settings;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('default:{"primary":"#2563eb"}:1');
  });

  it("leaves a fresh installation unclaimed for its first CAS publish", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        ${migration}
        SELECT count(*) FROM theme_settings;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });
});
