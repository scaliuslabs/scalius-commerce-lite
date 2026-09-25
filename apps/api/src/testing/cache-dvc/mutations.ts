/**
 * The row-mutation generator: random committed changes to any row of any
 * table, independent of the application's write sites. It proposes
 * schema-shaped values (enum members, flipped booleans, foreign keys to real
 * rows, shifted epochs, perturbed JSON documents, other rows' values) and
 * lets the database judge them: a CHECK, UNIQUE, FOREIGN KEY or trigger
 * refusal is retried with other values and counted, never ignored.
 *
 * Coverage is tracked per table and operation and per column, so a quick run
 * can assert that every registered table and column was actually changed.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Rng } from "./rng";
import type { ColumnModel, SchemaModel, TableModel } from "./schema-model";

export interface Mutation {
  readonly kind: "insert" | "update" | "delete";
  readonly table: string;
  readonly columns: readonly string[];
  readonly description: string;
}

export class MutationCoverage {
  readonly ops = new Map<string, number>();
  readonly columns = new Map<string, number>();
  readonly refusals = new Map<string, number>();

  record(mutation: Mutation): void {
    const op = `${mutation.table}:${mutation.kind}`;
    this.ops.set(op, (this.ops.get(op) ?? 0) + 1);
    if (mutation.kind === "update") {
      for (const column of mutation.columns) {
        const key = `${mutation.table}.${column}`;
        this.columns.set(key, (this.columns.get(key) ?? 0) + 1);
      }
    }
  }

  refused(table: string, reason: string): void {
    const key = `${table}: ${reason.replace(/'[^']*'/g, "'…'").slice(0, 120)}`;
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
  }

  /** Registered tables or columns never changed (the quick run requires none, bar the listed reasons). */
  gaps(model: SchemaModel): { ops: string[]; columns: string[] } {
    const ops: string[] = [];
    const columns: string[] = [];
    for (const table of model.values()) {
      if (!table.registered) continue;
      for (const kind of ["insert", "update", "delete"]) {
        if (!this.ops.has(`${table.name}:${kind}`)) ops.push(`${table.name}:${kind}`);
      }
      for (const column of table.columns) {
        if (column.pk > 0) continue;
        if (!this.columns.has(`${table.name}.${column.name}`)) columns.push(`${table.name}.${column.name}`);
      }
    }
    return { ops, columns };
  }
}

type Row = Record<string, SQLInputValue | null>;

const ID_PREFIXES = /^(p|cat|col|brd|media|page|art|menu|nav|promo|ov|opt|v|pmed|attr|atv|atg|loc|zone|ship|tax|rate|lang|an|hero|pcode|pcond|peff|pred|prc|pcb|pbd|pav|o|oi|cus)_/;
const UNIQUE_HINT = /slug|sku|handle|code|barcode|name|key|path|normalized|checksum|token|value|label|title|filename|object_key/;
const MAX_ATTEMPTS = 8;

export class RowMutator {
  private counter = 0;
  private idPool: Map<string, string[]> | null = null;

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly model: SchemaModel,
    private readonly rng: Rng,
    readonly coverage: MutationCoverage = new MutationCoverage(),
  ) {}

  /** Tables the generator may write, with a weight. */
  tableWeights(): Array<readonly [number, TableModel]> {
    const weights: Array<readonly [number, TableModel]> = [];
    for (const table of this.model.values()) {
      if (table.columns.length === 0) continue;
      const weight = table.registered
        ? 10
        : table.exemptReason !== null
          ? 1
          : 0.5;
      weights.push([weight, table]);
    }
    return weights;
  }

  /** One random committed change, or null when every attempt was refused. */
  random(): Mutation | null {
    const table = this.rng.weighted(this.tableWeights());
    const kind = this.rng.weighted<Mutation["kind"]>([[6, "update"], [2, "insert"], [1, "delete"]]);
    if (kind === "update") return this.update(table.name);
    if (kind === "insert") return this.insert(table.name);
    return this.delete(table.name);
  }

  private rows(table: string, limit = 200): Row[] {
    const order = this.model.get(table)!.withoutRowid
      ? this.model.get(table)!.pkColumns.map((column) => `"${column}"`).join(", ")
      : "rowid";
    return this.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY ${order} LIMIT ${limit}`).all() as Row[];
  }

  private pkWhere(table: TableModel, row: Row): { sql: string; values: SQLInputValue[] } {
    const columns = table.pkColumns.length > 0 ? table.pkColumns : table.columns.map((column) => column.name);
    return {
      sql: columns.map((column) => (row[column] === null ? `"${column}" IS NULL` : `"${column}" = ?`)).join(" AND "),
      values: columns.filter((column) => row[column] !== null).map((column) => row[column] as SQLInputValue),
    };
  }

  private run(sql: string, values: readonly SQLInputValue[]): number {
    return Number(this.sqlite.prepare(sql).run(...values).changes);
  }

  /** Update one row: one to three columns (or `column` alone when given). */
  update(tableName: string, column?: string, targetRow?: Row): Mutation | null {
    const table = this.model.get(tableName);
    if (!table) return null;
    const rows = targetRow ? [targetRow] : this.rows(tableName);
    if (rows.length === 0) return this.insert(tableName);
    const writable = table.columns.filter((each) => each.pk === 0 || table.pkColumns.length > 1);
    if (writable.length === 0) return null;
    let lastError = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const row = this.rng.pick(rows);
      const targets = column
        ? writable.filter((each) => each.name === column)
        : this.rng.sample(writable, this.rng.weighted([[6, 1], [2, 2], [1, 3]]));
      if (targets.length === 0) return null;
      const assignments: string[] = [];
      const values: SQLInputValue[] = [];
      const changed: string[] = [];
      for (const target of targets) {
        const value = this.proposeValue(table, target, row[target.name] ?? null, rows);
        if (value === undefined) continue;
        assignments.push(`"${target.name}" = ?`);
        values.push(value);
        changed.push(target.name);
      }
      if (assignments.length === 0) continue;
      const where = this.pkWhere(table, row);
      try {
        const changes = this.run(`UPDATE "${tableName}" SET ${assignments.join(", ")} WHERE ${where.sql}`, [...values, ...where.values]);
        if (changes === 0) continue;
        const mutation: Mutation = {
          kind: "update",
          table: tableName,
          columns: changed,
          description: `UPDATE ${tableName} SET ${changed.map((name, index) => `${name}=${preview(values[index])}`).join(", ")} WHERE ${describeRow(table, row)}`,
        };
        this.coverage.record(mutation);
        return mutation;
      } catch (error) {
        lastError = errorText(error);
        this.coverage.refused(tableName, lastError);
      }
    }
    void lastError;
    return null;
  }

  /** Insert a clone of an existing row with fresh identity. */
  insert(tableName: string): Mutation | null {
    const table = this.model.get(tableName);
    if (!table) return null;
    const rows = this.rows(tableName);
    if (rows.length === 0) return null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const source = { ...this.rng.pick(rows) };
      this.counter += 1;
      const suffix = `x${this.counter}`;
      for (const column of table.columns) {
        const value = source[column.name];
        if (column.pk > 0) {
          if (table.pkColumns.length === 1 && column.shape === "integer" && !column.references) {
            source[column.name] = null; // rowid alias: let SQLite assign it
          } else if (column.references) {
            const alternative = this.foreignValue(column);
            if (alternative !== undefined) source[column.name] = alternative;
          } else if (typeof value === "string") {
            source[column.name] = `${value}${suffix}`;
          } else if (typeof value === "number") {
            source[column.name] = value + 1000 + this.counter;
          }
        } else if (attempt > 0 && typeof value === "string" && UNIQUE_HINT.test(column.name) && !column.references
          && column.enumValues === null && column.shape !== "json" && !looksLikeJson(value)) {
          source[column.name] = uniqueVariant(value, suffix);
        }
      }
      const columns = table.columns.map((column) => column.name).filter((name) => source[name] !== null || !table.columns.find((each) => each.name === name)!.pk);
      const values = columns.map((name) => source[name] ?? null) as SQLInputValue[];
      try {
        this.run(`INSERT INTO "${tableName}" (${columns.map((name) => `"${name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, values);
        const mutation: Mutation = { kind: "insert", table: tableName, columns, description: `INSERT INTO ${tableName} clone ${describeRow(table, source)}` };
        this.coverage.record(mutation);
        this.idPool = null;
        return mutation;
      } catch (error) {
        this.coverage.refused(tableName, errorText(error));
      }
    }
    return null;
  }

  delete(tableName: string): Mutation | null {
    const table = this.model.get(tableName);
    if (!table) return null;
    const rows = this.rows(tableName);
    // Keep at least one row of each table so later updates have a target.
    if (rows.length <= 1) return this.insert(tableName);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const row = this.rng.pick(rows);
      const where = this.pkWhere(table, row);
      try {
        const changes = this.run(`DELETE FROM "${tableName}" WHERE ${where.sql}`, where.values);
        if (changes === 0) continue;
        const mutation: Mutation = { kind: "delete", table: tableName, columns: [], description: `DELETE FROM ${tableName} WHERE ${describeRow(table, row)}` };
        this.coverage.record(mutation);
        this.idPool = null;
        return mutation;
      } catch (error) {
        this.coverage.refused(tableName, errorText(error));
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Values

  private ids(): Map<string, string[]> {
    if (this.idPool) return this.idPool;
    const pool = new Map<string, string[]>();
    for (const table of this.model.values()) {
      if (!table.registered || table.pkColumns.length !== 1) continue;
      const pk = table.columns.find((column) => column.name === table.pkColumns[0])!;
      if (pk.shape !== "text") continue;
      const ids = (this.sqlite.prepare(`SELECT "${pk.name}" AS id FROM "${table.name}" LIMIT 200`).all() as Array<{ id: string }>).map((row) => row.id);
      for (const id of ids) {
        const prefix = /^([a-z]+)_/.exec(id)?.[1] ?? "";
        const list = pool.get(prefix) ?? [];
        list.push(id);
        pool.set(prefix, list);
      }
    }
    this.idPool = pool;
    return pool;
  }

  private foreignValue(column: ColumnModel): SQLInputValue | undefined {
    const reference = column.references!;
    const rows = this.sqlite.prepare(`SELECT "${reference.column}" AS v FROM "${reference.table}" LIMIT 200`).all() as Array<{ v: SQLInputValue }>;
    if (rows.length === 0) return column.notNull ? undefined : null;
    if (!column.notNull && this.rng.chance(0.1)) return null;
    return this.rng.pick(rows).v;
  }

  /** A new value for one column of one row, or undefined when none is sensible. */
  proposeValue(table: TableModel, column: ColumnModel, current: SQLInputValue | null, rows: readonly Row[]): SQLInputValue | undefined {
    if (column.references) return this.foreignValue(column);
    if (!column.notNull && current !== null && this.rng.chance(0.08)) return null;
    if (column.enumValues) {
      const others = column.enumValues.filter((value) => value !== current);
      return others.length > 0 ? this.rng.pick(others) : undefined;
    }
    const peers = rows.map((row) => row[column.name]).filter((value) => value !== null && value !== current) as SQLInputValue[];
    if (column.shape === "boolean") return current === null ? 1 : Number(current) === 0 ? 1 : 0;
    if (current === null) {
      if (peers.length > 0) return this.rng.pick(peers);
      if (column.shape === "timestamp") return 1_790_000_000 + this.rng.int(-10, 10) * 86_400;
      if (column.shape === "integer") return this.rng.int(0, 5);
      if (column.shape === "real") return this.rng.int(0, 500) / 10;
      return `seeded ${this.rng.int(1, 999)}`;
    }
    if (typeof current === "number" || typeof current === "bigint") {
      const value = Number(current);
      if (column.shape === "timestamp" || (value > 1_000_000_000 && value < 10_000_000_000)) {
        return value + this.rng.pick([-1, 1]) * this.rng.int(1, 12) * 43_200;
      }
      if (column.shape === "real") return Math.round(value * this.rng.pick([0.5, 0.9, 1.1, 2]) * 100) / 100;
      return this.rng.weighted<number>([
        [3, value + 1],
        [3, Math.max(0, value - 1)],
        [2, value + 10],
        [2, Math.round(value * 1.1) + 1],
        [1, 0],
        [1, this.rng.int(0, 12)],
        [peers.length > 0 ? 2 : 0, Number(this.rng.pick(peers.length > 0 ? peers : [0]))],
      ]);
    }
    if (typeof current === "string") {
      if (column.shape === "json" || looksLikeJson(current)) return this.perturbJson(current);
      if (ID_PREFIXES.test(current)) {
        const prefix = /^([a-z]+)_/.exec(current)![1]!;
        const alternatives = (this.ids().get(prefix) ?? []).filter((id) => id !== current);
        if (alternatives.length > 0 && this.rng.chance(0.7)) return this.rng.pick(alternatives);
      }
      return this.rng.weighted<string>([
        [peers.length > 0 ? 3 : 0, String(this.rng.pick(peers.length > 0 ? peers : [""]))],
        [3, uniqueVariant(current, `${this.rng.int(1, 99)}`)],
        [1, current.toUpperCase() === current ? current.toLowerCase() : current.toUpperCase()],
        [1, `${current} edited`],
        [1, current.slice(0, Math.max(1, Math.floor(current.length / 2)))],
      ]);
    }
    return undefined;
  }

  /** Change one leaf (or the shape) of a JSON document. */
  perturbJson(text: string): string {
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      return `${text} `;
    }
    const leaves: Array<{ path: Array<string | number>; value: unknown }> = [];
    const walk = (value: unknown, path: Array<string | number>) => {
      leaves.push({ path, value });
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]));
      else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    };
    walk(document, []);
    const target = this.rng.pick(leaves.length > 1 ? leaves.slice(1) : leaves);
    const next = this.perturbLeaf(target.value);
    if (target.path.length === 0) return JSON.stringify(next);
    let parent = document as Record<string | number, unknown>;
    for (const key of target.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    const key = target.path[target.path.length - 1]!;
    if (next === REMOVE) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else {
      parent[key] = next;
    }
    return JSON.stringify(document);
  }

  private perturbLeaf(value: unknown): unknown {
    if (typeof value === "boolean") return !value;
    if (typeof value === "number") return this.rng.pick([value + 1, Math.max(0, value - 1), value * 2, 0]);
    if (typeof value === "string") {
      if (ID_PREFIXES.test(value)) {
        const prefix = /^([a-z]+)_/.exec(value)![1]!;
        const alternatives = (this.ids().get(prefix) ?? []).filter((id) => id !== value);
        if (alternatives.length > 0) return this.rng.pick(alternatives);
      }
      return this.rng.weighted<unknown>([[4, `${value}x`], [1, ""], [1, REMOVE]]);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      return this.rng.weighted<unknown>([
        [2, value.slice(1)],
        [2, [...value].reverse()],
        [1, [...value, value[0]]],
        [1, REMOVE],
      ]);
    }
    if (value && typeof value === "object") return this.rng.chance(0.3) ? REMOVE : value;
    if (value === null) return this.rng.pick(["x", 1, true]);
    return value;
  }
}

const REMOVE = Symbol("remove");

function looksLikeJson(value: string): boolean {
  const first = value.trimStart()[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function uniqueVariant(value: string, suffix: string): string {
  if (/^[a-z0-9-]+$/.test(value)) return `${value}-${suffix}`.slice(0, 100);
  if (/^[A-Z0-9_-]+$/.test(value)) return `${value}${suffix}`.toUpperCase().slice(0, 50);
  return `${value} ${suffix}`;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function describeRow(table: TableModel, row: Row): string {
  const columns = table.pkColumns.length > 0 ? table.pkColumns : table.columns.slice(0, 2).map((column) => column.name);
  return columns.map((column) => `${column}=${preview(row[column])}`).join(" AND ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
