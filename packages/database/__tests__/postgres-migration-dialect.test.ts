import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The PostgreSQL upgrade files are written by hand beside the SQLite chain.
// SQLite-only syntax in them fails on a real server (proved by applying the
// whole chain to PostgreSQL): GLOB has no PostgreSQL form, and a trigger WHEN
// clause cannot hold a subquery (guard inside the function instead).
const directory = new URL("../migrations/postgres/", import.meta.url);
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

describe("PostgreSQL migration dialect", () => {
  it.each(files)("%s uses no SQLite-only GLOB or WHEN subquery", (file) => {
    const sql = readFileSync(new URL(file, directory), "utf8")
      .split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\bGLOB\b/i);
    expect(sql).not.toMatch(/^WHEN \(.*\(\s*SELECT\b/im);
  });
});
