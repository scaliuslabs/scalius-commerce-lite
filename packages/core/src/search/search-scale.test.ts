// Opt-in: search read latency on a large local store, per provider. Skips
// unless SEARCH_SCALE_PROVIDER is set:
//   d1        SEARCH_SCALE_SQLITE=<D1-schema SQLite file>     (in-process SQLite, as local D1)
//   turso     SEARCH_SCALE_SQLITE=<Turso-schema SQLite file>  (Turso's SQL over SQLite)
//   postgres  SEARCH_SCALE_POSTGRES_URL=<database URL>
// SEARCH_SCALE_QUERIES is a JSON object { label: query } (broad, narrow, typo,
// sku; labels starting "people" time the order and customer lists). Prints p50 and p95 in ms per read and query; the
// store is only read.
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getDb, type Database } from "@scalius/database/client";
import { createSqliteD1Database, createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import { getStorefrontProducts } from "../modules/catalog/listing";
import { search } from "../modules/catalog/site-search";
import { listCustomers } from "../modules/customers/customers.service";
import { listOrders } from "../modules/orders/admin/list";
import { listProducts } from "../modules/product-admin/read";

const provider = process.env.SEARCH_SCALE_PROVIDER;
const RUNS = Number(process.env.SEARCH_SCALE_RUNS ?? 15);

function open(): Database {
  if (provider === "postgres") return getDb({ DATABASE_PROVIDER: "postgres", POSTGRES_DATABASE_URL: process.env.SEARCH_SCALE_POSTGRES_URL });
  const sqlite = new DatabaseSync(process.env.SEARCH_SCALE_SQLITE!, { readOnly: true });
  return provider === "turso" ? createSqliteTursoDatabase(sqlite) : createSqliteD1Database({ sqlite }).db;
}

async function time(read: () => Promise<unknown>): Promise<{ p50: number; p95: number; rows: number }> {
  let rows = 0;
  for (let warm = 0; warm < 2; warm += 1) await read();
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    const value = await read();
    samples.push(performance.now() - started);
    rows = count(value);
  }
  samples.sort((left, right) => left - right);
  const at = (quantile: number) => samples[Math.min(samples.length - 1, Math.ceil(quantile * samples.length) - 1)]!;
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), rows };
}

function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.products) && "pages" in record) return (record.products as unknown[]).length;
  const list = Object.values(record).find(Array.isArray);
  return list ? (list as unknown[]).length : 0;
}

describe.runIf(provider)("search latency at scale", () => {
  it("times every search read", async () => {
    const db = open();
    const queries = JSON.parse(process.env.SEARCH_SCALE_QUERIES ?? "{}") as Record<string, string>;
    const reads: Record<string, (query: string) => Promise<unknown>> = {
      site: (query) => search(db, query, { limit: 10, correctTypos: true }),
      listing: (query) => getStorefrontProducts(db, { search: query, sort: "relevance", page: 1, limit: 24 }),
      adminProducts: (query) => listProducts(db, { search: query, limit: 50 }),
      adminOrders: (query) => listOrders(db, { search: query, limit: 50 }),
      adminCustomers: (query) => listCustomers(db, { search: query, limit: 50 }),
    };
    const results: string[] = [];
    for (const [label, query] of Object.entries(queries)) {
      // A label starting "people" times the order and customer lists; any other the catalog reads.
      const people = label.startsWith("people");
      for (const [name, read] of Object.entries(reads)) {
        if (people !== (name === "adminOrders" || name === "adminCustomers")) continue;
        const measured = await time(() => read(query));
        results.push(`${provider}\t${name}\t${label}\t${query}\t${measured.p50}\t${measured.p95}\t${measured.rows}`);
      }
    }
    // SEARCH_SCALE_OUT: a file for the table (the test runner may drop console output).
    if (process.env.SEARCH_SCALE_OUT) writeFileSync(process.env.SEARCH_SCALE_OUT, `${results.join("\n")}\n`);
    else console.log(`SEARCH_SCALE\n${results.join("\n")}`);
    expect(results.length).toBeGreaterThan(0);
  }, 3_600_000);
});
