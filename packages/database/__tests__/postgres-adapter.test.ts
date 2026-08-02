import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { safeBatch } from "../src/batch-helper";
import {
  createPostgresDatabase,
  isPostgresSerializationError,
  type PostgresFullResult,
  type PostgresHttpConnection,
  type PostgresQuery,
} from "../src/postgres-adapter";
import { checkoutAttempts } from "../src/schema";

type FullResult = PostgresFullResult & {
  rowCount: number;
  command: string;
  rowAsArray: true;
};

function result(
  rows: unknown[][] = [],
  dataTypeIds: number[] = [],
  command = "SELECT",
): FullResult {
  return {
    rows,
    rowCount: rows.length,
    command,
    rowAsArray: true,
    fields: dataTypeIds.map((dataTypeID, index) => ({
      name: `column_${index}`,
      tableID: 0,
      columnID: index,
      dataTypeID,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: "text",
    })),
  };
}

function queryPromise(value: FullResult): PostgresQuery {
  return Promise.resolve(value);
}

function createConnection(
  resolveQuery: (sql: string, params: readonly unknown[]) => FullResult = () => result(),
): PostgresHttpConnection & {
  queries: Array<{ sql: string; params: readonly unknown[] }>;
  transaction: ReturnType<typeof vi.fn<PostgresHttpConnection["transaction"]>>;
} {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const transaction = vi.fn<PostgresHttpConnection["transaction"]>(
    async (pending) => Promise.all(pending),
  );
  return {
    queries,
    query(sqlText, params) {
      queries.push({ sql: sqlText, params });
      return queryPromise(resolveQuery(sqlText, params));
    },
    transaction,
  };
}

function createAdapter(
  connection: PostgresHttpConnection,
  overrides: Parameters<typeof createPostgresDatabase>[1] = {},
) {
  return createPostgresDatabase(
    "postgresql://user:secret@example.neon.tech/neondb",
    {
      connect: () => connection,
      sleep: async () => undefined,
      random: () => 0,
      ...overrides,
    },
  );
}

describe("PostgreSQL HTTP adapter", () => {
  it("maps a read through the common SQLite Drizzle surface", async () => {
    const connection = createConnection(() => result([["42"]], [20]));
    const db = createAdapter(connection);

    await expect(
      db.select({ answer: sql<number>`42` }).from(sql`(select 1)`).get(),
    ).resolves.toEqual({ answer: 42 });

    expect(connection.queries).toHaveLength(1);
    expect(connection.transaction).not.toHaveBeenCalled();
  });

  it("preserves SQLite get semantics when PostgreSQL returns no row", async () => {
    const connection = createConnection(() => result());
    const db = createAdapter(connection);

    await expect(
      db.get<{ found: number }>(sql`select 1 as found where false`),
    ).resolves.toBeUndefined();
  });

  it("uses one repeatable-read snapshot for read batches", async () => {
    const connection = createConnection(() => result([[1]], [23]));
    const db = createAdapter(connection);

    await expect(safeBatch(db, [
      db.select({ value: sql<number>`1` }).from(sql`(select 1)`),
    ] as const)).resolves.toEqual([[{ value: 1 }]]);

    expect(connection.transaction).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        isolationLevel: "RepeatableRead",
        readOnly: true,
      }),
    );
  });

  it("uses serializable one-shot transactions for every write", async () => {
    const connection = createConnection(() => result([], [], "DELETE"));
    const db = createAdapter(connection);

    await safeBatch(db, [
      db.delete(checkoutAttempts).where(sql`0`),
    ] as const);

    expect(connection.transaction).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        isolationLevel: "Serializable",
        readOnly: false,
      }),
    );
  });

  it("captures SQLite changes() transaction-locally without a session pool", async () => {
    const connection = createConnection((sqlText) => {
      if (sqlText.includes("__scalius_changes")) {
        return result([["1", "1"]], [25, 20]);
      }
      return result([[1]], [23]);
    });
    const db = createAdapter(connection);

    await safeBatch(db, [
      db.update(checkoutAttempts).set({ attempts: 2 }).where(sql`0`),
      db.select({ committed: sql<number>`changes()` }).from(sql`(select 1)`),
    ] as const);

    expect(connection.queries[0]?.sql).toContain("WITH scalius_mutation AS");
    expect(connection.queries[0]?.sql).toContain("set_config('scalius.changes'");
    expect(connection.queries[1]?.sql).toContain("changes()");
  });

  it("retries serialization/deadlock failures and rejects ordinary errors", async () => {
    const connection = createConnection(() => result([[1]], [23]));
    connection.transaction
      .mockRejectedValueOnce(Object.assign(new Error("serialization failure"), { code: "40001" }))
      .mockImplementationOnce(async (pending) => Promise.all(pending));
    const onSerializationRetry = vi.fn();
    const db = createAdapter(connection, { onSerializationRetry });

    await expect(safeBatch(db, [
      db.delete(checkoutAttempts).where(sql`0`),
    ] as const)).resolves.toBeDefined();
    expect(connection.transaction).toHaveBeenCalledTimes(2);
    expect(onSerializationRetry).toHaveBeenCalledWith({
      attempt: 1,
      delayMs: 2,
      code: "40001",
    });

    const fatal = createConnection(() => result());
    fatal.transaction.mockRejectedValue(new Error("permission denied"));
    const fatalDb = createAdapter(fatal);
    await expect(safeBatch(fatalDb, [
      fatalDb.delete(checkoutAttempts).where(sql`0`),
    ] as const)).rejects.toThrow(/permission denied/);
    expect(fatal.transaction).toHaveBeenCalledTimes(1);
  });

  it("recognizes nested PostgreSQL conflict codes without driver coupling", () => {
    expect(isPostgresSerializationError({ code: "40001" })).toBe(true);
    expect(isPostgresSerializationError({ cause: { code: "40P01" } })).toBe(true);
    expect(isPostgresSerializationError({ code: "23505" })).toBe(false);
  });
});
