import { randomUUID } from "node:crypto";
import {
  connect,
  type Connection,
  type SQLInputValue,
} from "@tursodatabase/serverless";
import { pathToFileURL } from "node:url";

import { assertDisposableDatabaseTarget } from "./live-checkout-load-core";

type QueryRow = Record<string, unknown>;

interface ProbeOptions {
  databaseUrl: string;
  databaseToken: string;
  acknowledgedDatabaseHostname: string;
  targetId: string;
  acknowledgedTargetId: string;
  transactions: number;
  statementsPerTransaction: number;
  shards: number;
  mode: "autocommit" | "concurrent" | "immediate";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function readOptions(): ProbeOptions {
  const mode = (process.env.LOADTEST_PROBE_MODE?.trim() || "concurrent").toLowerCase();
  if (!(["autocommit", "concurrent", "immediate"] as const).includes(
    mode as "autocommit" | "concurrent" | "immediate",
  )) {
    throw new Error("LOADTEST_PROBE_MODE must be autocommit, concurrent, or immediate.");
  }
  return {
    databaseUrl: requiredEnvironment("TURSO_DATABASE_URL"),
    databaseToken: requiredEnvironment("TURSO_AUTH_TOKEN"),
    acknowledgedDatabaseHostname: requiredEnvironment(
      "LOADTEST_ACK_DATABASE_HOST",
    ),
    targetId: requiredEnvironment("LOADTEST_TARGET_ID"),
    acknowledgedTargetId: requiredEnvironment("LOADTEST_ACK_TARGET_ID"),
    transactions: boundedInteger("LOADTEST_PROBE_TRANSACTIONS", 32, 1, 200),
    statementsPerTransaction: boundedInteger(
      "LOADTEST_PROBE_STATEMENTS",
      2,
      1,
      50,
    ),
    shards: boundedInteger("LOADTEST_PROBE_SHARDS", 1, 1, 128),
    mode: mode as ProbeOptions["mode"],
  };
}

async function query(
  connection: Connection,
  sql: string,
  args: readonly SQLInputValue[] = [],
): Promise<QueryRow[]> {
  const statement = await connection.prepare(sql);
  return await statement.all([...args]) as QueryRow[];
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0);
}

function safeFailure(error: unknown): { errorName: string; code?: string } {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as Error & { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ? { code }
      : {}),
  };
}

export async function runTursoConcurrencyProbe(
  options: ProbeOptions,
): Promise<Record<string, unknown>> {
  const authority = connect({
    url: options.databaseUrl,
    authToken: options.databaseToken,
  });
  const connections: Connection[] = [];
  try {
    const identity = assertDisposableDatabaseTarget({
      databaseUrl: options.databaseUrl,
      acknowledgedDatabaseHostname: options.acknowledgedDatabaseHostname,
      expectedTargetId: options.targetId,
      acknowledgedTargetId: options.acknowledgedTargetId,
      sentinelRows: await query(
        authority,
        `SELECT target_id, purpose, database_hostname, fixture_namespace
           FROM scalius_loadtest_target`,
      ),
    });
    const tableNames = Array.from(
      { length: options.shards },
      (_, shard) => `scalius_turso_concurrency_probe_${String(shard).padStart(3, "0")}`,
    );
    await authority.exec(tableNames.map((tableName) => `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        transaction_index INTEGER NOT NULL,
        statement_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).join(";"));

    const runId = `probe_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    for (let index = 0; index < options.transactions; index += 1) {
      connections.push(connect({
        url: options.databaseUrl,
        authToken: options.databaseToken,
      }));
    }
    // Establish every independent SQL-over-HTTP session before the barrier so
    // connection setup is not mistaken for transaction serialization.
    await Promise.all(connections.map((connection) => connection.get("SELECT 1")));

    const startedAt = performance.now();
    const results = await Promise.all(connections.map(async (connection, transactionIndex) => {
      const transactionStartedAt = performance.now();
      const tableName = tableNames[transactionIndex % tableNames.length]!;
      try {
        await connection.batch(
          Array.from({ length: options.statementsPerTransaction }, (_, statementIndex) => ({
            sql: `INSERT INTO ${tableName}
                    (id, run_id, transaction_index, statement_index, created_at)
                  VALUES (?, ?, ?, ?, unixepoch())`,
            args: [
              `${runId}_${transactionIndex}_${statementIndex}`,
              runId,
              transactionIndex,
              statementIndex,
            ],
          })),
          options.mode === "autocommit"
            ? { raw: true }
            : { mode: options.mode, raw: true },
        );
        return {
          success: true as const,
          durationMs: performance.now() - transactionStartedAt,
        };
      } catch (error) {
        return {
          success: false as const,
          durationMs: performance.now() - transactionStartedAt,
          ...safeFailure(error),
        };
      }
    }));
    const elapsedMs = performance.now() - startedAt;
    const rowCount = (await Promise.all(tableNames.map(async (tableName, index) =>
      Number((await connections[index % connections.length]!.get(
        `SELECT COUNT(*) AS count FROM ${tableName} WHERE run_id = ?`,
        runId,
      ))?.count ?? -1)
    ))).reduce((total, count) => total + count, 0);
    const successes = results.filter((result) => result.success).length;
    const durations = results.map((result) => result.durationMs);
    const expectedRows = successes * options.statementsPerTransaction;

    return {
      targetId: identity.targetId,
      databaseHostname: identity.databaseHostname,
      journalMode: String((await authority.get("PRAGMA journal_mode"))?.journal_mode ?? ""),
      transactions: options.transactions,
      statementsPerTransaction: options.statementsPerTransaction,
      shards: options.shards,
      mode: options.mode,
      successes,
      failures: results.length - successes,
      failureClasses: Object.fromEntries(
        [...new Set(results.filter((result) => !result.success).map((result) =>
          result.code ?? result.errorName
        ))].map((failureClass) => [
          failureClass,
          results.filter((result) =>
            !result.success && (result.code ?? result.errorName) === failureClass
          ).length,
        ]),
      ),
      elapsedMs: Math.round(elapsedMs),
      achievedTransactionsPerSecond: Number(
        (options.transactions * 1_000 / elapsedMs).toFixed(2),
      ),
      latencyMs: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
        max: Math.round(Math.max(...durations)),
      },
      rowCount,
      expectedRows,
      exact: rowCount === expectedRows,
    };
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    authority.close();
  }
}

async function main(): Promise<void> {
  const result = await runTursoConcurrencyProbe(readOptions());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failures !== 0 || result.exact !== true) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
