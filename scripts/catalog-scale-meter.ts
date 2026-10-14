/**
 * D1 metering shared by the catalogue-scale harnesses (catalog-scale-profile.test.ts, scale-proof.test.ts):
 * wraps a Miniflare D1 binding so every statement's `meta.rows_read` and `meta.rows_written` (D1's own row
 * accounting, index entries included) and the dependent waves of a request are recorded.
 */

export interface StatementSample {
  sql: string;
  fullSql?: string;
  args?: unknown[];
  ms: number;
  rowsRead: number;
  /** D1 `meta.rows_written`: index entries included, the figure D1 bills. */
  rowsWritten: number;
  rows: number;
}

export interface Meter {
  binding: D1Database;
  statements: StatementSample[];
  waves: number;
  metering: boolean;
}

export function metered(inner: D1Database): Meter {
  const meter: Meter = { binding: inner, statements: [], waves: 0, metering: false };
  let queued: Array<() => void> = [];
  const wave = <T>(work: () => Promise<T>): Promise<T> => new Promise<T>((resolveWork, reject) => {
    queued.push(() => void work().then(resolveWork, (error: unknown) => {
      console.error(`[d1] ${error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error)}`);
      reject(error);
    }));
    if (queued.length === 1) {
      setTimeout(() => {
        meter.waves += 1;
        const run = queued;
        queued = [];
        for (const start of run) start();
      }, 0);
    }
  });
  const record = (sql: string, result: { meta?: { rows_read?: number; rows_written?: number; duration?: number }; results?: unknown[] } | null, args?: unknown[]) => {
    meter.statements.push({
      sql: sql.replace(/\s+/g, " ").slice(0, 400),
      ...(process.env.CATALOG_SCALE_FULL_SQL ? { fullSql: sql, args } : {}),
      ms: result?.meta?.duration ?? 0,
      rowsRead: result?.meta?.rows_read ?? 0,
      rowsWritten: result?.meta?.rows_written ?? 0,
      rows: result?.results?.length ?? 0,
    });
  };
  const sqlOf = new WeakMap<object, { sql: string; args?: unknown[] }>();
  const wrap = (statement: D1PreparedStatement, sql: string, args?: unknown[]): D1PreparedStatement => {
    const wrapped = wrapStatement(statement, sql, args);
    sqlOf.set(wrapped, { sql, args });
    return wrapped;
  };
  const wrapStatement = (statement: D1PreparedStatement, sql: string, args?: unknown[]): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...bound: unknown[]) => wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(target, bound), sql, bound);
      }
      if (property === "all" || property === "run") {
        return () => wave(async () => {
          const result = await (value as () => Promise<D1Result>).apply(target);
          record(sql, result as never, args);
          return result;
        });
      }
      if (property === "raw" || property === "first") {
        return (...callArgs: unknown[]) => wave(async () => {
          if (meter.metering) {
            // raw()/first() drop meta: re-run once through all() to meter it.
            try {
              record(sql, await target.all() as never, args);
            } catch (error) {
              meter.statements.push({ sql: `[failed: ${error instanceof Error ? error.message : String(error)}] ${sql.replace(/\s+/g, " ").slice(0, 300)}`, fullSql: sql, args, ms: -1, rowsRead: -1, rowsWritten: 0, rows: 0 });
              throw error;
            }
          } else {
            meter.statements.push({ sql: sql.replace(/\s+/g, " ").slice(0, 400), ms: 0, rowsRead: 0, rowsWritten: 0, rows: 0 });
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, callArgs);
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // getDb() opens a D1 session per request (withSession), so the session is
  // metered too, not only the bare binding.
  const wrapDatabase = <T extends object>(database: T): T => new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          return wrap((target as unknown as D1Database).prepare(query), query);
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => wave(async () => {
          const results = await (target as unknown as D1Database).batch(statements);
          results.forEach((result, index) => {
            const source = sqlOf.get(statements[index]);
            record(`[batch ${index + 1}/${statements.length}] ${source?.sql ?? "?"}`, result as never, source?.args);
          });
          return results;
        });
      }
      if (property === "withSession") {
        return (...args: unknown[]) => wrapDatabase((target as unknown as { withSession: (...a: unknown[]) => object }).withSession(...args));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = wrapDatabase(inner);
  return meter;
}

export const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

