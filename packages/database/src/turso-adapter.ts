import {
  connect,
  type BatchStatement,
  type Config as TursoConnectionConfig,
} from "@tursodatabase/serverless";
import {
  drizzle as drizzleRemote,
  type AsyncBatchRemoteCallback,
  type AsyncRemoteCallback,
} from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";
import type { Database } from "./types";

const DEFAULT_CONFLICT_ATTEMPTS = 8;
const CONFLICT_RETRY_BASE_DELAY_MS = 2;

interface TursoBatchResult {
  rows?: unknown[];
  rowsAffected?: number;
}

export interface TursoConnection {
  batch(
    statements: BatchStatement[],
    options?: { mode?: string; raw?: boolean },
  ): Promise<TursoBatchResult[]>;
}

export interface TursoAdapterOptions {
  connect?: (config: TursoConnectionConfig) => TursoConnection;
  maxConflictAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

function tursoErrorDescription(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isTursoSqlInputError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "SQL_INPUT_ERROR" || (
    typeof candidate.message === "string" &&
    /(?:parse error|ambiguous column|sql input)/i.test(candidate.message)
  );
}

async function findRejectedBatchStatement(
  connection: TursoConnection,
  statements: BatchStatement[],
): Promise<{ index: number; error: unknown } | null> {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    try {
      // EXPLAIN parses the statement and every trigger it can invoke without
      // executing application writes or exposing bound values in diagnostics.
      const explainStatement: BatchStatement = typeof statement === "string"
        ? `EXPLAIN ${statement}`
        : { sql: `EXPLAIN ${statement.sql}`, args: statement.args };
      await connection.batch(
        [explainStatement],
        { raw: true },
      );
    } catch (error) {
      return { index, error };
    }
  }
  return null;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isTursoConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    message?: unknown;
    code?: unknown;
    extendedCode?: unknown;
    cause?: unknown;
  };
  const description = [candidate.message, candidate.code, candidate.extendedCode]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (description.includes("conflict") || description.includes("busy")) {
    return true;
  }

  return candidate.cause !== undefined && isTursoConflictError(candidate.cause);
}

async function withTursoConflictRetry<T>(
  operation: () => Promise<T>,
  options: Required<
    Pick<TursoAdapterOptions, "maxConflictAttempts" | "sleep" | "random">
  >,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < options.maxConflictAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTursoConflictError(error) || attempt + 1 >= options.maxConflictAttempts) {
        throw error;
      }

      const exponentialDelay = CONFLICT_RETRY_BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.floor(options.random() * exponentialDelay);
      await options.sleep(exponentialDelay + jitter);
    }
  }

  throw lastError;
}

function requireSingleResult(results: TursoBatchResult[]): TursoBatchResult {
  const result = results[0];
  if (!result || results.length !== 1) {
    throw new Error("Turso returned an unexpected result count for one statement.");
  }
  return result;
}

/**
 * Adapt the stable fetch-only Turso client to Drizzle's stable remote SQLite
 * driver. Single statements stay one HTTP request. Drizzle batches become one
 * atomic BEGIN CONCURRENT request and retry only explicit MVCC busy/conflict
 * failures.
 */
export function createTursoDatabase(
  config: TursoConnectionConfig,
  options: TursoAdapterOptions = {},
): Database {
  const connectToTurso: (config: TursoConnectionConfig) => TursoConnection =
    options.connect ?? connect;
  const connection: TursoConnection = connectToTurso(config);
  const retryOptions = {
    maxConflictAttempts: options.maxConflictAttempts ?? DEFAULT_CONFLICT_ATTEMPTS,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
  };

  if (!Number.isSafeInteger(retryOptions.maxConflictAttempts) || retryOptions.maxConflictAttempts < 1) {
    throw new Error("Turso maxConflictAttempts must be a positive safe integer.");
  }

  const executeOne: AsyncRemoteCallback = async (sql, params, method) => {
    const result = requireSingleResult(
      await withTursoConflictRetry(
        () => connection.batch([{ sql, args: params }], { raw: true }),
        retryOptions,
      ),
    );
    const rows = result.rows ?? [];

    if (method === "get") {
      return { rows: rows[0] as never };
    }
    if (method === "run") {
      return {
        rows: [],
        changes: result.rowsAffected ?? 0,
        meta: { changes: result.rowsAffected ?? 0 },
      };
    }
    return { rows };
  };

  const executeBatch: AsyncBatchRemoteCallback = async (statements) => {
    const batchStatements = statements.map(({ sql, params }) => ({
      sql,
      args: params,
    }));
    let results: TursoBatchResult[];
    try {
      results = await withTursoConflictRetry(
        () => connection.batch(
          batchStatements,
          { mode: "concurrent", raw: true },
        ),
        retryOptions,
      );
    } catch (error) {
      if (isTursoSqlInputError(error)) {
        const rejected = await findRejectedBatchStatement(connection, batchStatements);
        if (rejected) {
          throw new Error(
            `Turso rejected atomic batch statement ${rejected.index + 1}: ${tursoErrorDescription(rejected.error)}`,
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (results.length !== statements.length) {
      throw new Error("Turso returned an unexpected result count for an atomic batch.");
    }

    return results.map((result) => ({
      rows: result.rows ?? [],
      changes: result.rowsAffected ?? 0,
      meta: { changes: result.rowsAffected ?? 0 },
    }));
  };

  // Database intentionally exposes the common SQLite query surface currently
  // shaped by the D1 type. This is the only transport cast in the application.
  return drizzleRemote(executeOne, executeBatch, { schema }) as unknown as Database;
}
