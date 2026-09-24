import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError } from "../src/batch-helper";
import { compileSqliteStatementForPostgres } from "../src/postgres-sqlite-profile";

describe("D1 batch guards", () => {
  it("builds a parameterized prepared statement with a D1 stmt", () => {
    const preparedStatement = { bind: vi.fn() };
    const client = {
      prepare: vi.fn(() => preparedStatement),
    } as unknown as D1Database;
    const db = drizzle(client);

    const guard = buildBatchGuard(
      db,
      sql`${"expected"} = ${"expected"}`,
      "TEST_GUARD",
    );
    const prepared = (guard as unknown as { _prepare(): {
      stmt?: unknown;
      getQuery(): { sql: string; params: unknown[] };
    } })._prepare();

    expect(prepared.stmt).toBe(preparedStatement);
    const query = prepared.getQuery();
    expect(query.params).toEqual([
      "expected",
      "expected",
    ]);
    expect(query.sql).toContain("json_extract('{}', 'TEST_GUARD')");
    expect(compileSqliteStatementForPostgres(query.sql, query.params.length).sql)
      .toContain("scalius_compat.fail_bigint('TEST_GUARD')");
  });

  it("rejects markers that could be valid JSON or executable SQL", () => {
    const db = drizzle({ prepare: vi.fn() } as unknown as D1Database);

    expect(() => buildBatchGuard(db, sql`1 = 0`, "0"))
      .toThrow("uppercase identifiers");
    expect(() => buildBatchGuard(db, sql`1 = 0`, "GUARD')"))
      .toThrow("uppercase identifiers");
  });

  it("recognizes provider-specific guard errors without matching unrelated casts", () => {
    expect(isBatchGuardError(
      new Error("D1_ERROR: malformed JSON"),
      "TEST_GUARD",
    )).toBe(true);
    expect(isBatchGuardError({
      message: "PostgreSQL query failed",
      cause: {
        code: "23514",
        message: "TEST_GUARD",
      },
    }, "TEST_GUARD")).toBe(true);
    expect(isBatchGuardError({
      code: "22P02",
      message: "invalid input syntax for type integer",
    }, "TEST_GUARD")).toBe(false);
  });
});

describe("D1 multi-row insert chunking", () => {
  it("keeps every statement below the 100-parameter ceiling", () => {
    const rows = Array.from({ length: 99 }, (_, index) => index);

    for (const parametersPerRow of [13, 18]) {
      const chunks = chunkRowsForD1(rows, parametersPerRow);
      expect(chunks.flat()).toEqual(rows);
      expect(Math.max(...chunks.map((chunk) => chunk.length * parametersPerRow)))
        .toBeLessThan(100);
    }
  });

  it("rejects an invalid parameter estimate", () => {
    expect(() => chunkRowsForD1([1], 0)).toThrow(RangeError);
  });
});
