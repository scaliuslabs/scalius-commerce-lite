import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { aliasDerivedTables } from "../scripts/postgres-schema";

// The PostgreSQL upgrade files are written by hand beside the SQLite chain.
// SQLite-only syntax in them fails on a real server (proved by applying the
// whole chain to PostgreSQL, postgres-chain.postgres-native.test.ts): GLOB has
// no PostgreSQL form, a trigger WHEN clause cannot hold a subquery (guard
// inside the function instead), and PostgreSQL 15 rejects a derived table
// without an alias (`FROM (SELECT ...) AS "name"`).
const directory = new URL("../migrations/postgres/", import.meta.url);
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

describe("PostgreSQL migration dialect", () => {
  it.each(files)("%s uses no SQLite-only GLOB, WHEN subquery or unnamed derived table", (file) => {
    const sql = readFileSync(new URL(file, directory), "utf8")
      .split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\bGLOB\b/i);
    expect(sql).not.toMatch(/^WHEN \(.*\(\s*SELECT\b/im);
    expect(aliasDerivedTables(sql)).toBe(sql);
  });

  it("names unnamed derived tables only", () => {
    expect(aliasDerivedTables(`SELECT "id" FROM (SELECT "id" FROM "t") WHERE "id" > 1`))
      .toBe(`SELECT "id" FROM (SELECT "id" FROM "t") AS "derived_1" WHERE "id" > 1`);
    expect(aliasDerivedTables(`SELECT 1 FROM "a" JOIN (SELECT "id" FROM "b") ON true`))
      .toBe(`SELECT 1 FROM "a" JOIN (SELECT "id" FROM "b") AS "derived_1" ON true`);
    for (const kept of [
      `SELECT "id" FROM (SELECT "id" FROM "t") AS "x"`,
      `SELECT "id" FROM (SELECT "id" FROM "t") x`,
      `SELECT NEW."b" IS DISTINCT FROM (SELECT 1 FROM "t")`,
      `SELECT 1 FROM json_each('(SELECT 1)') WHERE "v" IN (SELECT 1 FROM "t")`,
    ]) expect(aliasDerivedTables(kept)).toBe(kept);
  });
});
