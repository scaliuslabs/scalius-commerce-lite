/**
 * Independent change capture for SQLite providers: TEMP triggers on every real
 * table log each committed row change with its full old and new image into a
 * TEMP table. TEMP objects are invisible to the application schema and are
 * not serialized, so the database under test is untouched.
 *
 * The log serves three purposes:
 * - the reference oracle derives the dependency keys the registry promises
 *   from each logged change (before S1's triggers exist, and to cross-check
 *   them once they do);
 * - the harness knows exactly which tables changed in a step, so a valid entry
 *   whose read tables did not change needs no fresh render;
 * - a failure report names the rows that changed after the entry rendered.
 *
 * Values are logged with `quote()`, so types survive (1 vs '1' vs NULL).
 */
import type { DatabaseSync } from "node:sqlite";
import type { SchemaModel } from "./schema-model";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type RowImage = Readonly<Record<string, SqlValue>>;

export interface LoggedChange {
  readonly id: number;
  readonly table: string;
  readonly op: "insert" | "update" | "delete";
  readonly old: RowImage | null;
  readonly new: RowImage | null;
}

const LOG_TABLE = "_dvc_log";
const COLUMN_CHUNK = 60;

/** Parse one `quote()` literal back into a value. */
export function parseQuoted(literal: string): SqlValue {
  if (literal === "NULL") return null;
  if (literal.startsWith("'")) return literal.slice(1, -1).replace(/''/g, "'");
  if (/^X'/i.test(literal)) {
    const hex = literal.slice(2, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }
  const number = Number(literal);
  if (Number.isSafeInteger(number) || !/^-?\d+$/.test(literal)) return number;
  return BigInt(literal);
}

function imageExpression(alias: "NEW" | "OLD", columns: readonly string[]): string {
  const chunks: string[] = [];
  for (let index = 0; index < columns.length; index += COLUMN_CHUNK) {
    const members = columns.slice(index, index + COLUMN_CHUNK)
      .map((column) => `'${column}', quote(${alias}."${column}")`)
      .join(", ");
    chunks.push(`json_object(${members})`);
  }
  return chunks.reduce((left, right) => `json_patch(${left}, ${right})`);
}

export class RowLog {
  private lastId = 0;

  constructor(private readonly sqlite: DatabaseSync, readonly tables: readonly string[]) {}

  /** Install the TEMP log table and triggers on every modelled table. */
  static install(sqlite: DatabaseSync, model: SchemaModel): RowLog {
    sqlite.exec(`CREATE TEMP TABLE IF NOT EXISTS ${LOG_TABLE} (
      id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, op TEXT NOT NULL, old_image TEXT, new_image TEXT)`);
    const tables: string[] = [];
    for (const table of model.values()) {
      const columns = table.columns.map((column) => column.name);
      if (columns.length === 0 || table.name === "cache_clock" || table.name === "cache_dep") continue;
      const name = table.name;
      const newImage = imageExpression("NEW", columns);
      const oldImage = imageExpression("OLD", columns);
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS "_dvc_${name}_ins" AFTER INSERT ON main."${name}" BEGIN
          INSERT INTO ${LOG_TABLE} (tbl, op, old_image, new_image) VALUES ('${name}', 'insert', NULL, ${newImage});
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS "_dvc_${name}_upd" AFTER UPDATE ON main."${name}" BEGIN
          INSERT INTO ${LOG_TABLE} (tbl, op, old_image, new_image) VALUES ('${name}', 'update', ${oldImage}, ${newImage});
        END;
        CREATE TEMP TRIGGER IF NOT EXISTS "_dvc_${name}_del" AFTER DELETE ON main."${name}" BEGIN
          INSERT INTO ${LOG_TABLE} (tbl, op, old_image, new_image) VALUES ('${name}', 'delete', ${oldImage}, NULL);
        END;`);
      tables.push(name);
    }
    const log = new RowLog(sqlite, tables);
    log.lastId = log.position();
    return log;
  }

  /** The id of the newest logged change. */
  position(): number {
    const row = this.sqlite.prepare(`SELECT coalesce(max(id), 0) AS id FROM ${LOG_TABLE}`).get() as { id: number };
    return Math.max(Number(row.id), this.lastId);
  }

  /** Changes logged after `afterId` (the log is append-only until `trim`). */
  since(afterId: number): LoggedChange[] {
    const rows = this.sqlite.prepare(
      `SELECT id, tbl, op, old_image, new_image FROM ${LOG_TABLE} WHERE id > ? ORDER BY id`,
    ).all(afterId) as Array<{ id: number; tbl: string; op: LoggedChange["op"]; old_image: string | null; new_image: string | null }>;
    return rows.map((row) => ({
      id: Number(row.id),
      table: row.tbl,
      op: row.op,
      old: row.old_image === null ? null : decodeImage(row.old_image),
      new: row.new_image === null ? null : decodeImage(row.new_image),
    }));
  }

  /** Changes since the last drain; advances the drain cursor. */
  drain(): LoggedChange[] {
    const changes = this.since(this.lastId);
    if (changes.length > 0) this.lastId = changes[changes.length - 1]!.id;
    return changes;
  }

  /** Tables changed after `afterId` (cheap: no image decoding). */
  tablesChangedSince(afterId: number): Set<string> {
    const rows = this.sqlite.prepare(`SELECT DISTINCT tbl FROM ${LOG_TABLE} WHERE id > ?`).all(afterId) as Array<{ tbl: string }>;
    return new Set(rows.map((row) => row.tbl));
  }

  /** Forget changes at or before `beforeId` (long runs keep the log small). */
  trim(beforeId: number): void {
    this.sqlite.prepare(`DELETE FROM ${LOG_TABLE} WHERE id <= ?`).run(beforeId);
  }

  uninstall(): void {
    for (const name of this.tables) {
      this.sqlite.exec(`DROP TRIGGER IF EXISTS temp."_dvc_${name}_ins"; DROP TRIGGER IF EXISTS temp."_dvc_${name}_upd"; DROP TRIGGER IF EXISTS temp."_dvc_${name}_del";`);
    }
    this.sqlite.exec(`DROP TABLE IF EXISTS temp.${LOG_TABLE}`);
  }
}

function decodeImage(json: string): RowImage {
  const raw = JSON.parse(json) as Record<string, string>;
  const image: Record<string, SqlValue> = {};
  for (const [column, literal] of Object.entries(raw)) image[column] = parseQuoted(literal);
  return image;
}

/** Column names whose value differs between two images. */
export function changedColumns(before: RowImage, after: RowImage): string[] {
  const changed: string[] = [];
  for (const column of Object.keys(after)) {
    if (!sameValue(before[column] ?? null, after[column] ?? null)) changed.push(column);
  }
  return changed;
}

export function sameValue(left: SqlValue, right: SqlValue): boolean {
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  }
  if (typeof left !== typeof right) return false;
  return left === right;
}
