import {
  drizzle as drizzleRemote,
  type AsyncBatchRemoteCallback,
  type AsyncRemoteCallback,
} from "drizzle-orm/sqlite-proxy";
import { neon } from "@neondatabase/serverless";

import * as schema from "./schema";
import {
  compileSqliteStatementForPostgres,
  normalizePostgresParameters,
  normalizePostgresResultRows,
} from "./postgres-sqlite-profile";
import type { Database } from "./types";

const DEFAULT_SERIALIZATION_ATTEMPTS = 8;
const SERIALIZATION_RETRY_BASE_DELAY_MS = 2;

type QueryMethod = "run" | "all" | "values" | "get";

export interface PostgresResultField {
  name?: string;
  dataTypeID: number;
}

export interface PostgresFullResult {
  rows: unknown[][];
  fields: PostgresResultField[];
}

export type PostgresQuery = PromiseLike<PostgresFullResult>;

export interface PostgresHttpConnection {
  query(
    sql: string,
    params: readonly unknown[],
  ): PostgresQuery;
  transaction(
    queries: PostgresQuery[],
    options: {
      arrayMode: true;
      fullResults: true;
      isolationLevel: "ReadCommitted" | "RepeatableRead" | "Serializable";
      readOnly: boolean;
    },
  ): Promise<PostgresFullResult[]>;
}

export function connectNeonPostgres(
  connectionString: string,
): PostgresHttpConnection {
  const sql = neon(connectionString, { arrayMode: true, fullResults: true });
  return {
    query(query, params) {
      return sql.query(query, [...params]) as unknown as PostgresQuery;
    },
    async transaction(queries, options) {
      return await sql.transaction(
        queries as never[],
        options,
      ) as unknown as PostgresFullResult[];
    },
  };
}

export interface PostgresAdapterOptions {
  connect: (connectionString: string) => PostgresHttpConnection;
  maxSerializationAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onSerializationRetry?: (retry: {
    attempt: number;
    delayMs: number;
    code: string;
  }) => void;
  onOperation?: (operation: {
    kind: "statement" | "batch";
    mode: "read" | "serializable";
    statementCount: number;
    durationMs: number;
    success: boolean;
  }) => void;
}

interface CompiledBatchStatement {
  sql: string;
  params: readonly unknown[];
  method: QueryMethod;
  readOnly: boolean;
  capturesChanges: boolean;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return candidate.cause === undefined ? null : postgresErrorCode(candidate.cause);
}

export function isPostgresSerializationError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === "40001" || code === "40P01";
}

async function withSerializationRetry<T>(
  operation: () => Promise<T>,
  options: Required<Pick<
    PostgresAdapterOptions,
    "maxSerializationAttempts" | "sleep" | "random"
  >> & Pick<PostgresAdapterOptions, "onSerializationRetry">,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maxSerializationAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code = postgresErrorCode(error);
      if (
        !isPostgresSerializationError(error)
        || !code
        || attempt + 1 >= options.maxSerializationAttempts
      ) {
        throw error;
      }
      const exponentialDelay = SERIALIZATION_RETRY_BASE_DELAY_MS * 2 ** attempt;
      const delayMs = exponentialDelay + Math.floor(options.random() * exponentialDelay);
      options.onSerializationRetry?.({ attempt: attempt + 1, delayMs, code });
      await options.sleep(delayMs);
    }
  }
  throw lastError;
}

function hasChangesCall(sql: string): boolean {
  return /\bchanges\s*\(/i.test(sql);
}

function wrapMutationToCaptureChanges(sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!/^(?:insert|update|delete)\b/i.test(statement)) {
    throw new Error("changes() must follow an INSERT, UPDATE, or DELETE statement.");
  }
  if (/\breturning\b/i.test(statement)) {
    throw new Error("changes() capture does not support a preceding RETURNING statement.");
  }
  return `WITH scalius_mutation AS (${statement} RETURNING 1), `
    + "scalius_change_count AS (SELECT count(*)::bigint AS value FROM scalius_mutation) "
    + "SELECT set_config('scalius.changes', value::text, true), "
    + "value AS __scalius_changes FROM scalius_change_count";
}

function compileBatchStatements(
  statements: Parameters<AsyncBatchRemoteCallback>[0],
): CompiledBatchStatement[] {
  const compiled: CompiledBatchStatement[] = statements.map(({ sql, params, method }) => {
    const statement = compileSqliteStatementForPostgres(sql, params.length);
    return {
      sql: statement.sql,
      params: normalizePostgresParameters(params),
      method,
      readOnly: statement.readOnly,
      capturesChanges: false,
    };
  });

  for (let index = 0; index < statements.length; index += 1) {
    if (!hasChangesCall(statements[index]!.sql)) continue;
    const previous = compiled[index - 1];
    if (!previous) throw new Error("changes() cannot be the first PostgreSQL batch statement.");
    previous.sql = wrapMutationToCaptureChanges(previous.sql);
    previous.readOnly = false;
    previous.capturesChanges = true;
  }
  return compiled;
}

function resultRows(result: PostgresFullResult): unknown[][] {
  return normalizePostgresResultRows(
    result.rows as unknown[][],
    result.fields,
  );
}

function remoteRows(
  result: PostgresFullResult,
  method: QueryMethod,
  capturesChanges = false,
): unknown {
  const rows = resultRows(result);
  if (capturesChanges || method === "run") return [];
  if (method === "get") return rows[0];
  return rows;
}

function remoteBatchRows(
  result: PostgresFullResult,
  method: QueryMethod,
  capturesChanges = false,
): unknown[][] {
  if (capturesChanges || method === "run") return [];
  return resultRows(result);
}

/**
 * Adapt Neon HTTP's one-shot PostgreSQL transactions to the common SQLite
 * Drizzle surface used by D1 and Turso. Every write is SERIALIZABLE and retries
 * only PostgreSQL serialization/deadlock failures. Read batches use one
 * repeatable-read snapshot.
 */
export function createPostgresDatabase(
  connectionString: string,
  options: PostgresAdapterOptions,
): Database {
  const connection = options.connect(connectionString);
  const retryOptions = {
    maxSerializationAttempts:
      options.maxSerializationAttempts ?? DEFAULT_SERIALIZATION_ATTEMPTS,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
    onSerializationRetry: options.onSerializationRetry,
  };
  if (
    !Number.isSafeInteger(retryOptions.maxSerializationAttempts)
    || retryOptions.maxSerializationAttempts < 1
  ) {
    throw new Error("PostgreSQL maxSerializationAttempts must be a positive safe integer.");
  }

  const observe = async <T>(
    kind: "statement" | "batch",
    mode: "read" | "serializable",
    statementCount: number,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (!options.onOperation) return operation();
    const startedAt = performance.now();
    let success = false;
    try {
      const result = await operation();
      success = true;
      return result;
    } finally {
      try {
        options.onOperation({
          kind,
          mode,
          statementCount,
          durationMs: Math.round(performance.now() - startedAt),
          success,
        });
      } catch {
        // Diagnostics must never change database behavior.
      }
    }
  };

  const executeOne: AsyncRemoteCallback = async (sql, params, method) => {
    const statement = compileSqliteStatementForPostgres(sql, params.length);
    const normalizedParams = normalizePostgresParameters(params);
    const mode = statement.readOnly ? "read" : "serializable";
    const execute = async (): Promise<PostgresFullResult> => {
      const query = connection.query(statement.sql, normalizedParams);
      if (statement.readOnly) return query;
      const results = await connection.transaction([query], {
        arrayMode: true,
        fullResults: true,
        isolationLevel: "Serializable",
        readOnly: false,
      });
      const result = results[0];
      if (!result || results.length !== 1) {
        throw new Error("PostgreSQL returned an unexpected result count.");
      }
      return result;
    };
    const result = await observe("statement", mode, 1, () =>
      statement.readOnly
        ? execute()
        : withSerializationRetry(execute, retryOptions));
    return { rows: remoteRows(result, method) as never };
  };

  const executeBatch: AsyncBatchRemoteCallback = async (statements) => {
    if (statements.length === 0) return [];
    const compiled = compileBatchStatements(statements);
    const readOnly = compiled.every((statement) => statement.readOnly);
    const execute = async (): Promise<PostgresFullResult[]> => connection.transaction(
      compiled.map((statement) => connection.query(statement.sql, statement.params)),
      {
        arrayMode: true,
        fullResults: true,
        isolationLevel: readOnly ? "RepeatableRead" : "Serializable",
        readOnly,
      },
    );
    const results = await observe(
      "batch",
      readOnly ? "read" : "serializable",
      statements.length,
      () => readOnly ? execute() : withSerializationRetry(execute, retryOptions),
    );
    if (results.length !== compiled.length) {
      throw new Error("PostgreSQL returned an unexpected atomic batch result count.");
    }
    return results.map((result, index) => ({
      rows: remoteBatchRows(
        result,
        compiled[index]!.method,
        compiled[index]!.capturesChanges,
      ),
    }));
  };

  // The application intentionally retains one SQLite-shaped query surface.
  // This is the only PostgreSQL transport cast in application code.
  return drizzleRemote(executeOne, executeBatch, { schema }) as unknown as Database;
}
