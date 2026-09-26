import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { DEPENDENCY_CACHE_RETENTION_SECONDS } from "@scalius/shared/cache-frontier";
import { preloadedPlatformSettings } from "./runtime/public-render-context";
import { deps as cacheDeps } from "@scalius/core/cache-deps";
import {
  createPublicPartReader,
  decodeDvcEntryMeta,
  encodeDvcEntry,
  judgeDvcEntries,
  maskedDepsSummary,
  type DvcEntryMeta,
  type PublicPartReaderDeps,
} from "./public-read";

class MemoryCache {
  readonly entries = new Map<string, Response>();
  readonly deleted: string[] = [];
  readonly puts: string[] = [];
  async match(key: RequestInfo | URL) {
    return this.entries.get(String(key))?.clone();
  }
  async put(key: RequestInfo | URL, response: Response) {
    this.puts.push(String(key));
    this.entries.set(String(key), response);
  }
  async delete(key: RequestInfo | URL) {
    this.deleted.push(String(key));
    return this.entries.delete(String(key));
  }
}

/** A cacheable public read, as renderPublicRead decorates one. */
function ours(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=0, no-cache, must-revalidate", "Cloudflare-CDN-Cache-Control": "no-store", "CDN-Cache-Control": "no-store" },
  });
}

function reader(overrides: Partial<PublicPartReaderDeps> & { db: () => Database }) {
  const waits: Promise<unknown>[] = [];
  const cache = new MemoryCache();
  const log = vi.fn<(line: string) => void>();
  const deps: PublicPartReaderDeps = {
    mode: "strict",
    env: { CF_VERSION_METADATA: { id: "version-a" } },
    cache,
    render: async () => ours('{"v":1}'),
    waitUntil: (promise) => void waits.push(promise),
    maxConcurrentRenders: 4,
    random: () => 1,
    log,
    ...overrides,
  };
  const read = async (paths: string[]) => {
    const settled = await createPublicPartReader(deps).readParts(paths.map((path) => new Request(`https://api.internal${path}`)), null);
    const parts = await Promise.all(settled.map(async (result) => {
      if (result.status === "rejected") return { error: String(result.reason) };
      return { headers: result.value.response.headers, status: result.value.response.status, body: await result.value.response.text(), cache: result.value.cache };
    }));
    await Promise.all(waits.splice(0));
    return parts;
  };
  return { read, cache, log };
}

const meta = (overrides: Partial<DvcEntryMeta> = {}): DvcEntryMeta => ({
  s0: 10, deps: ["p:a", "store"], validUntil: null, softMaxAgeSeconds: null, renderedAt: 1_000, ...overrides,
});

describe("dependency-validated entries", () => {
  it("round-trip their metadata and never validate a truncated key list", async () => {
    const stored = encodeDvcEntry(ours("{}"), meta({ validUntil: 5_000, softMaxAgeSeconds: 600 }))!;
    expect(decodeDvcEntryMeta(stored)).toEqual(meta({ validUntil: 5_000, softMaxAgeSeconds: 600 }));

    const truncated = new Headers(stored.headers);
    truncated.set("X-Scalius-Deps", "store");
    expect(decodeDvcEntryMeta(new Response("{}", { headers: truncated }))).toBeNull();
    const withoutStore = new Headers(stored.headers);
    withoutStore.set("X-Scalius-Deps", "p:a p:b");
    expect(decodeDvcEntryMeta(new Response("{}", { headers: withoutStore }))).toBeNull();
    expect(encodeDvcEntry(ours("{}"), meta({ deps: Array.from({ length: 900 }, (_, index) => `p:${"x".repeat(20)}${index}`) }))).toBeNull();
  });

  it("are served only when no key moved after s0, before validUntil and the soft age, and above the floor", () => {
    const snapshot = { S: 20, floor: 0, changed: new Map([["p:a", 15], ["p:b", 9]]) };
    expect(judgeDvcEntries([
      meta(),
      meta({ deps: ["p:b", "store"] }),
      meta({ deps: ["p:b", "store"], validUntil: 2_000 }),
      meta({ deps: ["p:b", "store"], softMaxAgeSeconds: 1 }),
    ], snapshot, 2_000)).toEqual([
      { valid: false, reason: "changed", keys: ["p:a"] },
      { valid: true, s0: 20 },
      { valid: false, reason: "expired" },
      { valid: false, reason: "soft-age" },
    ]);
    expect(judgeDvcEntries([meta({ deps: ["store"] })], { ...snapshot, floor: 11 }, 0)).toEqual([{ valid: false, reason: "floor" }]);
  });

  it("rejects a proof ahead of the authoritative clock without changing the frontier rule", () => {
    expect(judgeDvcEntries([meta({ s0: 21 })], { S: 20, floor: 0, changed: new Map() }, 2_000))
      .toEqual([{ valid: false, reason: "future" }]);
    expect(judgeDvcEntries([meta({ s0: 20 })], { S: 20, floor: 0, changed: new Map() }, 2_000))
      .toEqual([{ valid: true, s0: 20 }]);
  });

  it("log only key kinds, never ids", () => {
    expect(maskedDepsSummary(["p:secret-id", "p:other", "set:seo:document", "store"])).toBe("p:2 set:1 store:1");
  });
});

describe("strict part reader", () => {
  it("reads one authoritative Platform snapshot before every all-miss batch", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.prepare("INSERT INTO settings (id, category, key, value, type, revision) VALUES ('platform', 'platform', 'document', ?, 'json', 1)")
      .run(JSON.stringify({ storefrontUrl: "https://before.example" }));
    const all = vi.spyOn(db, "all");
    const { read } = reader({ db: () => db, render: async () => ours(preloadedPlatformSettings()!.storefrontUrl) });
    const first = await read(["/api/v1/shipping-methods"]);
    expect(all).toHaveBeenCalledTimes(1);
    expect(first[0]!.body).toBe("https://before.example");
    sqlite.prepare("UPDATE settings SET value = ?, revision = revision + 1 WHERE id = 'platform'")
      .run(JSON.stringify({ storefrontUrl: "https://after.example" }));
    all.mockClear();
    const second = await read(["/api/v1/locations", "/api/v1/products/new-url"]);
    expect(all).toHaveBeenCalledTimes(1);
    expect(second.map((part) => part.body)).toEqual(["https://after.example", "https://after.example"]);
    expect(second[0]!.cache!.s0).toBeGreaterThan(first[0]!.cache!.s0);
  });

  it("serves a validated hit with one statement for the whole batch, and re-renders a part whose key moved", async () => {
    const { db, sqlite } = createSqliteD1Database();
    let version = 1;
    const { read } = reader({
      db: () => db,
      render: async (request) => {
        if (new URL(request.url).pathname.endsWith("/a")) cacheDeps.product("a");
        return ours(`{"v":${version}}`);
      },
    });
    await read(["/api/v1/products/a", "/api/v1/products/b"]);
    const all = vi.spyOn(db, "all");

    const hits = await read(["/api/v1/products/a", "/api/v1/products/b"]);
    expect(hits.map((part) => part.cache?.status)).toEqual(["hit", "hit"]);
    expect(all).toHaveBeenCalledTimes(1);

    version = 2;
    const moved = hits[0]!.cache!.s0 + 50;
    sqlite.prepare("INSERT INTO cache_dep (dep, seq) VALUES ('p:a', ?) ON CONFLICT (dep) DO UPDATE SET seq = excluded.seq").run(moved);
    const after = await read(["/api/v1/products/a", "/api/v1/products/b"]);
    expect(after.map((part) => [part.cache?.status, part.body])).toEqual([["refresh", '{"v":2}'], ["hit", '{"v":1}']]);
    expect(after[0]!.cache!.s0).toBe(moved);
  });

  it("cannot fill a new cache entry or serve an old one when the clock is missing", async () => {
    const { db, sqlite } = createSqliteD1Database();
    const render = vi.fn(async () => ours("cached"));
    const { read, cache } = reader({ db: () => db, render });
    await read(["/api/v1/products/a"]);
    cache.puts.length = 0;
    sqlite.exec("DELETE FROM cache_clock WHERE id = 1");
    expect(await read(["/api/v1/products/a", "/api/v1/products/new"]))
      .toEqual([{ error: "Error: Cache clock unavailable" }, { error: "Error: Cache clock unavailable" }]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(cache.puts).toEqual([]);
  });

  it("does not store a render that declared a fact no key can validate", async () => {
    const { db } = createSqliteD1Database();
    const { read } = reader({
      db: () => db,
      render: async () => {
        cacheDeps.uncacheable("live-provider");
        return ours("{}");
      },
    });
    expect((await read(["/api/v1/products/a"]))[0]!.cache).toBeNull();
    expect((await read(["/api/v1/products/a"]))[0]!.cache).toBeNull();
  });

  it("fails closed on validation outages, including expired scheduled content and new URLs", async () => {
    const { db } = createSqliteD1Database();
    let now = 1_000;
    let down = false;
    const render = vi.fn(async () => { cacheDeps.validUntil(2_000); return ours("scheduled"); });
    const { read } = reader({
      db: () => { if (down) throw new Error("database down"); return db; },
      now: () => now,
      render,
    });
    await read(["/api/v1/products/a", "/api/v1/checkout/config"]);
    down = true;
    for (now of [1_500, 2_000, 1_000_000]) {
      const outage = await read(["/api/v1/products/a", "/api/v1/checkout/config", "/api/v1/products/new"]);
      expect(outage).toEqual(Array.from({ length: 3 }, () => ({ error: "Error: database down" })));
    }
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("retains unchanged aged content without rewriting it when unrelated clock entries advance", async () => {
    const { db, sqlite } = createSqliteD1Database();
    let now = 1_000;
    const render = vi.fn(async () => { cacheDeps.product("a"); return ours("unchanged"); });
    const { read, cache } = reader({ db: () => db, now: () => now, render });
    await read(["/api/v1/products/a"]);
    const key = "https://api.internal/api/v1/products/a?__cv=version-a";
    expect(cache.entries.get(key)!.headers.get("Cache-Control")).toBe(`public, max-age=${DEPENDENCY_CACHE_RETENTION_SECONDS}`);
    expect(cache.entries.get(key)!.headers.has("Cloudflare-CDN-Cache-Control")).toBe(false);
    expect(cache.entries.get(key)!.headers.has("CDN-Cache-Control")).toBe(false);
    cache.puts.length = 0;
    now += 2 * 86_400_000;
    const aged = await read(["/api/v1/products/a"]);
    expect(aged[0]).toMatchObject({ body: "unchanged", cache: { status: "hit", apiVersion: "version-a" } });
    expect(aged[0]!.headers!.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(aged[0]!.headers!.get("CDN-Cache-Control")).toBe("no-store");
    expect(cache.puts).toEqual([]);
    sqlite.prepare("INSERT INTO cache_dep (dep, seq) VALUES ('p:unrelated', ?)").run(aged[0]!.cache!.s0 + 5);
    const advanced = await read(["/api/v1/products/a"]);
    expect(advanced[0]).toMatchObject({ body: "unchanged", cache: { status: "hit", s0: aged[0]!.cache!.s0 + 5 } });
    expect(cache.puts).toEqual([]);
    expect(decodeDvcEntryMeta(cache.entries.get(key)!)!.s0).toBe(aged[0]!.cache!.s0);
    await read(["/api/v1/products/a"]);
    expect(cache.puts).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("refreshes scheduled content exactly at its boundary despite long retention", async () => {
    const { db } = createSqliteD1Database();
    let now = 1_000;
    const render = vi.fn(async () => { if (now < 2_000) cacheDeps.validUntil(2_000); return ours(now < 2_000 ? "before" : "after"); });
    const { read } = reader({ db: () => db, now: () => now, render });
    await read(["/api/v1/products/a"]);
    now = 1_999;
    expect((await read(["/api/v1/products/a"]))[0]).toMatchObject({ body: "before", cache: { status: "hit" } });
    now = 2_000;
    expect((await read(["/api/v1/products/a"]))[0]).toMatchObject({ body: "after", cache: { status: "refresh" } });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("audits a sampled hit: a different fresh render with no key moved evicts the entry and logs it, masked", async () => {
    const { db } = createSqliteD1Database();
    let body = '{"v":1}';
    const { read, cache, log } = reader({ db: () => db, random: () => 0, render: async () => ours(body) });
    await read(["/api/v1/products/a?utm=secret-value"]);

    body = '{"v":2}';
    const hit = await read(["/api/v1/products/a?utm=secret-value"]);

    expect(hit[0]!.cache?.status).toBe("hit");
    expect(cache.deleted).toEqual(["https://api.internal/api/v1/products/a?utm=secret-value&__cv=version-a"]);
    const lines = log.mock.calls.map(([line]) => line).filter((line) => line.startsWith("[CacheAudit]"));
    expect(lines).toEqual(["[CacheAudit] stale /api/v1/products/a store:1"]);
  });
});
