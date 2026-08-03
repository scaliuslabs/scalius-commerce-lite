import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { safeBatch } from "../src/batch-helper";
import {
  checkoutAttempts,
  customers,
  customerSessions,
} from "../src/schema";
import {
  createTursoDatabase,
  isTursoConflictError,
  TURSO_DEFAULT_QUERY_TIMEOUT_MS,
  type TursoConnection,
} from "../src/turso-adapter";
import { createProviderSchemaDatabase } from "../scripts/sqlite-provider-schema";

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

function createStatefulConnection(
  database: DatabaseSync,
  requestedModes: Array<string | undefined>,
): TursoConnection {
  return {
    async batch(statements, options) {
      requestedModes.push(options?.mode);
      const transactional = options?.mode !== undefined;
      if (transactional) {
        database.exec(options?.mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      }
      try {
        const results = statements.map((statement) => {
          const sqlText = typeof statement === "string" ? statement : statement.sql;
          const args = typeof statement === "string" || statement.args === undefined
            ? []
            : statement.args;
          if (!Array.isArray(args)) {
            throw new Error("Stateful Turso test connection accepts positional arguments only.");
          }
          const prepared = database.prepare(sqlText);
          if (prepared.columns().length === 0) {
            const result = prepared.run(...args as SQLInputValue[]);
            return { rows: [], rowsAffected: Number(result.changes) };
          }
          prepared.setReturnArrays(true);
          return {
            rows: prepared.all(
              ...args as SQLInputValue[],
            ) as unknown as SQLOutputValue[][],
            rowsAffected: 0,
          };
        });
        if (transactional) database.exec("COMMIT");
        return results;
      } catch (error) {
        if (transactional && database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("Turso SQLite adapter", () => {
  it("bounds remote queries and preserves an explicit tighter timeout", () => {
    const connect = vi.fn(() => ({ batch: vi.fn() }));

    createTursoDatabase(
      { url: "https://merchant.turso.io", authToken: "token" },
      { connect },
    );
    createTursoDatabase(
      {
        url: "https://merchant.turso.io",
        authToken: "token",
        defaultQueryTimeout: 2_000,
      },
      { connect },
    );

    expect(connect).toHaveBeenNthCalledWith(1, expect.objectContaining({
      defaultQueryTimeout: TURSO_DEFAULT_QUERY_TIMEOUT_MS,
    }));
    expect(connect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      defaultQueryTimeout: 2_000,
    }));
  });

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

  it("persists, revokes, expires, and rolls back sessions through the stateful adapter", async () => {
    const database = await createProviderSchemaDatabase("turso");
    database.exec("PRAGMA foreign_keys = ON");
    const requestedModes: Array<string | undefined> = [];
    const db = createTursoDatabase(
      { url: "turso://stateful-conformance.turso.io", authToken: "token" },
      {
        connect: () => createStatefulConnection(database, requestedModes),
        writeBatchMode: "concurrent",
      },
    );
    const nowSeconds = 1_900_000_000;

    try {
      await safeBatch(db, [
        db.insert(customers).values({
          id: "customer_stateful",
          name: "Stateful Buyer",
          email: "stateful@example.test",
          phone: "+8801700000001",
        }),
        db.insert(customerSessions).values({
          tokenHash: "a".repeat(64),
          customerId: "customer_stateful",
          expiresAt: nowSeconds + 3_600,
        }),
      ] as const);

      const [activeRows] = await safeBatch(db, [
        db.select({
          customerId: customerSessions.customerId,
          name: customers.name,
        })
          .from(customerSessions)
          .innerJoin(customers, eq(customerSessions.customerId, customers.id))
          .where(and(
            eq(customerSessions.tokenHash, "a".repeat(64)),
            isNull(customerSessions.revokedAt),
            gt(customerSessions.expiresAt, nowSeconds),
          )),
      ] as const);
      expect(activeRows).toEqual([{
        customerId: "customer_stateful",
        name: "Stateful Buyer",
      }]);

      await db.update(customerSessions)
        .set({ revokedAt: nowSeconds, updatedAt: nowSeconds })
        .where(eq(customerSessions.tokenHash, "a".repeat(64)));
      await expect(db.select({ tokenHash: customerSessions.tokenHash })
        .from(customerSessions)
        .where(and(
          eq(customerSessions.tokenHash, "a".repeat(64)),
          isNull(customerSessions.revokedAt),
          gt(customerSessions.expiresAt, nowSeconds),
        ))
        .get()).resolves.toBeUndefined();

      await db.insert(customerSessions).values({
        tokenHash: "b".repeat(64),
        customerId: "customer_stateful",
        expiresAt: nowSeconds - 1,
      });
      await expect(db.select({ tokenHash: customerSessions.tokenHash })
        .from(customerSessions)
        .where(and(
          eq(customerSessions.tokenHash, "b".repeat(64)),
          isNull(customerSessions.revokedAt),
          gt(customerSessions.expiresAt, nowSeconds),
        ))
        .get()).resolves.toBeUndefined();

      await expect(safeBatch(db, [
        db.insert(customers).values({
          id: "customer_rollback",
          name: "Rollback Buyer",
          phone: "+8801700000002",
        }),
        db.insert(customerSessions).values({
          tokenHash: "c".repeat(64),
          customerId: "missing_customer",
          expiresAt: nowSeconds + 3_600,
        }),
      ] as const)).rejects.toThrow(/foreign key/i);
      await expect(db.select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, "customer_rollback"))
        .get()).resolves.toBeUndefined();

      expect(requestedModes).toContain("concurrent");
      expect(requestedModes).toContain("read");
    } finally {
      database.close();
    }
  });
});
