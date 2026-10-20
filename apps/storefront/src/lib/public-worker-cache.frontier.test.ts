// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DEPENDENCY_CACHE_RETENTION_SECONDS, hashCacheDep, type CacheFrontierDelta, type StorefrontBatchPartCache } from "@scalius/shared/cache-frontier";

import {
  PAGE_DEPENDENCY_HEADERS,
  cacheStatusLane,
  pageEarlyHintLinks,
  publicStorefrontDvcCacheKey,
  servePublicStorefrontRequest,
  type PublicStorefrontCacheContext,
} from "./public-worker-cache";
import { cacheFrontierKey, createCacheFrontierClient, isCacheFrontierFresh, parseCacheFrontier, parseCacheFrontierDelta, refreshCacheFrontier, type CacheFrontierClient } from "./cache-frontier";
import { currentPageDependencies, markPageUnproven, recordPagePart } from "./page-dependencies";

const P1 = hashCacheDep("p:p_1");
const P2 = hashCacheDep("p:p_2");
const PAGE = "https://shop.example/products/fish";
const KEY = publicStorefrontDvcCacheKey(PAGE, "build-a", "ver-1");
const FRONTIER = cacheFrontierKey("https://shop.example", "build-a", "ver-1");

/** A store clock with the dependency rows the API would hold, behind the frontier API. */
function fakeStore() {
  const rows = new Map<string, number>();
  let clock = 10;
  let apiVersion = "api-1";
  const client: CacheFrontierClient = {
    delta: vi.fn(async (since: number | null): Promise<CacheFrontierDelta> => {
      const changes = [...rows.entries()].filter(([, seq]) => since === null || seq > since).sort((a, b) => a[1] - b[1]);
      return { apiVersion, S: clock, horizon: since ?? 0, floor: 0, clock, changes };
    }),
    check: vi.fn(async (s0: number, deps: readonly string[]) => ({
      apiVersion,
      S: clock,
      floor: 0,
      changed: deps.some((dep) => (rows.get(dep) ?? 0) > s0),
    })),
  };
  return {
    client,
    get clock() { return clock; },
    get apiVersion() { return apiVersion; },
    deploy(version: string) { apiVersion = version; },
    write(hash: string) { clock += 1; rows.set(hash, clock); },
  };
}

function part(s0: number, deps: string[], extra: Partial<StorefrontBatchPartCache> = {}): StorefrontBatchPartCache {
  return { apiVersion: "api-1", status: "miss", s0, deps, validUntil: null, softMaxAgeSeconds: null, renderedAt: 1_000, ...extra };
}

function setup(renderParts: () => Array<StorefrontBatchPartCache | null>, html = (clock: number) => `<html>${clock}</html>`) {
  const store = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const api = fakeStore();
  let now = 1_000;
  const render = vi.fn(async (_request: Request) => {
    for (const cache of renderParts()) recordPagePart(currentPageDependencies(), cache);
    return new Response(html(api.clock), {
      status: 200,
      headers: { "Content-Type": "text/html", "X-Cache-Status": "MISS", "Cache-Control": "no-cache" },
    });
  });
  const context: PublicStorefrontCacheContext = {
    mode: "frontier",
    cache: {
      match: vi.fn(async (key: RequestInfo | URL) => store.get(String(key))?.clone()),
      put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
        store.set(String(key), new Response(await response.arrayBuffer(), response));
      }),
    } as unknown as PublicStorefrontCacheContext["cache"],
    readGeneration: vi.fn(async () => "gen1"),
    buildId: "build-a",
    workerVersion: "ver-1",
    render,
    waitUntil: (promise) => pending.push(promise),
    frontier: api.client,
    now: () => now,
  };
  const serve = async (url = PAGE) => {
    const response = await servePublicStorefrontRequest(new Request(url), context);
    await response.text();
    await Promise.all(pending.splice(0));
    return response;
  };
  return { api, store, render, context, serve, tick: (ms: number) => { now += ms; } };
}

describe("frontier-validated storefront pages", () => {
  it("stores a proven render without the generation and serves it while no dependency changed", async () => {
    const t = setup(() => [part(10, [P1]), part(10, [P2])]);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
    const stored = t.store.get(KEY)!;
    expect(stored.headers.get(PAGE_DEPENDENCY_HEADERS.s0)).toBe("10");
    expect(stored.headers.get(PAGE_DEPENDENCY_HEADERS.deps)!.split(",").sort()).toEqual([P1, P2].sort());
    expect(t.context.readGeneration).not.toHaveBeenCalled();

    const hit = await t.serve();
    expect(hit.headers.get("X-Cache-Status")).toBe("HIT");
    for (const name of Object.values(PAGE_DEPENDENCY_HEADERS)) expect(hit.headers.has(name)).toBe(false);
    expect(t.render).toHaveBeenCalledTimes(1);
  });

  it.each([30, 365])("validates a retained unchanged object after %i days without logical age expiration", async (days) => {
    const t = setup(() => [part(10, [P1])]);
    delete t.context.mode; // The production default is frontier validation.
    delete t.context.readGeneration; // No production KV generation dependency.
    await t.serve();
    expect(t.store.get(KEY)!.headers.get("Cache-Control"))
      .toBe(`public, max-age=${DEPENDENCY_CACHE_RETENTION_SECONDS}`);
    // The fake Cache retains the object: real edge eviction/retention expiry
    // can still cause a miss; elapsed time alone does not invalidate its proof.
    t.tick(days * 86_400_000);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.render).toHaveBeenCalledTimes(1);
    t.store.delete(KEY); // Physical eviction still rebuilds normally.
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
    expect(t.render).toHaveBeenCalledTimes(2);
  });

  it("invalidates HTML after an API-only deployment with no data writes", async () => {
    const t = setup(() => [part(t.api.clock, [P1], { apiVersion: t.api.apiVersion })]);
    await t.serve();
    await t.serve();
    t.api.deploy("api-2");
    t.tick(1_001);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
    expect(t.store.get(KEY)!.headers.get(PAGE_DEPENDENCY_HEADERS.apiVersion)).toBe("api-2");
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
  });

  it("bounds a forged future merchant hint to one caught-up frontier refresh", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    await t.serve();
    vi.mocked(t.api.client.delta).mockClear();
    expect((await t.serve(`${PAGE}?_sv=999999999`)).headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.api.client.delta).toHaveBeenCalledTimes(1);
    expect(t.render).toHaveBeenCalledTimes(1);
    expect([...t.store.keys()].filter((key) => key.includes("/__cache/"))).toEqual([KEY]);
  });

  it("renders again once a dependency changed, and ignores unrelated writes", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    t.api.write(hashCacheDep("p:other"));
    t.tick(1_500);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.store.get(KEY)!.headers.get(PAGE_DEPENDENCY_HEADERS.s0)).toBe("10");
    expect(vi.mocked(t.context.cache.put).mock.calls.filter(([key]) => key === KEY)).toHaveLength(1);
    t.api.write(P1);
    t.tick(1_500);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
    expect(t.render).toHaveBeenCalledTimes(2);
  });

  it("serves within Δ from the stored frontier and refreshes it when older", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    await t.serve();
    const calls = vi.mocked(t.api.client.delta).mock.calls.length;
    t.api.write(P1);
    t.tick(400);
    // Within Δ a write may not be seen yet (the promise is t - Δ).
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    expect(vi.mocked(t.api.client.delta).mock.calls.length).toBe(calls);
    t.tick(700);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
  });

  it("_sv forces a frontier at least as new as the merchant's write, and never splits the key", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    t.api.write(P1);
    const response = await t.serve(`${PAGE}?_sv=${t.api.clock}`);
    expect(response.headers.get("X-Cache-Status")).toBe("MISS");
    expect(t.render.mock.calls[1]![0].url).toBe(PAGE);
    expect([...t.store.keys()].filter((key) => key.includes("/__cache/"))).toEqual([KEY]);
  });

  it("does not mistake a real merchant hint for a future hint when frontier paging is capped", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    await t.serve(); // A still-fresh old frontier must not certify the newer write.
    vi.mocked(t.api.client.delta).mockClear().mockImplementation(async (since) => ({
      apiVersion: "api-1", S: (since ?? 0) + 1, horizon: since ?? 0, floor: 0, clock: 100, changes: [],
    }));
    expect((await t.serve(`${PAGE}?_sv=90`)).headers.get("X-Cache-Status")).toBe("MISS");
    expect(t.api.client.delta).toHaveBeenCalledTimes(4);
  });

  it("never stores a render with an unproven read", async () => {
    const t = setup(() => [part(10, [P1]), null]);
    await t.serve();
    expect(t.store.has(KEY)).toBe(false);
    const other = setup(() => {
      markPageUnproven(currentPageDependencies());
      return [part(10, [P1])];
    });
    await other.serve();
    expect(other.store.has(KEY)).toBe(false);
  });

  it("keeps fast hits read-only, then rebases once when the frontier horizon passes the entry", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    for (let index = 0; index < 50; index += 1) t.api.write(hashCacheDep(`p:unrelated_${index}`));
    t.tick(1_500);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    const pagePuts = () => vi.mocked(t.context.cache.put).mock.calls.filter(([key]) => key === KEY);
    expect(pagePuts()).toHaveLength(1);
    expect(t.store.get(KEY)!.headers.get(PAGE_DEPENDENCY_HEADERS.s0)).toBe("10");
    // A frontier whose horizon passed the entry (trimmed or cold).
    t.store.set(FRONTIER, new Response(JSON.stringify({ apiVersion: "api-1", horizon: 50, S: 60, floor: 0, sentAt: 2_500, changes: [] })));
    expect(parseCacheFrontier(await t.store.get(FRONTIER)!.clone().text())?.horizon).toBe(50);
    const hit = await t.serve();
    expect(t.api.client.check).toHaveBeenCalledWith(10, [P1]);
    expect(hit.headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.store.get(KEY)!.headers.get(PAGE_DEPENDENCY_HEADERS.s0)).toBe("60");
    expect(pagePuts()).toHaveLength(2);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.api.client.check).toHaveBeenCalledTimes(1);
    expect(pagePuts()).toHaveLength(2);
    expect(t.render).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["scheduled boundary", 500, { validUntil: 1_500 }],
    ["soft boundary", 500, { softMaxAgeSeconds: 0.5 }],
    ["proof older than one second", 1_001, {}],
  ] as const)("renders when a slow check crosses %s", async (_label, delay, metadata) => {
    const t = setup(() => [part(10, [P1], metadata)]);
    await t.serve();
    t.store.set(FRONTIER, new Response(JSON.stringify({ apiVersion: "api-1", horizon: 50, S: 60, floor: 0, sentAt: 1_000, changes: [] })));
    vi.mocked(t.api.client.check).mockImplementationOnce(async () => {
      t.tick(delay);
      return { apiVersion: "api-1", S: 60, floor: 0, changed: false };
    });
    // The rejected entry's check still delayed the answer: the status says how long.
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe(`MISS; slow-check=${delay}ms`);
    expect(t.api.client.check).toHaveBeenCalledTimes(1);
  });

  it("rejects a slow check made by a different API deployment", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    t.store.set(FRONTIER, new Response(JSON.stringify({ apiVersion: "api-1", horizon: 50, S: 60, floor: 0, sentAt: 1_000, changes: [] })));
    vi.mocked(t.api.client.check).mockResolvedValueOnce({ apiVersion: "api-2", S: 60, floor: 0, changed: false });
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
  });

  it("renders when the frontier cannot be refreshed", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    t.tick(5_000);
    vi.mocked(t.api.client.delta).mockRejectedValueOnce(new Error("down"));
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
  });

  it("never serves at or after validUntil", async () => {
    const t = setup(() => [part(10, [P1], { validUntil: 2_000 })]);
    await t.serve();
    t.tick(999);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    t.tick(1);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("MISS");
  });
});

describe("one frontier refresh and one slow check per isolate", () => {
  const REQUESTS = 20;

  /** Holds the next delta (or check) answer until `release()`, so concurrent requests overlap. */
  function gated<T extends (...args: never[]) => Promise<unknown>>(mock: ReturnType<typeof vi.fn<T>>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = mock.getMockImplementation()! as (...args: Parameters<T>) => Promise<unknown>;
    const held = async (...args: Parameters<T>) => {
      const answer = await original(...args);
      await gate;
      return answer;
    };
    mock.mockImplementation(held as unknown as Parameters<typeof mock.mockImplementation>[0]);
    return release;
  }

  const overlap = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("answers requests that find the frontier older than Δ with one API read", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    await t.serve();
    t.tick(1_500);
    vi.mocked(t.api.client.delta).mockClear();
    const release = gated(vi.mocked(t.api.client.delta));
    const served = Promise.all(Array.from({ length: REQUESTS }, () => t.serve()));
    await overlap();
    release();
    const responses = await served;
    expect(t.api.client.delta).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.headers.get("X-Cache-Status"))).toEqual(Array(REQUESTS).fill("HIT"));
    expect(t.render).toHaveBeenCalledTimes(1);
    // The refreshed frontier was stored once, by the request that ran it.
    expect(vi.mocked(t.context.cache.put).mock.calls.filter(([key]) => key === FRONTIER)).toHaveLength(2);
  });

  it("starts one background refresh, not one per request, once the frontier is older than Δ/2", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    await t.serve();
    t.tick(600);
    vi.mocked(t.api.client.delta).mockClear();
    const release = gated(vi.mocked(t.api.client.delta));
    const served = Promise.all(Array.from({ length: REQUESTS }, () => t.serve()));
    await overlap();
    release();
    await served;
    expect(t.api.client.delta).toHaveBeenCalledTimes(1);
  });

  it("does not let a request with a newer _sv rely on a refresh that started before its write", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    await t.serve();
    t.tick(1_500);
    vi.mocked(t.api.client.delta).mockClear();
    // The first refresh reads the clock now, but answers only after the merchant's write.
    const original = vi.mocked(t.api.client.delta).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(t.api.client.delta).mockImplementationOnce(async (since) => {
      const snapshot = await original(since);
      await gate;
      return snapshot;
    });
    const anonymous = t.serve();
    await overlap();
    t.api.write(P1);
    const merchant = t.serve(`${PAGE}?_sv=${t.api.clock}`);
    await overlap();
    release();
    // The anonymous visitor may see the page as of before the write; the merchant must not.
    expect((await anonymous).headers.get("X-Cache-Status")).toBe("HIT");
    expect((await merchant).headers.get("X-Cache-Status")).toBe("MISS");
    expect(t.api.client.delta).toHaveBeenCalledTimes(2);
  });

  it("lets every waiter fall back to a live render when the one refresh fails, then recovers", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    await t.serve();
    t.tick(1_500);
    vi.mocked(t.api.client.delta).mockClear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(t.api.client.delta).mockImplementationOnce(async () => {
      await gate;
      throw new Error("down");
    });
    const served = Promise.all(Array.from({ length: 5 }, () => t.serve()));
    await overlap();
    release();
    const responses = await served;
    expect(responses.map((response) => response.headers.get("X-Cache-Status"))).toEqual(Array(5).fill("MISS"));
    expect(t.api.client.delta).toHaveBeenCalledTimes(1);
    // The failed flight left nothing behind: the next request refreshes normally.
    t.tick(1_500);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.api.client.delta).toHaveBeenCalledTimes(2);
  });

  it("shares one slow check between concurrent hits of a stored entry and rebases it once", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    t.store.set(FRONTIER, new Response(JSON.stringify({ apiVersion: "api-1", horizon: 50, S: 60, floor: 0, sentAt: 1_000, changes: [] })));
    const release = gated(vi.mocked(t.api.client.check));
    const served = Promise.all(Array.from({ length: REQUESTS }, () => t.serve()));
    await overlap();
    release();
    const responses = await served;
    expect(t.api.client.check).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.headers.get("X-Cache-Status"))).toEqual(Array(REQUESTS).fill("HIT"));
    expect(vi.mocked(t.context.cache.put).mock.calls.filter(([key]) => key === KEY)).toHaveLength(2);
    expect(t.store.get(KEY)!.headers.get(PAGE_DEPENDENCY_HEADERS.s0)).toBe(String(t.api.clock));
    expect(t.render).toHaveBeenCalledTimes(1);
  });

  it("counts a joined slow check from its own start, so a late proof still renders", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    t.store.set(FRONTIER, new Response(JSON.stringify({ apiVersion: "api-1", horizon: 50, S: 60, floor: 0, sentAt: 1_000, changes: [] })));
    const original = vi.mocked(t.api.client.check).getMockImplementation()!;
    vi.mocked(t.api.client.check).mockImplementationOnce(async (...args) => {
      const answer = await original(...args);
      t.tick(1_001);
      return answer;
    });
    const responses = await Promise.all([t.serve(), t.serve(), t.serve()]);
    expect(t.api.client.check).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => cacheStatusLane(response.headers.get("X-Cache-Status")))).toEqual(Array(3).fill("MISS"));
  });
});

describe("refreshCacheFrontier", () => {
  it("fails closed after four rounds when it cannot catch up with the clock", async () => {
    const client: CacheFrontierClient = {
      delta: vi.fn(async (since: number | null) => ({ apiVersion: "api-1", S: (since ?? 0) + 1, horizon: since ?? 0, floor: 0, clock: 100, changes: [] })),
      check: vi.fn(),
    };
    const frontier = await refreshCacheFrontier(null, client, () => 5_000);
    expect(frontier).toBeNull();
    expect(client.delta).toHaveBeenCalledTimes(4);
  });
});

describe("frontier wire validation", () => {
  it("rejects missing deployment proof and future-dated frontier freshness", () => {
    expect(parseCacheFrontierDelta({ S: 10, horizon: 0, floor: 0, clock: 10, changes: [] })).toBeNull();
    expect(parseCacheFrontier(JSON.stringify({ S: 10, horizon: 0, floor: 0, sentAt: 1000, changes: [] }))).toBeNull();
    expect(isCacheFrontierFresh({ apiVersion: "api-1", S: 10, horizon: 0, floor: 0, sentAt: 1001, changes: new Map() }, 1000, null)).toBe(false);
  });

  it("rejects mixed API versions across bounded slow-check chunks", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: {
      apiVersion: `api-${++calls}`, S: 60, floor: 0, changed: false,
    } })));
    const client = createCacheFrontierClient(fetcher, "https://api.test", async () => "key");
    await expect(client.check(10, Array.from({ length: 257 }, (_, index) => hashCacheDep(`p:${index}`))))
      .rejects.toThrow("crossed API versions");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("the wait a hit pays, and what the browser fetches meanwhile", () => {
  it("reports a blocking frontier refresh in X-Cache-Status, after the lane", async () => {
    const t = setup(() => [part(10, [P1])]);
    await t.serve();
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
    t.tick(1_500); // A quiet store: the frontier is older than Δ.
    const original = vi.mocked(t.api.client.delta).getMockImplementation()!;
    vi.mocked(t.api.client.delta).mockImplementationOnce(async (...args) => {
      t.tick(183); // The round trip to the API's region.
      return original(...args);
    });
    const waited = await t.serve();
    expect(waited.headers.get("X-Cache-Status")).toBe("HIT; frontier-wait=183ms");
    expect(cacheStatusLane(waited.headers.get("X-Cache-Status"))).toBe("HIT");
    // Within Δ again: no wait to report.
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
  });

  it("stores a page with Link preloads of its build stylesheets and fonts, so hits carry Early Hints", async () => {
    const head = [
      '<html><head><link rel="stylesheet" href="/_astro/build-a/global.Ab1.css">',
      "<link rel=stylesheet href=/_astro/build-a/Layout.Cd2.css>",
      '<link rel="preload" as="font" type="font/woff2" href="/_astro/build-a/inter-latin.Ef3.woff2" media="(min-width: 640px)" crossorigin="anonymous">',
      // Not the build's own files, or not something to preload: never hinted.
      '<link rel="stylesheet" href="https://fonts.example/app.css"><link rel="stylesheet" href="//cdn.example/x.css">',
      '<link rel="icon" href="/_astro/build-a/favicon.Gh4.css"><link rel="preload" as="image" href="/_astro/build-a/hero.woff2">',
      '<link rel="stylesheet" href="/_astro/build-a/a.css>; rel=preload, <https://evil.example/x.css">',
      '</head><body><link rel="stylesheet" href="/_astro/build-a/late.css"></body></html>',
    ].join("");
    const t = setup(() => [part(10, [P1])], () => head);
    const miss = await t.serve();
    expect(miss.headers.get("Link")).toBeNull();
    const expected = [
      "</_astro/build-a/global.Ab1.css>; rel=preload; as=style",
      "</_astro/build-a/Layout.Cd2.css>; rel=preload; as=style",
      '</_astro/build-a/inter-latin.Ef3.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin; media="(min-width: 640px)"',
    ];
    expect(t.store.get(KEY)!.headers.get("Link")).toBe(expected.join(", "));
    const hit = await t.serve();
    expect(hit.headers.get("X-Cache-Status")).toBe("HIT");
    expect(hit.headers.get("Link")).toBe(expected.join(", "));
  });

  it("hints at most six files, once each, and none from a page without a head", () => {
    const links = Array.from({ length: 9 }, (_, index) => `<link rel="stylesheet" href="/_astro/b/s${index % 8}.css">`).join("");
    expect(pageEarlyHintLinks(`<head>${links}</head>`)).toHaveLength(6);
    expect(pageEarlyHintLinks('<head><link rel="stylesheet" href="/_astro/b/s.css"><link rel="stylesheet" href="/_astro/b/s.css"></head>')).toHaveLength(1);
    expect(pageEarlyHintLinks("<urlset></urlset>")).toEqual([]);
  });
});
