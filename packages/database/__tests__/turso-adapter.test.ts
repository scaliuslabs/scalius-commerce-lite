import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { safeBatch } from "../src/batch-helper";
import { checkoutAttempts } from "../src/schema";
import {
  createTursoDatabase,
  isTursoConflictError,
  type TursoConnection,
} from "../src/turso-adapter";

function createAdapter(
  batch: TursoConnection["batch"],
  overrides: Parameters<typeof createTursoDatabase>[1] = {},
) {
  return createTursoDatabase(
    { url: "https://merchant.turso.io", authToken: "token" },
    {
      connect: () => ({ batch }),
      sleep: async () => undefined,
      random: () => 0,
      ...overrides,
    },
  );
}

describe("Turso SQLite adapter", () => {
  it("maps one remote raw-row request through stable Drizzle", async () => {
    const batch = vi.fn(async () => [{ rows: [[42]], rowsAffected: 0 }]);
    const db = createAdapter(batch);

    await expect(
      db.select({ answer: sql<number>`42` }).from(sql`(select 1)`).get(),
    ).resolves.toEqual({ answer: 42 });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[1]).toEqual({ raw: true });
  });

  it("maps read-only Drizzle batches to one consistent Turso read transaction", async () => {
    const batch = vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ rows: [[1]], rowsAffected: 0 })),
    );
    const db = createAdapter(batch);

    const [result] = await safeBatch(db, [
      db.select({ value: sql<number>`1` }).from(sql`(select 1)`),
    ] as const);

    expect(result).toEqual([{ value: 1 }]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[1]).toEqual({
      mode: "read",
      raw: true,
    });
  });

  it("keeps write-capable Drizzle batches atomic with the stable immediate mode", async () => {
    const batch = vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ rows: [], rowsAffected: 0 })),
    );
    const db = createAdapter(batch);

    await safeBatch(db, [
      db.delete(checkoutAttempts).where(sql`0`),
    ] as const);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[1]).toEqual({
      mode: "immediate",
      raw: true,
    });
  });

  it("allows an explicitly benchmarked target to opt into concurrent mode", async () => {
    const batch = vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({ rows: [], rowsAffected: 0 })),
    );
    const db = createAdapter(batch, { writeBatchMode: "concurrent" });

    await safeBatch(db, [
      db.delete(checkoutAttempts).where(sql`0`),
    ] as const);

    expect(batch.mock.calls[0]?.[1]).toEqual({
      mode: "concurrent",
      raw: true,
    });
  });

  it("retries only explicit MVCC busy/conflict failures", async () => {
    const sleep = vi.fn(async () => undefined);
    const onConflictRetry = vi.fn();
    const batch = vi
      .fn<TursoConnection["batch"]>()
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), {
        code: "SQLITE_BUSY_SNAPSHOT",
      }))
      .mockResolvedValueOnce([{ rows: [[1]], rowsAffected: 0 }]);
    const db = createAdapter(batch, { sleep, onConflictRetry });

    await expect(safeBatch(db, [
      db.select({ value: sql<number>`1` }).from(sql`(select 1)`),
    ] as const)).resolves.toEqual([[{ value: 1 }]]);

    expect(batch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2);
    expect(onConflictRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 2 });

    const fatalBatch = vi.fn<TursoConnection["batch"]>()
      .mockRejectedValue(new Error("authentication failed"));
    const fatalDb = createAdapter(fatalBatch, { sleep });
    await expect(safeBatch(fatalDb, [
      fatalDb.select({ value: sql<number>`1` }).from(sql`(select 1)`),
    ] as const)).rejects.toThrow(/authentication failed/);
    expect(fatalBatch).toHaveBeenCalledTimes(1);
  });

  it("recognizes nested Turso conflict causes without class coupling", () => {
    expect(isTursoConflictError(new Error("database is busy"))).toBe(true);
    expect(isTursoConflictError({ cause: { code: "SQLITE_BUSY" } })).toBe(true);
    expect(isTursoConflictError(new Error("invalid token"))).toBe(false);
  });

  it("identifies a rejected statement without executing batch writes", async () => {
    const batch = vi.fn<TursoConnection["batch"]>()
      .mockRejectedValueOnce(Object.assign(new Error("ambiguous column name: id"), {
        code: "SQL_INPUT_ERROR",
      }))
      .mockResolvedValueOnce([{ rows: [], rowsAffected: 0 }])
      .mockRejectedValueOnce(new Error("ambiguous column name: id"));
    const db = createAdapter(batch);

    await expect(safeBatch(db, [
      db.select({ first: sql<number>`1` }).from(sql`(select 1)`),
      db.select({ second: sql<number>`2` }).from(sql`(select 1)`),
    ] as const)).rejects.toThrow(/atomic batch statement 2.*ambiguous column name: id/i);

    expect(batch.mock.calls[0]?.[1]).toEqual({ mode: "read", raw: true });
    expect(batch.mock.calls[1]?.[0]?.[0]?.sql).toMatch(/^EXPLAIN /);
    expect(batch.mock.calls[2]?.[0]?.[0]?.sql).toMatch(/^EXPLAIN /);
  });
});
