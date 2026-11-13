/**
 * Test-only: D1's own rows-read accounting for a seeded store.
 *
 * The Free meter (free-plan-meter.ts) estimates rows read from the plans'
 * `SCAN` steps, so an index range walk (`SEARCH ... (created_at<?)`) reads
 * nothing in it. Here a store seeded in node:sqlite is copied into a
 * Miniflare D1 database (workerd's SQLite, the engine D1 bills with) and a
 * D1 binding in Node sends every statement through the real D1 API, adding
 * up each result's `meta.rows_read` and `meta.rows_written`. `raw()` keeps
 * its arrays and its meta: the worker answers in D1's rows-and-columns form.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export interface RowsReadCounters {
  calls: number;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

export interface MeteredD1 {
  binding: D1Database;
  counters: RowsReadCounters;
  /** Each statement and its rows read since the last reset (with `statements: true`). */
  statements: Array<{ sql: string; rowsRead: number }>;
  reset(): void;
  dispose(): Promise<void>;
}

const WORKER = `
const decode = (value) => value && typeof value === "object" && typeof value.$b === "string"
  ? Uint8Array.from(atob(value.$b), (c) => c.charCodeAt(0)).buffer
  : value;
export default {
  async fetch(request, env) {
    const body = await request.json();
    try {
      if (typeof body.exec === "string") return Response.json({ ok: true, exec: await env.DB.exec(body.exec) });
      // The binding keeps its session private; a primary session is the same
      // object and takes the same call the binding makes for all() and batch().
      const session = env.DB.withSession("first-primary");
      const sql = body.statements.map((s) => s.sql);
      const params = body.statements.map((s) => s.params.map(decode));
      const results = await session._sendOrThrow("/query", body.batch ? sql : sql[0], body.batch ? params : params[0], "ROWS_AND_COLUMNS", { setAttribute() {} });
      return Response.json({ ok: true, results: Array.isArray(results) ? results : [results] });
    } catch (error) {
      return Response.json({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  },
};`;

type Wire = { columns: string[]; rows: unknown[][] };
type WireResult = { success: boolean; meta: Record<string, number> & { rows_read?: number; rows_written?: number }; results: Wire };

const encode = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $b: Buffer.from(bytes).toString("base64") };
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value === undefined ? null : value;
};

const objects = (wire: Wire) => (wire.rows ?? []).map((row) => Object.fromEntries((wire.columns ?? []).map((column, index) => [column, row[index]])));

/** Copies `seeded` (closed by the caller afterwards) into a fresh Miniflare D1 database and meters a binding to it. */
export async function meterSeededD1(seeded: DatabaseSync, options: { statements?: boolean } = {}): Promise<MeteredD1> {
  const dir = mkdtempSync(join(tmpdir(), "scalius-rows-read-"));
  const miniflareOptions = () => convertV4MiniflareOptions({
    modules: true,
    script: WORKER,
    compatibilityDate: "2026-10-01",
    d1Databases: { DB: "store" },
    resourcePersistencePath: dir,
  } as never);
  // Miniflare creates the database file; the seeded store replaces it, keeping
  // Miniflare's own metadata table.
  let mf = new Miniflare(miniflareOptions() as never);
  const first = await (await mf.dispatchFetch("http://d1/", { method: "POST", body: JSON.stringify({ statements: [{ sql: "SELECT 1", params: [] }] }) })).json() as { ok: boolean; error?: string };
  if (!first.ok) {
    await mf.dispose();
    throw new Error(`The rows-read meter's D1 call failed: ${first.error}`);
  }
  await mf.dispose();
  const objectsDir = join(dir, "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(objectsDir).map((name) => join(objectsDir, name))
    .find((path) => path.endsWith(".sqlite") && !path.endsWith("metadata.sqlite"));
  if (!file) throw new Error("Miniflare created no D1 database file");
  const copy = `${file}.seeded`;
  seeded.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  const target = new DatabaseSync(copy);
  target.exec(`ATTACH '${file.replaceAll("'", "''")}' AS mf`);
  for (const table of target.prepare("SELECT name, sql FROM mf.sqlite_master WHERE type = 'table' AND substr(name, 1, 4) = '_cf_'").all() as Array<{ name: string; sql: string }>) {
    target.exec(table.sql);
    target.exec(`INSERT INTO main."${table.name}" SELECT * FROM mf."${table.name}"`);
  }
  target.exec("DETACH mf");
  target.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) rmSync(file + suffix);
  renameSync(copy, file);
  mf = new Miniflare(miniflareOptions() as never);

  const counters: RowsReadCounters = { calls: 0, statements: 0, rowsRead: 0, rowsWritten: 0 };
  const log = options.statements ? [] as Array<{ sql: string; rowsRead: number }> : undefined;
  const send = async (statements: Array<{ sql: string; params: unknown[] }>, batch: boolean): Promise<WireResult[]> => {
    const response = await mf.dispatchFetch("http://d1/", {
      method: "POST",
      body: JSON.stringify({ batch, statements: statements.map((s) => ({ sql: s.sql, params: s.params.map(encode) })) }),
    });
    const body = await response.json() as { ok: boolean; error?: string; results?: WireResult[] };
    counters.calls += 1;
    counters.statements += statements.length;
    if (!body.ok) throw new Error(body.error ?? "D1 error");
    (body.results ?? []).forEach((result, index) => {
      counters.rowsRead += Number(result.meta?.rows_read ?? 0);
      counters.rowsWritten += Number(result.meta?.rows_written ?? 0);
      log?.push({ sql: statements[index]?.sql ?? "?", rowsRead: Number(result.meta?.rows_read ?? 0) });
    });
    return body.results ?? [];
  };
  const asResult = (result: WireResult) => ({ success: true, meta: result.meta, results: objects(result.results) });

  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    get query() { return this.sql; }
    bind(...params: unknown[]) { return new Statement(this.sql, params); }
    async all() { return asResult((await send([this], false))[0]!); }
    async run() { return this.all(); }
    async first(column?: string) {
      const row = (await this.all()).results[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return column ? (row[column] ?? null) : row;
    }
    async raw(options?: { columnNames?: boolean }) {
      const wire = (await send([this], false))[0]!.results;
      return options?.columnNames ? [wire.columns, ...wire.rows] : wire.rows;
    }
  }
  const binding = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      return (await send(statements, true)).map(asResult);
    },
    async exec(sql: string) {
      counters.calls += 1;
      const response = await mf.dispatchFetch("http://d1/", { method: "POST", body: JSON.stringify({ exec: sql }) });
      const body = await response.json() as { ok: boolean; error?: string; exec?: unknown };
      if (!body.ok) throw new Error(body.error ?? "D1 error");
      return body.exec;
    },
    withSession() { return binding; },
    async dump() { throw new Error("dump is not supported"); },
  };
  return {
    binding: binding as unknown as D1Database,
    counters,
    statements: log ?? [],
    reset() {
      Object.assign(counters, { calls: 0, statements: 0, rowsRead: 0, rowsWritten: 0 });
      log?.splice(0);
    },
    async dispose() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const DAY = 86_400;
/** Orders a day in the seeded history: both store sizes share it, so only the history's length differs. */
export const HISTORY_ORDERS_PER_DAY = 100;

/**
 * A steady-state store's history in a migrated database that already holds
 * the budget catalogue (free-plan-seed.ts `seedCatalog`): `orders` orders at
 * HISTORY_ORDERS_PER_DAY ending `now` (two lines each, a reservation and a
 * deduction per line), about 96% delivered and 3% cancelled, the newest 30
 * still open; the analytics facts their triggers build, every finished day
 * sealed, and per order a checkout attempt, a receipt, a sent notification, a
 * review request and (the last 40 days) a Meta log row. Event triggers are
 * off while it is written: that history was published long ago.
 */
export function seedOrderHistory(sqlite: DatabaseSync, input: { orders: number; now: number }): { days: number } {
  const n = input.orders;
  const step = DAY / HISTORY_ORDERS_PER_DAY;
  const days = Math.ceil(n / HISTORY_ORDERS_PER_DAY);
  const start = input.now - days * DAY;
  const at = (i: string) => `(${start} + (${i}) * ${step})`;
  const eventTriggers = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, 4) = 'evt_'").all() as Array<{ name: string; sql: string }>;
  for (const trigger of eventTriggers) sqlite.exec(`DROP TRIGGER "${trigger.name}"`);
  const counter = (count: number) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
  const order = (i: string) => `printf('ord_h_%07d', ${i})`;
  sqlite.exec(`
    ${counter(n)}
    INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
      subtotal_amount_minor, total_amount_minor, subtotal_shop_minor, total_shop_minor,
      status, payment_method, payment_status, paid_amount_minor, created_at, updated_at)
    SELECT ${order("i")}, 'Buyer ' || i, '+88017' || printf('%08d', i), 'buyer' || i || '@shop.test', 'House 1, Road 2', 'city_1', 'zone_1',
      20000, 20000, 20000, 20000,
      CASE WHEN i > ${n - 3} THEN 'incomplete' WHEN i > ${n - 30} THEN 'confirmed' WHEN i % 33 = 0 THEN 'cancelled' ELSE 'delivered' END,
      CASE WHEN i > ${n - 3} OR i % 4 = 0 THEN 'stripe' ELSE 'cod' END,
      CASE WHEN i BETWEEN ${n - 29} AND ${n - 25} THEN 'paid' WHEN i > ${n - 30} OR i % 33 = 0 THEN 'unpaid' ELSE 'paid' END,
      CASE WHEN i BETWEEN ${n - 29} AND ${n - 25} THEN 20000 WHEN i > ${n - 30} OR i % 33 = 0 THEN 0 ELSE 20000 END,
      ${at("i")}, ${at("i")}
    FROM n;
    ${counter(n * 2)}
    INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, quantity, unit_price_minor, line_subtotal_minor,
      fulfillment_type, fulfilled_quantity, created_at)
    SELECT printf('li_h_%08d', i), ${order("(i + 1) / 2")}, 'p_bulk_' || (i % 100 + 1), 'v_bulk_' || (i % 100 + 1), 'Bulk item', 1, 10000, 10000,
      -- Every 20th order's second line is a download, every 50th a gift card: handed over in the
      -- history, owed on five open paid orders (the auto-fulfil backstop's partial index).
      CASE WHEN i % 2 = 0 AND (i / 2) % 20 = 0 THEN 'digital' WHEN i % 2 = 0 AND (i / 2) % 50 = 0 THEN 'gift_card'
        WHEN i % 2 = 0 AND (i / 2) BETWEEN ${n - 29} AND ${n - 25} THEN 'digital' ELSE 'ship' END,
      CASE WHEN i % 2 = 0 AND (i / 2) BETWEEN ${n - 29} AND ${n - 25} THEN 0 WHEN (i + 1) / 2 > ${n - 30} THEN 0 ELSE 1 END,
      ${at("(i + 1) / 2")}
    FROM n;
    ${counter(n * 4)}
    INSERT INTO inventory_movements (id, variant_id, order_id, type, quantity, previous_stock, new_stock, ledger_version, created_at)
    SELECT printf('mv_h_%09d', i), 'v_bulk_' || ((i + 1) / 2 % 100 + 1), ${order("(i + 3) / 4")},
      CASE WHEN i % 2 = 1 THEN 'reserved' WHEN ((i + 3) / 4) % 33 = 0 THEN 'released' ELSE 'deducted' END,
      1, 0, 0, 1, ${at("(i + 3) / 4")}
    FROM n;
    ${counter(days)}
    INSERT INTO analytics_sealed_days (day) SELECT (${Math.floor(start / DAY)} + i - 1) * ${DAY} FROM n WHERE (${Math.floor(start / DAY)} + i - 1) * ${DAY} < ${Math.floor(input.now / DAY) * DAY};
    ${counter(n)}
    INSERT INTO checkout_attempts (id, request_key, request_hash, checkout_token, order_id, status, response_payload, attempts, created_at, updated_at)
    SELECT 'att_h_' || i, 'key_h_' || i, 'hash', 'tok_h_' || i, ${order("i")}, 'committed', '{}', 1, ${at("i")}, ${at("i")} FROM n;
    ${counter(n)}
    INSERT INTO order_receipts (token_hash, order_id, status, expires_at, created_at, updated_at)
    SELECT 'rh_h_' || i, ${order("i")}, 'active', ${at("i")} + ${7 * DAY}, ${at("i")}, ${at("i")} FROM n;
    ${counter(n)}
    INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload, status, attempts, next_attempt_at, sent_at, created_at, updated_at)
    SELECT 'out_h_' || i, 'order:' || ${order("i")} || ':order_confirmed', 'order', ${order("i")}, ${order("i")}, 'customer', 'order_confirmed', 'seed', '{}', 'sent', 1, ${at("i")}, ${at("i")}, ${at("i")}, ${at("i")} FROM n;
    ${counter(n)}
    INSERT INTO order_review_requests (order_id, delivered_at, status, updated_at)
    SELECT ${order("i")}, ${at("i")} + ${2 * DAY}, CASE WHEN ${at("i")} < ${input.now - 10 * DAY} THEN 'queued' ELSE 'scheduled' END, ${at("i")}
    FROM n WHERE i <= ${n - 30} AND i % 33 <> 0;
    ${counter(n)}
    INSERT INTO meta_conversions_logs (id, event_id, event_name, status, request_payload, event_time, created_at)
    SELECT 'mlog_h_' || i, 'evt_h_' || i, 'ViewContent', CASE WHEN i % 5 = 0 THEN 'failed' ELSE 'success' END, '{}', ${at("i")}, ${at("i")}
    FROM n WHERE ${at("i")} >= ${input.now - 40 * DAY} AND i % 10 = 0;
  `);
  for (const trigger of eventTriggers) sqlite.exec(trigger.sql);
  return { days };
}
