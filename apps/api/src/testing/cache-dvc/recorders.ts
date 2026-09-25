/**
 * How the harness learns what a render depends on.
 *
 * - `headerDependencies` reads the internal part headers S4 emits
 *   (`X-Scalius-Deps`, `X-Scalius-Dep-Seq`, `X-Scalius-Valid-Until`,
 *   `X-Scalius-Soft-Max-Age`). When a response carries them, they win.
 * - A `DependencyRecorder` wraps the render: S2's `withDependencyScope`
 *   (see harness-adapters.ts), or `coarseTableRecorder`, the stand-in used
 *   until S2 lands: every registered table the render read becomes its `t:`
 *   key, soft exempt tables bound the entry's age, an unregistered table
 *   makes the entry uncacheable, and scheduled columns give `validUntil`.
 *   It is correct by construction if the registry and triggers are, so the
 *   harness proves the registry (noise columns, exemptions, schedules) even
 *   before precise declarations exist.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  CACHE_DEP_SOFT_MAX_AGE_SECONDS,
  cacheDep,
  cacheDepExemptReason,
  isCacheDepTable,
} from "@scalius/shared/cache-deps";
import type { SchemaModel } from "./schema-model";

export interface RecordedDependencies {
  readonly deps: readonly string[];
  readonly validUntil: number | null;
  readonly softMaxAgeSeconds: number | null;
  readonly uncacheable: readonly string[];
  /** Clock value the render itself read first (S4/S2), when it reports one. */
  readonly s0?: number;
}

export interface DependencyRecorder {
  readonly name: string;
  /**
   * Run `render` and say what it depends on. `observed` is the harness's own
   * capture of every table the render's statements named (filled while the
   * render runs, complete when it resolves).
   */
  record(label: string, render: () => Promise<Response>, observed: ReadonlySet<string>): Promise<{ response: Response; dependencies: RecordedDependencies }>;
}

/** Exempt tables whose only effect is soft ordering (owner decision 4). */
export const SOFT_TABLES: ReadonlySet<string> = new Set([
  "product_recommendations",
  "product_sales_stats",
  "orders",
  "order_items",
]);

const SCHEDULE_COLUMN = /^(?:starts|ends|published|expires|valid|available)_(?:at|until|from)$/;

export function coarseTableRecorder(sqlite: DatabaseSync, model: SchemaModel, now: () => number): DependencyRecorder {
  return {
    name: "coarse-tables",
    async record(_label, render, observed) {
      const response = await render();
      const deps = new Set<string>([cacheDep.store()]);
      const uncacheable: string[] = [];
      let soft = false;
      let validUntil: number | null = null;
      for (const table of observed) {
        if (isCacheDepTable(table)) {
          deps.add(cacheDep.table(table));
        } else if (cacheDepExemptReason(table) !== null) {
          if (SOFT_TABLES.has(table)) soft = true;
        } else if (model.has(table)) {
          uncacheable.push(`unregistered-table:${table}`);
        }
        const columns = model.get(table)?.columns.filter((column) => SCHEDULE_COLUMN.test(column.name)) ?? [];
        for (const column of columns) {
          const nowSeconds = Math.floor(now() / 1000);
          const row = sqlite.prepare(
            `SELECT min("${column.name}") AS next FROM "${table}" WHERE "${column.name}" > ?`,
          ).get(nowSeconds) as { next: number | null };
          if (row.next !== null) {
            const at = Number(row.next) * 1000;
            validUntil = validUntil === null ? at : Math.min(validUntil, at);
          }
        }
      }
      return {
        response,
        dependencies: {
          deps: [...deps].sort(),
          validUntil,
          softMaxAgeSeconds: soft ? CACHE_DEP_SOFT_MAX_AGE_SECONDS : null,
          uncacheable,
        },
      };
    },
  };
}

/** S4's internal part headers, when present. */
export function headerDependencies(response: Response): RecordedDependencies | null {
  const deps = response.headers.get("X-Scalius-Deps");
  if (deps === null) return null;
  const number = (name: string) => {
    const value = response.headers.get(name);
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const validUntil = number("X-Scalius-Valid-Until");
  const s0 = number("X-Scalius-Dep-Seq");
  return {
    deps: deps.split(/[\s,]+/).filter(Boolean),
    // Seconds or milliseconds: normalise to ms.
    validUntil: validUntil === null ? null : validUntil < 1e12 ? validUntil * 1000 : validUntil,
    softMaxAgeSeconds: number("X-Scalius-Soft-Max-Age"),
    uncacheable: response.headers.get("X-Scalius-Uncacheable")?.split(/[\s,]+/).filter(Boolean) ?? [],
    ...(s0 === null ? {} : { s0 }),
  };
}
