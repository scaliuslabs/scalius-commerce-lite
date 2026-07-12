import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { buildBatchGuard } from "../src/batch-helper";

describe("D1 batch guards", () => {
  it("builds a parameterized prepared statement with a D1 stmt", () => {
    const preparedStatement = { bind: vi.fn() };
    const client = {
      prepare: vi.fn(() => preparedStatement),
    } as unknown as D1Database;
    const db = drizzle(client);

    const guard = buildBatchGuard(
      db,
      sql`CASE WHEN ${"expected"} = ${"expected"} THEN 1 ELSE 0 END`,
    );
    const prepared = (guard as unknown as { _prepare(): {
      stmt?: unknown;
      getQuery(): { params: unknown[] };
    } })._prepare();

    expect(prepared.stmt).toBe(preparedStatement);
    expect(prepared.getQuery().params).toEqual(["expected", "expected"]);
  });
});
