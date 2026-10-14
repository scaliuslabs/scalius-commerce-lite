// One corpus (English, Bangla, SKUs, phones, emails), every search read:
// D1 (FTS5), Turso's code path and native PostgreSQL (the search index)
// return the same rows in the same order, and the real Turso engine runs the
// search SQL with D1's matches and order. PostgreSQL runs when
// SCALIUS_TEST_POSTGRES_URL is set (native suites).
import type { Database } from "@scalius/database/client";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { createMigratedSqlite, createSqliteD1Database, createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { createTursoEngineDatabase, tursoEngineStoreFrom } from "@scalius/database/testing/turso-engine";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getStorefrontProducts } from "../modules/catalog/listing";
import { searchStorefrontProducts } from "../modules/catalog/search";
import { search } from "../modules/catalog/site-search";
import { listCustomers } from "../modules/customers/customers.service";
import { listOrders } from "../modules/orders/admin/list";
import { listProducts } from "../modules/product-admin/read";
import { rebuildCatalogProjections } from "../modules/products";
import { searchTerms } from "@scalius/database/search-index";
import { sanitizeSearchTokens, searchKeyColumn, searchMatch, searchPrefixKeys, searchRank, type SearchSource } from "./text-search";

const products: Array<[id: string, name: string, description: string | null, category: string | null, active?: 0]> = [
  ["p01", "Leather Wallet", "Genuine leather bifold wallet with a coin pocket", "cat_bags"],
  ["p02", "Leather Backpack Bag", "Laptop backpack, leather straps. Fits a 15\" laptop.", "cat_bags"],
  ["p03", "Canvas Tote Bag", "Eco-friendly tote — great for shopping…", "cat_bags"],
  ["p04", "চামড়ার মানিব্যাগ", "খাঁটি চামড়া। নতুন ডিজাইন", "cat_bags"],
  ["p05", "জুতা — কালো", "আরামদায়ক জুতা, ৳১৫০০", "cat_shoes"],
  ["p06", "Running Shoes X2", "Lightweight running shoes (SKU-RS-200)", "cat_shoes"],
  ["p07", "Café Mug", "Ceramic mug for café lovers", null],
  ["p08", "Smart Watch Pro™", "“Smart” fitness watch; heart-rate & GPS", "cat_elec"],
  ["p09", "USB-C Cable 2m", "Fast charging USB-C to USB-C cable", "cat_elec"],
  ["p10", "Wallet Organizer", "Organizer for wallets and cards", null],
  ["p11", "Leather Belt", "Leather belt: leather, leather and more leather", "cat_bags"],
  ["p12", "Shoe Polish", "Polish for leather shoes and bags", null],
  ["p13", "Leather Gloves", "Hidden from buyers", null, 0],
  ["p14", "র‍্যাব ক্যাপ", "ক্যাপ", null],
  ["p15", "T-Shirt", "Cotton t-shirt, soft and breathable", null],
  ["p16", "Tea Kettle", "Stovetop kettle", null],
];
const quote = (value: string | null) => value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
const FIXTURE = [
  "INSERT INTO categories (id, name, slug, status, description) VALUES ('cat_bags', 'Bags & Wallets', 'bags', 'published', 'Leather bags and wallets'), ('cat_shoes', 'জুতা ও স্যান্ডেল', 'shoes', 'published', NULL), ('cat_elec', 'Electronics', 'electronics', 'published', 'Watches & cables'), ('cat_draft', 'Leather Draft', 'draft', 'draft', NULL)",
  `INSERT INTO products (id, name, description, price_minor, slug, category_id, is_active, created_at) VALUES ${products.map(([id, name, description, category, active], index) =>
    `('${id}', ${quote(name)}, ${quote(description)}, ${1000 + index * 100}, '${id}', ${quote(category)}, ${active ?? 1}, ${1_700_000_000 + index})`).join(", ")}`,
  `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES ${products.map(([id], index) =>
    `('v_${id}', '${id}', ${quote(["LW-001", "BP-200-BLK", "TOTE-ECO", "BN-WAL-1", "JT-BLK-42", "RS-200", "MUG-CAFE", "SW-PRO", "USBC-2M", "WO-1", "LB-1", "SP-1", "GL-1", "CAP-1", "TS-M", "KT-1"][index]!)}, ${1000 + index * 100}, 0, 0, 1, 0)`).join(", ")}`,
  "INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_returns', 'Return Policy', 'returns', '<p>Returns within 7 days of delivery.</p>', 1), ('pg_bn', 'রিটার্ন নীতি', 'returns-bn', 'পণ্য ফেরত দেওয়ার নিয়ম', 1), ('pg_ship', 'Shipping Guide', 'shipping', 'Leather goods ship in 2 days; bags in 3.', 1)",
  "INSERT INTO customers (id, name, phone, email) VALUES ('c1', 'Rahim Uddin', '+8801712345678', 'rahim@example.com'), ('c2', 'রহিম উদ্দিন', '+8801812345678', 'rahim.bn@example.com'), ('c3', 'Karim Leather', '01912345678', 'karim@shop.example')",
  "INSERT INTO orders (id, customer_name, customer_phone, customer_email, status, requires_shipping, created_at) VALUES ('ord_a', 'Rahim Uddin', '+8801712345678', 'rahim@example.com', 'pending', 0, 1700000100), ('ord_b', 'রহিম উদ্দিন', '+8801812345678', NULL, 'pending', 0, 1700000200), ('ord_c', 'Karim Leather', '01912345678', 'karim@shop.example', 'pending', 0, 1700000300)",
];

const STOREFRONT_QUERIES = ["leather", "lea", "bag", "wallet", "LEATHER bag", "চামড়া", "জুতা", "ক্যাপ", "cafe", "café", "usb c", "smart watch", "‘smart’", "t shirt", "return", "রিটার্ন", "zzz", "©"];
const ADMIN_PRODUCT_QUERIES = ["leather", "SKU-RS", "rs-200", "bp-200", "gl", "মানিব্যাগ"];
const PEOPLE_QUERIES = ["rahim", "রহিম", "01712", "8801812", "rahim@example.com", "example", "karim leather", "ord_c"];

type Provider = { name: string; db: Database };
const providers: Provider[] = [];

/** The ids of a list result, in order. */
function ids(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((row) => String((row as { id: unknown }).id));
  const list = Object.values(value as Record<string, unknown>).find((entry) =>
    Array.isArray(entry) && (entry.length === 0 || typeof (entry[0] as { id?: unknown })?.id === "string"));
  return ids(list ?? []);
}

async function everyRead(db: Database): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const query of STOREFRONT_QUERIES) {
    const site = await search(db, query, { limit: 20 });
    results[`site ${query}`] = [ids(site.products), ids(site.categories), ids(site.pages)];
    results[`listing ${query}`] = ids(await getStorefrontProducts(db, { search: query, sort: "relevance", page: 1, limit: 20 }));
    results[`storefront search ${query}`] = ids(await searchStorefrontProducts(db, { search: query, page: 1, limit: 20 }));
  }
  for (const query of ADMIN_PRODUCT_QUERIES) results[`admin products ${query}`] = ids(await listProducts(db, { search: query, limit: 50 }));
  for (const query of PEOPLE_QUERIES) {
    results[`orders ${query}`] = ids(await listOrders(db, { search: query, limit: 50 }));
    results[`customers ${query}`] = ids(await listCustomers(db, { search: query, limit: 50 }));
  }
  return results;
}

/**
 * The search SQL alone: each source's matches with their bm25 (10 significant
 * digits), best first, then by id. A word a separator splits ("ord_c") is an
 * FTS5 phrase: its score differs (docs/DATABASE-PORTABILITY.md, Text search), its matches not.
 */
async function indexReads(db: Database): Promise<Record<string, string[]>> {
  const results: Record<string, string[]> = {};
  const sources: Array<[SearchSource, string[]]> = [
    ["products", [...STOREFRONT_QUERIES, ...ADMIN_PRODUCT_QUERIES]],
    ["product_variants", ADMIN_PRODUCT_QUERIES],
    ["categories", STOREFRONT_QUERIES],
    ["pages", STOREFRONT_QUERIES],
    ["orders", PEOPLE_QUERIES],
    ["customers", PEOPLE_QUERIES],
  ];
  for (const [source, queries] of sources) {
    for (const query of queries) {
      const match = searchMatch(db, source, query);
      const rank = searchRank(db, source, query, { alias: "parity_rank", weights: source === "products" ? [10, 1] : undefined });
      if (!match || !rank) continue;
      const rows = await db.all<{ id: string; score: number }>(sql`SELECT ${sql.raw(`"${source}"`)}.id AS id, ${rank.score} AS score FROM ${sql.raw(`"${source}"`)}
        ${rank.join ? sql`LEFT JOIN ${rank.join.table} ON ${rank.join.on}` : sql``} WHERE ${match} ORDER BY ${rank.score}, ${sql.raw(`"${source}"`)}.id`);
      const phrase = sanitizeSearchTokens(query).some((token) => searchTerms(token).length > 1);
      results[`${source} ${query}`] = rows.map((row) => phrase ? row.id : `${row.id} ${Number(row.score).toPrecision(10)}`);
    }
  }
  const phones = searchPrefixKeys(db, "customers", "phone", ["01712", "1712", "8801712"]);
  results["customer phones"] = (await db.all<{ id: string }>(sql`SELECT id FROM customers WHERE customers.${sql.raw(searchKeyColumn(db))} IN (${phones}) ORDER BY id`))
    .map((row) => String(row.id));
  return results;
}

describe("search parity across providers", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  let d1: Database;
  let tursoSqlite: ReturnType<typeof createMigratedSqlite>;
  beforeAll(async () => {
    const harness = createSqliteD1Database();
    for (const statement of FIXTURE) harness.sqlite.exec(statement);
    d1 = harness.db;
    await rebuildCatalogProjections(d1);
    providers.push({ name: "d1", db: d1 });
    // Turso's code path over SQLite: the reads run as written for Turso.
    tursoSqlite = createMigratedSqlite({ provider: "turso" });
    for (const statement of FIXTURE) tursoSqlite.exec(statement);
    const turso = createSqliteTursoDatabase(tursoSqlite);
    await rebuildCatalogProjections(turso);
    providers.push({ name: "turso", db: turso });
    if (nativePostgresUrl()) {
      const { db, client } = await createNativePostgres({ label: "search_parity" });
      for (const statement of FIXTURE) await client.query(statement);
      await rebuildCatalogProjections(db);
      providers.push({ name: "postgres", db });
    }
  }, NATIVE_POSTGRES_TEST_TIMEOUT);
  afterAll(closeNativePostgres);

  it("returns the same rows in the same order for every search read", async () => {
    const [first, ...others] = providers;
    const expected = await everyRead(first!.db);
    // The corpus exercises what it claims: matches, misses and relevance.
    expect(expected["site leather"]).toEqual([["p11", "p01", "p02", "p12"], ["cat_bags"], ["pg_ship"]]);
    expect(expected["site চামড়া"]).toEqual([["p04"], [], []]);
    expect(expected["site zzz"]).toEqual([[], [], []]);
    expect(expected["admin products rs-200"]).toEqual(["p06"]);
    expect(expected["orders 01712"]).toEqual(["ord_a"]);
    for (const provider of others) expect(await everyRead(provider.db), provider.name).toEqual(expected);
  });

  // The local engine does not run the catalog projections' SQL (compound and
  // scalar subqueries in its window functions): it runs the search SQL alone.
  it("runs the search index's SQL on the Turso engine with D1's matches and order", async () => {
    const engine = createTursoEngineDatabase(await tursoEngineStoreFrom(tursoSqlite));
    const expected = await indexReads(d1);
    expect(expected["products leather"]!.map((row) => row.split(" ")[0])).toEqual(["p13", "p11", "p01", "p02", "p12"]);
    expect(await indexReads(engine)).toEqual(expected);
    for (const provider of providers.slice(1)) expect(await indexReads(provider.db), provider.name).toEqual(expected);
  });
});
