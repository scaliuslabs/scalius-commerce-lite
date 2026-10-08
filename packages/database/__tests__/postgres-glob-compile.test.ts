// SQLite GLOB checks must keep their meaning on Postgres. Before this, only a
// hard-coded list of patterns was translated; any other pattern became an
// invalid regex (a leading `*`) that broke its CHECK on the first insert.
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres, globToPostgresRegex } from "../scripts/postgres-schema";

/** What SQLite GLOB answers, for comparing the translation against. */
function sqliteGlob(pattern: string, value: string): boolean {
  const regex = new RegExp(globToPostgresRegex(pattern).replace(/^([^^])/, ".*$1").replace(/([^$])$/, "$1.*"));
  return regex.test(value);
}

describe("GLOB to Postgres regex", () => {
  it("keeps the short class for 'contains a character of'", () => {
    expect(globToPostgresRegex("*[^0-9a-f]*")).toBe("[^0-9a-f]");
    expect(globToPostgresRegex("*[^ -~]*")).toBe("[^ -~]");
    expect(globToPostgresRegex("*[^a-z0-9.-]*")).toBe("[^a-z0-9.-]");
  });

  it("anchors every other shape and escapes regex metacharacters", () => {
    expect(globToPostgresRegex("*.")).toBe("^.*\\.$");
    expect(globToPostgresRegex("loc_?*")).toBe("^loc_..*$");
    expect(globToPostgresRegex("a+b(c)")).toBe("^a\\+b\\(c\\)$");
    expect(globToPostgresRegex("[0-9][0-9]*")).toBe("^[0-9][0-9].*$");
  });

  it("matches what SQLite GLOB matches", () => {
    const cases: Array<[string, string, boolean]> = [
      ["*.", "scalius.", true],
      ["*.", "acme.hello", false],
      ["*[^0-9a-f]*", "abc123", false],
      ["*[^0-9a-f]*", "abcz", true],
      ["loc_?*", "loc_default", true],
      ["loc_?*", "loc_", false],
    ];
    for (const [pattern, value, expected] of cases) expect(sqliteGlob(pattern, value), `${pattern} ${value}`).toBe(expected);
  });

  it("compiles every literal GLOB and NOT GLOB in DDL, never leaving a leading *", () => {
    const sql = compileSqliteDdlForPostgres(
      `CREATE TABLE t (a text CHECK (a NOT GLOB '*[^ -~]*'), b text CHECK (b NOT GLOB '*.' AND b GLOB '[a-z]*'));`,
    );
    expect(sql).toContain(`!~ '[^ -~]'`);
    expect(sql).toContain(`!~ '^.*\\.$'`);
    expect(sql).toContain(`~ '^[a-z].*$'`);
    expect(sql).not.toMatch(/~ '\*/);
    expect(sql).not.toMatch(/\bGLOB\b/);
  });
});
