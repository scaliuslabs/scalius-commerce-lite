import type { Connection } from "@tursodatabase/serverless";
import { describe, expect, it, vi } from "vitest";

import type { PortableSqlStatement } from "../src/checkout-commit";
import { createCheckoutSqlTransport } from "../src/checkout-transport";
import { TURSO_DEFAULT_QUERY_TIMEOUT_MS } from "../src/turso-adapter";
import type {
  PostgresFullResult,
  PostgresHttpConnection,
} from "../src/postgres-adapter";

const statements: PortableSqlStatement[] = [
  { sql: "SELECT ?1", args: [1] },
  { sql: "UPDATE example SET value = ?1", args: [2] },
];

describe("checkout SQL transport", () => {
  it("keeps D1 commits in one native atomic batch", async () => {
    const bound = vi.fn();
    const prepare = vi.fn((sql: string) => ({
      bind: (...args: readonly unknown[]) => {
        const statement = { sql, args };
        bound(statement);
        return statement;
      },
    }));
    const batch = vi.fn(async () => []);
    const transport = createCheckoutSqlTransport({
      DATABASE_PROVIDER: "d1",
      DB: { prepare, batch } as unknown as D1Database,
    });

    await transport.atomic(statements);

    expect(transport.provider).toBe("d1");
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toEqual([
      { sql: "SELECT ?1", args: [1] },
      { sql: "UPDATE example SET value = ?1", args: [2] },
    ]);
  });

  it("uses one concurrent Turso transaction and independent slot sessions", async () => {
    const connections: Array<{
      batch: ReturnType<typeof vi.fn>;
      all: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    const connectTurso = vi.fn(() => {
      const connection = {
        batch: vi.fn(async () => []),
        all: vi.fn(async () => [{ value: 1 }]),
        get: vi.fn(async () => ({ value: 1 })),
        close: vi.fn(),
      };
      connections.push(connection);
      return connection as unknown as Connection;
    });
    const transport = createCheckoutSqlTransport({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "turso://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    }, { connectTurso });

    await transport.atomic(statements, 0);
    await transport.atomic(statements, 1);
    await transport.all<{ value: number }>(statements[0]!, 1);
    transport.close();

    expect(transport.provider).toBe("turso");
    expect(connectTurso).toHaveBeenCalledTimes(2);
    expect(connectTurso).toHaveBeenCalledWith(expect.objectContaining({
      defaultQueryTimeout: TURSO_DEFAULT_QUERY_TIMEOUT_MS,
    }));
    expect(connections[0]!.batch).toHaveBeenCalledWith([
      { sql: "SELECT ?1", args: [1] },
      { sql: "UPDATE example SET value = ?1", args: [2] },
    ], { mode: "concurrent", raw: true });
    expect(connections[1]!.all).toHaveBeenCalledWith("SELECT ?1", 1);
    expect(connections.every((connection) => connection.close.mock.calls.length === 1)).toBe(true);
  });

  it("keeps legacy libSQL checkout batches on the compatible immediate mode", async () => {
    const connections: Array<{ batch: ReturnType<typeof vi.fn> }> = [];
    const transport = createCheckoutSqlTransport({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    }, {
      connectTurso: (() => {
        const connection = {
          all: vi.fn(),
          get: vi.fn(),
          batch: vi.fn(async () => []),
          close: vi.fn(),
        };
        connections.push(connection);
        return connection;
      }) as never,
    });

    await transport.atomic([{ sql: "INSERT INTO orders (id) VALUES (?)", args: ["order_1"] }]);

    expect(connections[0]?.batch).toHaveBeenCalledWith([
      { sql: "INSERT INTO orders (id) VALUES (?)", args: ["order_1"] },
    ], { mode: "immediate", raw: true });
  });

  it("retries a conflicted Turso checkout transaction as one whole batch", async () => {
    const conflict = Object.assign(new Error("transaction conflict"), {
      code: "SQLITE_BUSY_SNAPSHOT",
    });
    const batch = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce([]);
    const transport = createCheckoutSqlTransport({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "turso://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    }, {
      connectTurso: (() => ({
        all: vi.fn(),
        get: vi.fn(),
        batch,
        close: vi.fn(),
      })) as never,
    });

    await transport.atomic(statements);

    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenNthCalledWith(1, [
      { sql: "SELECT ?1", args: [1] },
      { sql: "UPDATE example SET value = ?1", args: [2] },
    ], { mode: "concurrent", raw: true });
    expect(batch).toHaveBeenNthCalledWith(2, expect.any(Array), {
      mode: "concurrent",
      raw: true,
    });
  });

  it("uses one read-committed Neon HTTP transaction with provider-owned limits", async () => {
    const emptyResult: PostgresFullResult = { rows: [], fields: [] };
    const query = vi.fn(() => Promise.resolve(emptyResult));
    const transaction = vi.fn(async (queries: PromiseLike<PostgresFullResult>[]) =>
      await Promise.all(queries)
    );
    const connection = { query, transaction } as unknown as PostgresHttpConnection;
    const connectPostgres = vi.fn(() => connection);
    const transport = createCheckoutSqlTransport({
      POSTGRES_DATABASE_URL: "postgresql://user:secret@example.neon.tech/merchant",
    }, { connectPostgres });

    await transport.atomic(statements);

    expect(transport.provider).toBe("postgres");
    expect(transport.checkoutBatchLimits).toEqual({
      maxOrders: 1_000,
      maxJsonBytes: 8_000_000,
      targetOrders: 500,
      targetJsonBytes: 5_000_000,
    });
    expect(query.mock.calls.map(([sql, args]) => ({ sql, args }))).toEqual([
      { sql: "SELECT $1", args: [1] },
      { sql: "UPDATE example SET value = $1", args: [2] },
    ]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "ReadCommitted",
      readOnly: false,
    });
  });

  it("runs the collapsed PostgreSQL checkout authority in one serializable transaction", async () => {
    const emptyResult: PostgresFullResult = { rows: [], fields: [] };
    const query = vi.fn(() => Promise.resolve(emptyResult));
    const transaction = vi.fn(async (queries: PromiseLike<PostgresFullResult>[]) =>
      await Promise.all(queries)
    );
    const transport = createCheckoutSqlTransport({
      POSTGRES_DATABASE_URL: "postgresql://user:secret@example.neon.tech/merchant",
    }, {
      connectPostgres: () => ({ query, transaction }),
    });
    const edgePayload = "[]";
    await transport.atomic([
      {
        purpose: "checkout-commit-validate",
        sql: "SELECT ?1, ?2",
        args: [edgePayload, 1],
      },
      {
        purpose: "checkout-commit-orders",
        sql: "SELECT ?1",
        args: ["orders"],
      },
      {
        purpose: "checkout-commit-lanes",
        sql: "SELECT ?1",
        args: [edgePayload],
      },
      {
        purpose: "checkout-commit-postcondition",
        sql: "SELECT ?1",
        args: [edgePayload],
      },
      {
        purpose: "checkout-commit-outbox",
        sql: "SELECT ?1, ?2",
        args: ["outbox", "order-ids"],
      },
    ]);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      "SELECT scalius_compat.checkout_commit_v1($1::jsonb, $2, $3::jsonb, $4, $5)",
      [edgePayload, 1, "orders", "outbox", "order-ids"],
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "Serializable",
      readOnly: false,
    });
  });
});
