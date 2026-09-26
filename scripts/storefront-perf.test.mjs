import { forceCacheRefresh } from "./storefront-fidelity/lib/theme.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertLocalInvalidation, classifyTimings, forceMiss, FORCE_MISS_SQL, localDatabaseId, parseArgs, withSeenSeq, DEFAULT_BUDGETS, bindingCheckTarget, discoverPaths, evaluateBudgets, isLocalBase, median } from "./storefront-perf.mjs";

describe("storefront perf check", () => {
  it("finds a category and a product on the home page", () => {
    const html = `<a href="/about">About</a><a href="/categories/bags?sort=new">Bags</a>
      <a href="/products/linen-shirt">Linen</a><a href="/products/other">Other</a>`;

    expect(discoverPaths(html)).toEqual(["/", "/categories/bags", "/products/linen-shirt", "/search?q=a", "/cart"]);
    expect(discoverPaths("<p>empty store</p>")).toEqual(["/", "/search?q=a", "/cart"]);
  });

  it("takes the median of the finite samples", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, null, 40, 30])).toBe(25);
    expect(median([])).toBeNull();
  });

  it("judges cached pages on hit and miss TTFB and every page on LCP and CLS", () => {
    const fast = {
      path: "/", cacheable: true, ttfbHit: 20, ttfbMiss: 250,
      phone: { lcp: 1400, cls: 0 }, desktop: { lcp: 900, cls: 0.02 },
    };
    expect(evaluateBudgets(fast)).toEqual([]);

    const slow = {
      path: "/products/x", cacheable: true, ttfbHit: 80, ttfbMiss: 900,
      phone: { lcp: 5500, cls: 0.2 }, desktop: { lcp: 1100, cls: 0 },
    };
    expect(evaluateBudgets(slow)).toEqual([
      "/products/x: ttfb hit ms 80 > 50",
      "/products/x: ttfb miss ms 900 > 300",
      "/products/x: phone LCP ms 5500 > 1500",
      "/products/x: phone CLS 0.2 > 0.1",
    ]);
  });

  it("fails a page whose first response is a server error", () => {
    const row = { path: "/", status: 503, cacheable: true, ttfbHit: 10, ttfbMiss: null, phone: null, desktop: null };

    expect(evaluateBudgets(row)).toEqual(["/: first response status 503"]);
  });

  it("subtracts the edge round trip only for remote bases", () => {
    expect(isLocalBase("http://localhost:4391")).toBe(true);
    expect(isLocalBase("http://127.0.0.1:4322")).toBe(true);
    expect(isLocalBase("https://storefront.scalius.com")).toBe(false);
    expect(isLocalBase("https://localhost.example.com")).toBe(false);
  });

  it("holds an always-rendered page to the miss budget", () => {
    const cart = { path: "/cart", cacheable: false, ttfbHit: 280, ttfbMiss: null, phone: null, desktop: null };

    expect(evaluateBudgets(cart)).toEqual([]);
    expect(evaluateBudgets({ ...cart, ttfbHit: DEFAULT_BUDGETS.ttfbMissMs + 1 })).toHaveLength(1);
  });

  it("checks a local storefront's binding before measuring, never a remote one", () => {
    expect(bindingCheckTarget({ base: "http://localhost:4601" })).toEqual({ storefrontUrl: "http://localhost:4601" });
    expect(bindingCheckTarget({ base: "http://localhost:4601", mediaUrl: "http://localhost:9001/api/v1/media" }))
      .toEqual({ storefrontUrl: "http://localhost:4601", mediaUrl: "http://localhost:9001/api/v1/media" });
    expect(bindingCheckTarget({ base: "https://storefront.scalius.com" })).toBeNull();
    expect(bindingCheckTarget({ base: "http://localhost:4601", bindingCheck: false })).toBeNull();
  });
});


describe("dependency-cache cold measurement", () => {
  it("rejects remote and ambiguous explorer origins before fetching", async () => {
    const fetcher = vi.fn();
    for (const origin of ["https://example.com", "http://localhost.evil:8797", "http://localhost:8797/path", "http://user@localhost:8797", "http://localhost:8797?next=remote"]) {
      await expect(forceMiss("http://localhost:4332", origin, fetcher)).rejects.toThrow("loopback-only");
    }
    await expect(forceMiss("https://shop.example", "http://localhost:8797", fetcher)).rejects.toThrow("loopback-only");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => assertLocalInvalidation("http://127.0.0.1:4332", "http://[::1]:8797")).not.toThrow();
    expect(() => parseArgs(["--kv-explorer", "http://localhost:8797"])).toThrow("retired");
  });

  it("uses the installed explorer raw contract and returns its committed sequence", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, result: [{ success: true, results: { columns: ["seq"], rows: [[43]] } }] }));
    expect(await forceMiss("http://localhost:4332", "http://localhost:8797", fetcher)).toBe(43);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(`http://localhost:8797/cdn-cgi/local/explorer/api/d1/database/${localDatabaseId()}/raw`);
    expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body)).toEqual({ sql: FORCE_MISS_SQL });
    expect(withSeenSeq("http://localhost:4332/search?q=bag", 43)).toBe("http://localhost:4332/search?q=bag&_sv=43");
  });

  it("advances store and clock atomically using the installed schema triggers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const migration = readFileSync(new URL("../packages/database/migrations/0100_cache_dependencies.sql", import.meta.url), "utf8");
      db.exec(migration.slice(0, migration.indexOf("CREATE TRIGGER `cdep_products_ins`")));
      expect(forceCacheRefresh({ db })).toBe(1);
      expect(forceCacheRefresh({ db })).toBe(2);
      expect(db.prepare("SELECT seq FROM cache_clock WHERE id = 1").get().seq).toBe(2);
      db.exec("CREATE TRIGGER reject_clock BEFORE UPDATE ON cache_clock BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
      expect(() => db.prepare(FORCE_MISS_SQL).get()).toThrow("test rollback");
      expect(db.prepare("SELECT seq FROM cache_dep WHERE dep = 'store'").get().seq).toBe(2);
      expect(db.prepare("SELECT seq FROM cache_clock WHERE id = 1").get().seq).toBe(2);
    } finally { db.close(); }
  });

  it("fails closed on an explorer error or missing sequence", async () => {
    for (const payload of [{ success: false }, { success: true, result: [{ success: true, results: { columns: ["seq"], rows: [] } }] }]) {
      await expect(forceMiss("http://localhost:4332", "http://localhost:8797", async () => Response.json(payload))).rejects.toThrow("no valid commit sequence");
    }
  });

  it("never labels forced HIT as MISS and excludes render samples from hit TTFB", () => {
    const hit = { status: 200, cache: "HIT", ttfb: 20 };
    const miss = { status: 200, cache: "MISS", ttfb: 250 };
    const row = classifyTimings("/", hit, [miss, hit], true, 5);
    expect(row.ttfbMiss).toBeNull();
    expect(row.ttfbHit).toBe(15);
    expect(row.measurementFailures).toEqual(["/: forced miss returned HIT (200)"]);
    expect(classifyTimings("/", miss, [hit], true).ttfbMiss).toBe(250);
    expect(classifyTimings("/", { ...miss, cache: "REFRESH" }, [hit], true).ttfbMiss).toBe(250);
    expect(classifyTimings("/", miss, [miss], true).measurementFailures).toEqual(["/: no verified HIT samples"]);
    expect(classifyTimings("/", miss, [miss], true).ttfbHit).toBeNull();
    expect(classifyTimings("/cart", { ...miss, cache: "BYPASS_AUTH" }, [{ ...miss, cache: "BYPASS_AUTH" }], true).measurementFailures).toEqual([]);
  });
});
