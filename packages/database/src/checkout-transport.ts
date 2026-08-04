import {
  connect,
  type Connection,
} from "@tursodatabase/serverless";

import type { CheckoutCommitLimits, PortableSqlStatement } from "./checkout-commit";
import {
  connectNeonPostgres,
  connectNativePostgres,
  isPostgresSerializationError,
  type PostgresFullResult,
  type PostgresHttpConnection,
} from "./postgres-adapter";
import {
  compileSqliteStatementForPostgres,
  normalizePostgresParameters,
  normalizePostgresResultObjects,
} from "./postgres-sqlite-profile";
import {
  POSTGRES_CHECKOUT_COMMIT_FUNCTION,
  readPostgresCheckoutCommitArguments,
} from "./postgres-checkout";
import {
  resolveDatabaseConfiguration,
  type DatabaseEnvironment,
  type DatabaseProvider,
} from "./provider";
import {
  retryTursoConflicts,
  TURSO_DEFAULT_QUERY_TIMEOUT_MS,
} from "./turso-adapter";

export interface CheckoutSqlTransport {
  readonly provider: DatabaseProvider;
  readonly checkoutBatchLimits?: CheckoutCommitLimits & {
    targetOrders: number;
    targetJsonBytes: number;
  };
  all<T>(
    statement: PortableSqlStatement,
    slot?: number,
  ): Promise<T[]>;
  get<T>(
    statement: PortableSqlStatement,
    slot?: number,
  ): Promise<T | null>;
  atomic(
    statements: readonly PortableSqlStatement[],
    slot?: number,
  ): Promise<void>;
  close(): void;
}

export interface CheckoutSqlTransportOptions {
  connectTurso?: typeof connect;
  connectPostgres?: (connectionString: string) => PostgresHttpConnection;
  connectNativePostgres?: (connectionString: string) => PostgresHttpConnection;
}

function postgresRows<T>(result: PostgresFullResult): T[] {
  return normalizePostgresResultObjects(
    result.rows,
    result.fields.map((field, index) => ({
      name: field.name ?? `column_${index}`,
      dataTypeID: field.dataTypeID,
    })),
  ) as T[];
}

async function retryPostgresCheckout<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isPostgresSerializationError(error) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Raw, bound SQL transport reserved for the compact checkout kernel. Domain
 * reads and ordinary writes continue through Drizzle. Keeping this provider
 * switch here prevents D1/Turso branches from leaking into checkout logic.
 */
export function createCheckoutSqlTransport(
  environment: DatabaseEnvironment,
  options: CheckoutSqlTransportOptions = {},
): CheckoutSqlTransport {
  const configuration = resolveDatabaseConfiguration(environment);

  if (configuration.provider === "d1") {
    const binding = configuration.binding;
    return {
      provider: "d1",
      async all<T>(statement: PortableSqlStatement) {
        const result = await binding
          .prepare(statement.sql)
          .bind(...statement.args)
          .all<T>();
        return result.results;
      },
      async get<T>(statement: PortableSqlStatement) {
        return await binding
          .prepare(statement.sql)
          .bind(...statement.args)
          .first<T>();
      },
      async atomic(statements: readonly PortableSqlStatement[]) {
        await binding.batch(statements.map((statement) =>
          binding.prepare(statement.sql).bind(...statement.args)
        ));
      },
      close() {
        // D1 bindings are Worker-owned and have no client lifecycle.
      },
    };
  }

  if (configuration.provider === "postgres") {
    const connection = configuration.transport === "neon-http"
      ? (options.connectPostgres ?? connectNeonPostgres)(configuration.connectionString)
      : (options.connectNativePostgres ?? connectNativePostgres)(configuration.connectionString);
    const compile = (statement: PortableSqlStatement) => ({
      query: compileSqliteStatementForPostgres(
        statement.sql,
        statement.args.length,
      ),
      args: normalizePostgresParameters(statement.args),
    });
    return {
      provider: "postgres",
      checkoutBatchLimits: {
        maxOrders: 1_000,
        maxJsonBytes: 8_000_000,
        targetOrders: 500,
        targetJsonBytes: 5_000_000,
      },
      async all<T>(statement: PortableSqlStatement) {
        const prepared = compile(statement);
        return postgresRows<T>(await connection.query(prepared.query.sql, prepared.args));
      },
      async get<T>(statement: PortableSqlStatement) {
        return (await this.all<T>(statement))[0] ?? null;
      },
      async atomic(statements: readonly PortableSqlStatement[]) {
        const checkoutCommit = readPostgresCheckoutCommitArguments(statements);
        if (checkoutCommit) {
          await retryPostgresCheckout(async () => {
            const results = await connection.transaction([connection.query(
              `SELECT ${POSTGRES_CHECKOUT_COMMIT_FUNCTION}($1::jsonb, $2, $3::jsonb, $4, $5)`,
              normalizePostgresParameters([
                checkoutCommit.edgePayload,
                checkoutCommit.authorityRevision,
                checkoutCommit.orderPayload,
                checkoutCommit.outboxId,
                checkoutCommit.orderIds,
              ]),
            )], {
              arrayMode: true,
              fullResults: true,
              isolationLevel: "Serializable",
              readOnly: false,
            });
            if (results.length !== 1) {
              throw new Error("PostgreSQL returned an unexpected checkout result count.");
            }
          });
          return;
        }
        const prepared = statements.map(compile);
        await retryPostgresCheckout(() => connection.transaction(
          prepared.map(({ query, args }) => connection.query(query.sql, args)),
          {
            arrayMode: true,
            fullResults: true,
            isolationLevel: "ReadCommitted",
            readOnly: false,
          },
        ));
      },
      close() {
        // Neon HTTP is stateless.
      },
    };
  }

  const connections: Array<Connection | undefined> = [];
  const connectTurso = options.connectTurso ?? connect;
  const connectionFor = (slot = 0): Connection => {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > 15) {
      throw new Error("Checkout SQL transport slot must be an integer between 0 and 15.");
    }
    connections[slot] ??= connectTurso({
      url: configuration.url,
      authToken: configuration.authToken,
      defaultQueryTimeout: TURSO_DEFAULT_QUERY_TIMEOUT_MS,
    });
    return connections[slot]!;
  };

  return {
    provider: "turso",
    async all<T>(
      statement: PortableSqlStatement,
      slot = 0,
    ) {
      return await connectionFor(slot).all(
        statement.sql,
        ...statement.args,
      ) as T[];
    },
    async get<T>(
      statement: PortableSqlStatement,
      slot = 0,
    ) {
      return await connectionFor(slot).get(
        statement.sql,
        ...statement.args,
      ) as T | null;
    },
    async atomic(statements: readonly PortableSqlStatement[], slot = 0) {
      const connection = connectionFor(slot);
      const batch = statements.map((statement) => ({
        sql: statement.sql,
        args: [...statement.args],
      }));
      await retryTursoConflicts(
        () => connection.batch(
          batch,
          { mode: configuration.writeBatchMode, raw: true },
        ),
      );
    },
    close() {
      for (const connection of connections) connection?.close();
      connections.length = 0;
    },
  };
}
