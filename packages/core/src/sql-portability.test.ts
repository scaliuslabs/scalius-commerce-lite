// Application SQL runs on D1, TursoDB and PostgreSQL. SQLite's json_valid()
// returns 0/1; the PostgreSQL compatibility function returns boolean, and
// PostgreSQL has no `boolean = integer` operator, so `json_valid(x) = 1` fails
// there ("operator does not exist") while `WHEN json_valid(x) THEN` works on
// both. The rule: use json_valid() as a predicate, never compare it. The same
// holds for EXISTS: it is 0/1 in SQLite and boolean in PostgreSQL, so a CASE
// whose branches are numbers cannot return it ("CASE types integer and boolean
// cannot be matched"); write `THEN CASE WHEN EXISTS (...) THEN 1 ELSE 0 END`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const SOURCE_DIRS = ["apps/api/src", "packages/core/src", "packages/database/src", "packages/shared/src"];
const SKIP = /(node_modules|generated|\.gen\.|\.test\.|__tests__|\/testing\/|dist)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.test(path)) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

/** `json_valid(<arguments>) = 1`, `<> 0`, `!= 0`, `IS NOT 1`, `= true`: a comparison of the predicate. */
const COMPARED_JSON_VALID =
  /\bjson_valid\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*(?:==?|<>|!=|IS(?:\s+NOT)?)\s*(?:[01]\b|true\b|false\b)/gi;

/** `THEN EXISTS (` / `ELSE NOT EXISTS (`: a predicate as a CASE result. */
const EXISTS_AS_CASE_RESULT = /\b(?:THEN|ELSE)\s+(?:NOT\s+)?EXISTS\s*\(/gi;

function offenders(pattern: RegExp): string[] {
  return SOURCE_DIRS
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .flatMap((path) => {
      const matches = readFileSync(path, "utf8").match(pattern) ?? [];
      return matches.map((match) => `${relative(ROOT, path)}: ${match.replace(/\s+/g, " ")}`);
    });
}

describe("json_valid() is a predicate, not a number", () => {
  it("recognizes the comparisons the rule forbids and not the predicate", () => {
    for (const bad of [
      "WHEN json_valid(x) = 1 THEN",
      "json_valid(${collections.config}) = 0",
      "json_valid(t.c)\n  <> 0",
      "json_valid(json_extract(v, '$.a')) != 0",
      "json_valid(x) IS NOT 1",
      "json_valid(x) = true",
    ]) {
      expect(bad.match(COMPARED_JSON_VALID), bad).not.toBeNull();
    }
    for (const good of [
      "WHEN json_valid(x) THEN",
      "WHEN NOT json_valid(x) THEN",
      "json_valid(x) AND json_type(x) = 'object'",
      "CASE WHEN json_valid(x) THEN json_extract(x, '$.a') END = 1",
    ]) {
      expect(good.match(COMPARED_JSON_VALID), good).toBeNull();
    }
  });

  it("is used as a predicate everywhere in the application's SQL", () => {
    expect(offenders(COMPARED_JSON_VALID)).toEqual([]);
  });
});

describe("a CASE returns numbers, never an EXISTS predicate", () => {
  it("recognizes the forbidden shape and not the wrapped one", () => {
    expect("CASE WHEN a THEN EXISTS (SELECT 1) ELSE 0 END".match(EXISTS_AS_CASE_RESULT)).not.toBeNull();
    expect("ELSE NOT EXISTS(SELECT 1) END".match(EXISTS_AS_CASE_RESULT)).not.toBeNull();
    expect("THEN CASE WHEN EXISTS (SELECT 1) THEN 1 ELSE 0 END".match(EXISTS_AS_CASE_RESULT)).toBeNull();
    expect("WHERE a AND EXISTS (SELECT 1)".match(EXISTS_AS_CASE_RESULT)).toBeNull();
  });

  it("holds in the application's SQL", () => {
    expect(offenders(EXISTS_AS_CASE_RESULT)).toEqual([]);
  });
});
