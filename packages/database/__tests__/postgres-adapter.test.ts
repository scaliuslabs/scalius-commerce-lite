import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { safeBatch } from "../src/batch-helper";
import {
  connectNativePostgres,
  createPostgresDatabase,
  isPostgresSerializationError,
  type NativePostgresConnectionOptions,
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

  it("preserves raw names and normalized values in standalone reads and mixed batches", async () => {
    const columns = ["answer", "duplicate", "duplicate", "__proto__", "with space", "length", "0", ""];
    const values = [7, "first", "last", "safe", null, "length", "zero", "blank"];
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    const connection = createConnection((text) => {
      if (/\bwhere\b/i.test(text)) return result();
      if (text.startsWith("DELETE")) return result([], [], "DELETE");
      const response = result([["7", ...values.slice(1)]], [20, 25, 25, 25, 25, 25, 25, 25]);
      response.fields.forEach((field, index) => { field.name = columns[index]!; });
      return response;
    });
    const onOperation = vi.fn();
    const db = createAdapter(connection, { onOperation });
    const query = sql`SELECT ${7} AS answer, 'first' AS duplicate, 'last' AS duplicate,
      'safe' AS "__proto__", NULL AS "with space", 'length' AS length, 'zero' AS "0", 'blank' AS ""`;
    await expect(db.all(query)).resolves.toEqual([row]);
    await expect(db.get(query)).resolves.toEqual(row);
    await expect(db.values(query)).resolves.toEqual([values]);
    await expect(db.all("SELECT 1 WHERE false")).resolves.toEqual([]);
    await expect(db.get("SELECT 1 WHERE false")).resolves.toBeUndefined();
    expect(connection.queries).toHaveLength(5);
    expect(onOperation).toHaveBeenCalledTimes(5);

    await expect(safeBatch(db, [
      db.select({ answer: sql<number>`7` }).from(sql`(SELECT 1)`),
      db.all(query), db.get(query), db.values(query), db.get("SELECT 1 WHERE false"),
    ] as const)).resolves.toEqual([[{ answer: 7 }], [row], row, [values], undefined]);
    expect(connection.transaction).toHaveBeenCalledTimes(1);
    expect(connection.transaction).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: "RepeatableRead", readOnly: true }));

    await db.run("DELETE FROM checkout_attempts WHERE false");
    await expect(safeBatch(db, [
      db.run("DELETE FROM checkout_attempts WHERE false"), db.get(query),
    ] as const)).resolves.toEqual([{ rows: [], columns: [] }, row]);
    expect(connection.transaction).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: "Serializable", readOnly: false }));
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

describe("native PostgreSQL transport", () => {
  type NativeClient = ReturnType<NonNullable<NativePostgresConnectionOptions["createClient"]>>;
  function nativeClient() {
    return {
      connect: vi.fn(async () => undefined),
      query: vi.fn<NativeClient["query"]>(async ({ text }) => ({
        rows: text === "SELECT $1" ? [[42]] : [],
        fields: text === "SELECT $1"
          ? [{ name: "answer", dataTypeID: 23 }]
          : [],
      })),
      end: vi.fn(async () => undefined),
    };
  }

  it("owns and closes one client for a standalone query", async () => {
    const client = nativeClient();
    const connection = connectNativePostgres(
      "postgresql://user:secret@postgres.example.com/scalius",
      { createClient: () => client },
    );

    await expect(connection.query("SELECT $1", [42])).resolves.toEqual({
      rows: [[42]],
      fields: [{ name: "answer", dataTypeID: 23 }],
    });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith({
      text: "SELECT $1",
      values: [42],
      rowMode: "array",
    });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("executes lazy queries on one transaction client", async () => {
    const client = nativeClient();
    const connection = connectNativePostgres(
      "postgresql://user:secret@postgres.example.com/scalius",
      { createClient: () => client },
    );
    const first = connection.query("SELECT $1", [42]);
    const second = connection.query("UPDATE example SET value = $1", [7]);

    await expect(connection.transaction([first, second], {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "Serializable",
      readOnly: false,
    })).resolves.toHaveLength(2);

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
      "SELECT $1",
      "UPDATE example SET value = $1",
      "COMMIT",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(["standalone", "transaction"] as const)("normalizes rowless multi-command DDL as one %s result without splitting its SQL", async (mode) => {
    const ddl = "CREATE FUNCTION example_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; "
      + "CREATE TRIGGER example_trigger AFTER INSERT ON example FOR EACH ROW EXECUTE FUNCTION example_fn();";
    const ledger = "INSERT INTO migration_ledger(version) VALUES(143)";
    const client = nativeClient();
    client.query.mockImplementation(async ({ text }) => text === ddl
      ? [{ rows: [], fields: [] }, { rows: [], fields: [] }]
      : { rows: [], fields: [] });
    const connection = connectNativePostgres("postgresql://localhost/owned_test", { createClient: () => client });
    if (mode === "standalone") {
      await expect(connection.query(ddl, [])).resolves.toEqual({ rows: [], fields: [] });
      expect(client.query.mock.calls.map(([input]) => input.text)).toEqual([ddl]);
    } else {
      await expect(connection.transaction([connection.query(ddl, []), connection.query(ledger, [])], {
        arrayMode: true, fullResults: true, isolationLevel: "Serializable", readOnly: false,
      })).resolves.toEqual([{ rows: [], fields: [] }, { rows: [], fields: [] }]);
      expect(client.query.mock.calls.map(([input]) => input.text)).toEqual([
        "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE", ddl, ledger, "COMMIT",
      ]);
    }
    expect(client.query).toHaveBeenCalledWith({ text: ddl, values: [], rowMode: "array" });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects row-bearing multi-command results instead of discarding rows, and rolls the batch back", async () => {
    const client = nativeClient();
    const text = "UPDATE example SET value=1; SELECT value FROM example";
    client.query.mockImplementation(async (input) => input.text === text
      ? [{ rows: [], fields: [] }, { rows: [[1]], fields: [{ name: "value", dataTypeID: 23 }] }]
      : { rows: [], fields: [] });
    const connection = connectNativePostgres("postgresql://localhost/owned_test", { createClient: () => client });
    await expect(connection.transaction([connection.query(text, [])], {
      arrayMode: true, fullResults: true, isolationLevel: "Serializable", readOnly: false,
    })).rejects.toThrow("Multi-command PostgreSQL queries cannot return rows.");
    expect(client.query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE", text, "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rolls back and closes after a failed transaction statement", async () => {
    const failure = Object.assign(new Error("deadlock"), { code: "40P01" });
    const client = nativeClient();
    client.query.mockImplementation(async ({ text }: { text: string }) => {
      if (text === "UPDATE broken") throw failure;
      return { rows: [], fields: [] };
    });
    const connection = connectNativePostgres(
      "postgresql://user:secret@postgres.example.com/scalius",
      { createClient: () => client },
    );

    await expect(connection.transaction([
      connection.query("UPDATE broken", []),
    ], {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "ReadCommitted",
      readOnly: false,
    })).rejects.toBe(failure);
    expect(client.query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      "UPDATE broken",
      "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("preserves the query error when closing the failed client also fails", async () => {
    const queryFailure = Object.assign(new Error("serialization failure"), {
      code: "40001",
    });
    const client = nativeClient();
    client.query.mockRejectedValue(queryFailure);
    client.end.mockRejectedValue(new Error("socket close failed"));
    const connection = connectNativePostgres(
      "postgresql://user:secret@postgres.example.com/scalius",
      { createClient: () => client },
    );

    await expect(connection.query("SELECT 1", [])).rejects.toBe(queryFailure);
    expect(client.end).toHaveBeenCalledOnce();
  });
});
