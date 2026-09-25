/**
 * The workload of the DVC load driver (scripts/cache-dvc-load.test.ts, which
 * owns setup, metering and the provider): Zipf page views through a model of
 * the DVC API part cache, mixed with buyer-visible writes, measuring hit
 * ratio, miss and validation latency, rows per phase and trigger write
 * amplification (CACHE-DESIGN §4, §7 item 8). Lives here so it resolves the
 * API's own dependencies.
 */
import { eq, sql as drizzleSql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { withDependencyScope } from "@scalius/core/cache-deps";
import * as products from "@scalius/core/modules/products";
import * as inventory from "@scalius/core/modules/inventory";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import { connectPostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import { createPublicPartReader, renderPublicRead } from "../../public-read";

/** Drizzle over a (metered) D1 binding, as the API builds it. */
export function d1Database(binding: D1Database): Database {
  return drizzle(binding, { schema }) as unknown as Database;
}

/** The PostgreSQL adapter over a local server. */
export function postgresDatabase(url: string): Database {
  return createPostgresDatabase(url, { connect: connectPostgres });
}

export interface PhaseMeter { statements: number; rowsRead: number; rowsWritten: number; ms: number }

export interface LoadContext {
  readonly provider: "d1" | "postgres";
  readonly env: Env;
  readonly db: Database;
  sql(text: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
  setPhase(name: string): void;
  meter(): PhaseMeter;
  readonly phases: Record<string, PhaseMeter>;
  postgresActivity?: () => Promise<{ read: number; written: number }>;
}

export interface LoadOptions {
  readonly reads: number;
  readonly readsPerWrite: number;
  readonly seed: number;
  /**
   * The part cache under load:
   * - `model` (default): the driver's own model of §6.6;
   * - `strict`: S4's production reader (`createPublicPartReader`, strict),
   *   one batch per page view, over an in-memory Cache API;
   * - `generation`: today's store-wide generation (every write empties it).
   */
  readonly mode?: "model" | "strict" | "generation";
}

// ---------------------------------------------------------------------------
// Workload

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zipf(s) sampler over ranks 0..n-1 by inverse CDF on a precomputed table. */
function zipf(n: number, s: number, random: () => number): () => number {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let rank = 0; rank < n; rank += 1) {
    total += 1 / (rank + 1) ** s;
    cdf[rank] = total;
  }
  return () => {
    const target = random() * total;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cdf[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 100) / 100;
};

interface Entry { body: string; s0: number; deps: readonly string[]; validUntil: number | null; softMaxAgeSeconds: number | null; renderedAt: number }

export async function runDvcLoad(context: LoadContext, options: LoadOptions): Promise<Record<string, unknown>> {
  const random = rng(options.seed);

  // Projections: the seed writes none. A rebuild coalesces to `store`.
  context.setPhase("setup");
  const hasState = Number((await context.sql("SELECT count(*) AS n FROM product_buyer_state", []))[0]!.n);
  if (hasState === 0) {
    let after: string | null = null;
    for (;;) {
      const result = await products.rebuildCatalogProjections(context.db, { afterProductId: after, limit: 2_700 });
      if (result.done) break;
      after = result.nextAfterProductId;
    }
  }
  const productRows = await context.sql("SELECT p.id AS id, p.slug AS slug FROM products p JOIN product_buyer_state s ON s.product_id = p.id WHERE s.is_public = 1 ORDER BY p.id", []);
  const categoryRows = await context.sql("SELECT slug FROM categories WHERE status = 'published' AND deleted_at IS NULL ORDER BY id", []);
  const variantRows = await context.sql("SELECT id, product_id FROM product_variants WHERE deleted_at IS NULL AND track_inventory = 1 ORDER BY id", []);
  if (productRows.length === 0) throw new Error("No public products: seed the store first.");
  const pickProduct = zipf(productRows.length, 1.1, random);
  const pickCategory = zipf(categoryRows.length, 1.1, random);
  const pickVariant = zipf(variantRows.length, 1.0, random);
  const searchTerms = ["laptop", "phone", "monitor", "ssd", "watch", "camera", "router", "mouse"];

  const shell = ["/api/v1/storefront/layout", "/api/v1/shipping-methods", "/api/v1/checkout/config"];
  const pageParts = (): { type: string; parts: string[] } => {
    const roll = random();
    if (roll < 0.6) return { type: "product", parts: [...shell, `/api/v1/products/${productRows[pickProduct()]!.slug}`] };
    if (roll < 0.85) {
      const sort = random() < 0.7 ? "newest" : "price-asc";
      return { type: `category-${sort}`, parts: [shell[0]!, `/api/v1/categories/${categoryRows[pickCategory()]!.slug}/products?page=1&limit=24&sort=${sort}`] };
    }
    if (roll < 0.95) return { type: "home", parts: [...shell, "/api/v1/storefront/homepage"] };
    return { type: "search", parts: [shell[0]!, `/api/v1/products?page=1&limit=24&search=${searchTerms[Math.floor(random() * searchTerms.length)]}`] };
  };

  const cache = new Map<string, Entry>();
  const byType: Record<string, { views: number; parts: number; hits: number; misses: number }> = {};
  const missMs: Record<string, number[]> = {};
  const validateMs: number[] = [];
  const hitPageMs: number[] = [];
  const amplification: Record<string, { writes: number; keys: number[]; rows: number[]; ms: number[] }> = {};
  let now = Date.now();
  const clock = async () => Number((await context.sql("SELECT seq FROM cache_clock WHERE id = 1", []))[0]!.seq);

  const render = async (path: string): Promise<{ status: number; entry: Entry }> => {
    const s0 = await clock();
    const request = new Request(`https://api.internal${path}`, { headers: { Accept: "application/json" } });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise.catch(() => undefined)), passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const { value, dependencies } = await withDependencyScope(async () => {
      const response = await renderPublicRead(request, context.env, ctx);
      const text = await response.text();
      return { status: response.status, text };
    }, { label: path, log: () => undefined });
    await Promise.all(waits);
    return {
      status: value.status,
      entry: { body: value.text, s0, deps: dependencies.keys, validUntil: dependencies.validUntil, softMaxAgeSeconds: dependencies.softMaxAgeSeconds, renderedAt: now },
    };
  };

  const mode = options.mode ?? "model";
  const partCache = new Map<string, Response>();
  const generationCache = new Map<string, { status: number; body: string }>();
  const memoryCache = {
    async match(key: RequestInfo | URL) {
      return partCache.get(String(key))?.clone();
    },
    async put(key: RequestInfo | URL, response: Response) {
      partCache.set(String(key), new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
    },
    async delete(key: RequestInfo | URL) {
      return partCache.delete(String(key));
    },
  };
  const loadEnv = { ...(context.env as unknown as Record<string, unknown>), CF_VERSION_METADATA: { id: "dvc-load", tag: "", timestamp: "" } } as unknown as Env;

  /** One page view through S4's strict reader: one batch, one validation statement at most. */
  const strictView = async (page: { type: string; parts: string[] }, stats: { parts: number; hits: number; misses: number }) => {
    const started = performance.now();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise.catch(() => undefined)), passThroughOnException: () => undefined } as unknown as ExecutionContext;
    let summary: { hits: number; misses: number; refreshes: number; validationMs: number | null } | null = null;
    context.setPhase(`strict:${page.type}`);
    const reader = createPublicPartReader({
      mode: "strict",
      env: loadEnv,
      cache: memoryCache,
      db: () => context.db,
      render: (part) => renderPublicRead(part, loadEnv, ctx),
      waitUntil: (promise) => void waits.push(promise.catch(() => undefined)),
      maxConcurrentRenders: 4,
      now: () => now,
      random: () => 1,
      log: () => undefined,
      onSummary: (each) => {
        summary = { ...each };
      },
    });
    const settled = await reader.readParts(page.parts.map((path) => new Request(`https://api.internal${path}`, { headers: { Accept: "application/json" } })), null);
    for (const result of settled) if (result.status === "fulfilled") await result.value.response.text();
    const elapsed = performance.now() - started;
    await Promise.all(waits);
    const done = summary as { hits: number; misses: number; refreshes: number; validationMs: number | null } | null;
    stats.parts += page.parts.length;
    stats.hits += done?.hits ?? 0;
    stats.misses += page.parts.length - (done?.hits ?? 0);
    if (done?.validationMs !== null && done?.validationMs !== undefined) validateMs.push(done.validationMs);
    if (done && done.hits === page.parts.length) hitPageMs.push(elapsed);
    else (missMs[page.type] ??= []).push(elapsed);
  };

  /** Today: parts keyed by one store-wide generation, which every buyer-visible write replaces. */
  const generationView = async (page: { type: string; parts: string[] }, stats: { parts: number; hits: number; misses: number }) => {
    const started = performance.now();
    let missed = false;
    context.setPhase(`generation:${page.type}`);
    await Promise.all(page.parts.map(async (path) => {
      stats.parts += 1;
      if (generationCache.has(path)) {
        stats.hits += 1;
        return;
      }
      missed = true;
      stats.misses += 1;
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise.catch(() => undefined)), passThroughOnException: () => undefined } as unknown as ExecutionContext;
      const response = await renderPublicRead(new Request(`https://api.internal${path}`, { headers: { Accept: "application/json" } }), context.env, ctx);
      const body = await response.text();
      await Promise.all(waits);
      if (response.status === 200) generationCache.set(path, { status: 200, body });
    }));
    if (!missed) hitPageMs.push(performance.now() - started);
    else (missMs[page.type] ??= []).push(performance.now() - started);
  };

  const view = async () => {
    if (mode !== "model") {
      const page = pageParts();
      const stats = (byType[page.type] ??= { views: 0, parts: 0, hits: 0, misses: 0 });
      stats.views += 1;
      return mode === "strict" ? strictView(page, stats) : generationView(page, stats);
    }
    const page = pageParts();
    const stats = (byType[page.type] ??= { views: 0, parts: 0, hits: 0, misses: 0 });
    stats.views += 1;
    const started = performance.now();
    const cached = page.parts.map((path) => cache.get(path));
    const present = cached.filter((entry): entry is Entry => entry !== undefined);
    const valid = new Set<string>();
    if (present.length > 0) {
      context.setPhase("validate");
      const began = performance.now();
      const union = [...new Set(present.flatMap((entry) => entry.deps))];
      const minS0 = Math.min(...present.map((entry) => entry.s0));
      const json = context.provider === "postgres" ? "SELECT jsonb_array_elements_text(?::jsonb)" : "SELECT value FROM json_each(?)";
      const rows = await context.sql(`SELECT d.dep AS dep, d.seq AS seq, c.seq AS s FROM cache_clock c LEFT JOIN cache_dep d ON d.seq > ? AND d.dep IN (${json}) WHERE c.id = 1`, [minS0, JSON.stringify(union)]);
      const changed = new Map(rows.filter((row) => row.dep !== null).map((row) => [String(row.dep), Number(row.seq)]));
      const S = Number(rows[0]?.s ?? 0);
      validateMs.push(performance.now() - began);
      page.parts.forEach((path, index) => {
        const entry = cached[index];
        if (!entry) return;
        if (entry.validUntil !== null && now >= entry.validUntil) return;
        if (entry.softMaxAgeSeconds !== null && now - entry.renderedAt >= entry.softMaxAgeSeconds * 1000) return;
        if (entry.deps.some((dep) => (changed.get(dep) ?? -1) > entry.s0)) return;
        entry.s0 = Math.max(entry.s0, S);
        valid.add(path);
      });
    }
    let missed = false;
    for (const path of page.parts) {
      stats.parts += 1;
      if (valid.has(path)) {
        stats.hits += 1;
        continue;
      }
      missed = true;
      stats.misses += 1;
      context.setPhase(`render:${page.type}`);
      const began = performance.now();
      const { status, entry } = await render(path);
      (missMs[page.type] ??= []).push(performance.now() - began);
      if (status === 200) cache.set(path, entry);
    }
    if (!missed) hitPageMs.push(performance.now() - started);
  };

  type WriteKind = "price" | "band" | "content" | "membership" | "settings";
  const write = async () => {
    const roll = random();
    const kind: WriteKind = roll < 0.3 ? "price" : roll < 0.6 ? "band" : roll < 0.9 ? "content" : roll < 0.98 ? "membership" : "settings";
    context.setPhase(`write:${kind}`);
    const before = await clock();
    const writeMeterRef = context.meter();
    const writeMeter = { ...writeMeterRef };
    const pgBefore = context.postgresActivity ? await context.postgresActivity() : null;
    const began = performance.now();
    const variant = variantRows[pickVariant()]!;
    const product = productRows[pickProduct()]!;
    if (kind === "price") {
      await context.db.batch([
        context.db.update(schema.productVariants).set({ priceMinor: drizzleSql`price_minor + 100` }).where(eq(schema.productVariants.id, String(variant.id))),
        ...products.catalogProjectionRefreshStatements(context.db, [String(variant.product_id)]),
      ] as never);
    } else if (kind === "band") {
      const [row] = await context.sql("SELECT stock - reserved_stock AS available FROM product_variants WHERE id = ?", [variant.id]);
      const available = Number(row?.available ?? 0);
      const target = [0, 1, 2, 5, 20][Math.floor(random() * 5)]!;
      if (target !== available) {
        await inventory.adjustStock(context.db, String(variant.id), target - available, `dvc-load-${Math.floor(random() * 1e12).toString().padStart(12, "0")}`, "dvc load");
      }
    } else if (kind === "content") {
      await context.sql("UPDATE products SET description = coalesce(description, '') || ' ' WHERE id = ?", [product.id]);
    } else if (kind === "membership") {
      const [row] = await context.sql("SELECT aggregate_revision AS revision, is_active AS active FROM products WHERE id = ?", [product.id]);
      await products.bulkUpdateProducts(context.db, [{ id: String(product.id), expectedAggregateRevision: Number(row!.revision) }], { isActive: Number(row!.active) === 0 });
    } else {
      // A settings document save (the catalogue seed has none, so the first one inserts).
      await context.sql(
        "INSERT INTO settings (id, key, value, type, category) VALUES ('dvc_load_seo', 'document', ?, 'json', 'seo') ON CONFLICT (id) DO UPDATE SET value = excluded.value",
        [JSON.stringify({ homepageTitle: "Load store", homepageMetaDescription: `Load ${Math.floor(random() * 1e6)}`, socialImage: "", discovery: {}, returnPolicy: {} })],
      );
    }
    const ms = performance.now() - began;
    generationCache.clear();
    context.setPhase("harness");
    const keys = Number((await context.sql("SELECT count(*) AS n FROM cache_dep WHERE seq > ?", [before]))[0]!.n);
    const after = writeMeterRef;
    const rows = context.postgresActivity && pgBefore ? (await context.postgresActivity()).written - pgBefore.written : after.rowsWritten - writeMeter.rowsWritten;
    const stat = (amplification[kind] ??= { writes: 0, keys: [], rows: [], ms: [] });
    stat.writes += 1;
    stat.keys.push(keys);
    stat.rows.push(rows);
    stat.ms.push(ms);
  };

  // Bulk amplification (CACHE-DESIGN §11): one 90-product unpublish and its
  // restore, each one batch; S1 measured 1,170 key writes for the unpublish.
  const bulk: Record<string, { keysAdvanced: number; rowsWritten: number; ms: number }> = {};
  {
    const chosen = productRows.slice(0, 90).map((row) => String(row.id));
    for (const [label, active] of [["unpublish90", false], ["republish90", true]] as const) {
      const claims = [];
      for (const id of chosen) {
        const [row] = await context.sql("SELECT aggregate_revision AS revision FROM products WHERE id = ?", [id]);
        claims.push({ id, expectedAggregateRevision: Number(row!.revision) });
      }
      context.setPhase(`bulk:${label}`);
      const phaseMeter = context.meter();
      const writtenBefore = context.postgresActivity ? (await context.postgresActivity()).written : phaseMeter.rowsWritten;
      const before = await clock();
      const began = performance.now();
      await products.bulkUpdateProducts(context.db, claims, { isActive: active });
      const ms = performance.now() - began;
      const writtenAfter = context.postgresActivity ? (await context.postgresActivity()).written : phaseMeter.rowsWritten;
      context.setPhase("harness");
      const keys = Number((await context.sql("SELECT count(*) AS n FROM cache_dep WHERE seq > ?", [before]))[0]!.n);
      bulk[label] = { keysAdvanced: keys, rowsWritten: writtenAfter - writtenBefore, ms: Math.round(ms) };
    }
  }

  const wallStarted = performance.now();
  const pgStart = context.postgresActivity ? await context.postgresActivity() : null;
  for (let index = 0; index < options.reads; index += 1) {
    now += 10; // 100 page views per simulated second
    await view();
    if (index % options.readsPerWrite === options.readsPerWrite - 1) await write();
    if (index % 1000 === 999) {
      const parts = Object.values(byType).reduce((sum, stats) => sum + stats.parts, 0);
      const hits = Object.values(byType).reduce((sum, stats) => sum + stats.hits, 0);
      console.error(`[DVC load progress] ${index + 1}/${options.reads} views, part hit ratio ${(hits / Math.max(1, parts)).toFixed(3)}, ${Math.round((performance.now() - wallStarted) / 1000)}s`);
    }
  }
  const pgEnd = context.postgresActivity ? await context.postgresActivity() : null;
  const cacheDepRows = Number((await context.sql("SELECT count(*) AS n FROM cache_dep", []))[0]!.n);

  const report = {
    provider: context.provider,
    mode,
    catalogue: { publicProducts: productRows.length, categories: categoryRows.length, trackedSkus: variantRows.length },
    workload: { pageViews: options.reads, readsPerWrite: options.readsPerWrite, simulatedSeconds: options.reads / 100 },
    wallSeconds: Math.round((performance.now() - wallStarted) / 100) / 10,
    hitRatio: Object.fromEntries(Object.entries(byType).map(([type, stats]) => [type, { ...stats, partHitRatio: Math.round((stats.hits / Math.max(1, stats.parts)) * 1000) / 1000 }])),
    missLatencyMs: Object.fromEntries(Object.entries(missMs).map(([type, values]) => [type, { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99) }])),
    validateLatencyMs: { n: validateMs.length, p50: percentile(validateMs, 50), p95: percentile(validateMs, 95), p99: percentile(validateMs, 99) },
    allHitPageMs: { n: hitPageMs.length, p50: percentile(hitPageMs, 50), p95: percentile(hitPageMs, 95) },
    writeAmplification: Object.fromEntries(Object.entries(amplification).map(([kind, stat]) => [kind, {
      writes: stat.writes,
      keysAdvanced: { mean: Math.round((stat.keys.reduce((a, b) => a + b, 0) / stat.writes) * 10) / 10, p95: percentile(stat.keys, 95), max: Math.max(...stat.keys) },
      rowsWritten: { mean: Math.round((stat.rows.reduce((a, b) => a + b, 0) / stat.writes) * 10) / 10, p95: percentile(stat.rows, 95) },
      writeMs: { p50: percentile(stat.ms, 50), p95: percentile(stat.ms, 95) },
    }])),
    databasePhases: context.provider === "d1" ? context.phases : { rowsRead: (pgEnd?.read ?? 0) - (pgStart?.read ?? 0), rowsWritten: (pgEnd?.written ?? 0) - (pgStart?.written ?? 0) },
    bulkAmplification: bulk,
    cacheDepRows,
  };
  return report;
}
