// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { hashCacheDep, type CacheFrontierDelta, type StorefrontBatchPartCache } from "@scalius/shared/cache-frontier";

import {
  PAGE_DEPENDENCY_HEADERS,
  publicStorefrontDvcCacheKey,
  servePublicStorefrontRequest,
  type PublicStorefrontCacheContext,
} from "./public-worker-cache";
import { cacheFrontierKey, parseCacheFrontier, refreshCacheFrontier, type CacheFrontierClient } from "./cache-frontier";
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
  const client: CacheFrontierClient = {
    delta: vi.fn(async (since: number | null): Promise<CacheFrontierDelta> => {
      const changes = [...rows.entries()].filter(([, seq]) => since === null || seq > since).sort((a, b) => a[1] - b[1]);
      return { S: clock, horizon: since ?? 0, floor: 0, clock, changes };
    }),
    check: vi.fn(async (s0: number, deps: readonly string[]) => ({
      S: clock,
      floor: 0,
      changed: deps.some((dep) => (rows.get(dep) ?? 0) > s0),
    })),
  };
  return {
    client,
    get clock() { return clock; },
    write(hash: string) { clock += 1; rows.set(hash, clock); },
  };
}

function part(s0: number, deps: string[], extra: Partial<StorefrontBatchPartCache> = {}): StorefrontBatchPartCache {
  return { status: "miss", s0, deps, validUntil: null, softMaxAgeSeconds: null, renderedAt: 1_000, ...extra };
}

function setup(renderParts: () => Array<StorefrontBatchPartCache | null>) {
  const store = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const api = fakeStore();
  let now = 1_000;
  const render = vi.fn(async (_request: Request) => {
    for (const cache of renderParts()) recordPagePart(currentPageDependencies(), cache);
    return new Response(`<html>${api.clock}</html>`, {
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

  it("renders again once a dependency changed, and ignores unrelated writes", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    t.api.write(hashCacheDep("p:other"));
    t.tick(1_500);
    expect((await t.serve()).headers.get("X-Cache-Status")).toBe("HIT");
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

  it("takes the slow path for an entry older than the frontier's horizon", async () => {
    const t = setup(() => [part(t.api.clock, [P1])]);
    await t.serve();
    // A frontier whose horizon passed the entry (trimmed or cold).
    t.store.set(FRONTIER, new Response(JSON.stringify({ horizon: 50, S: 60, floor: 0, sentAt: 1_000, changes: [] })));
    expect(parseCacheFrontier(await t.store.get(FRONTIER)!.clone().text())?.horizon).toBe(50);
    const hit = await t.serve();
    expect(t.api.client.check).toHaveBeenCalledWith(10, [P1]);
    expect(hit.headers.get("X-Cache-Status")).toBe("HIT");
    expect(t.store.get(KEY)!.headers.get(PAGE_DEPENDENCY_HEADERS.s0)).toBe("10");
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

describe("refreshCacheFrontier", () => {
  it("keeps the old sentAt when it cannot catch up with the clock", async () => {
    const client: CacheFrontierClient = {
      delta: vi.fn(async (since: number | null) => ({ S: (since ?? 0) + 1, horizon: since ?? 0, floor: 0, clock: 100, changes: [] })),
      check: vi.fn(),
    };
    const frontier = await refreshCacheFrontier(null, client, () => 5_000);
    expect(frontier.sentAt).toBe(0);
    expect(frontier.S).toBe(4);
  });
});
