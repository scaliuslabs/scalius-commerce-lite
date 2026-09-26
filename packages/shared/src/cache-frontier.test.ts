import { describe, expect, it } from "vitest";
import {
  decideCacheFrontierHit,
  hashCacheDep,
  isCacheDepHash,
  mergeCacheFrontier,
  type CacheFrontier,
  type CacheFrontierEntry,
} from "./cache-frontier";

const h = hashCacheDep;
const entry = (overrides: Partial<CacheFrontierEntry> = {}): CacheFrontierEntry => ({
  apiVersion: "api-a",
  s0: 10,
  depHashes: [h("p:a"), h("store")],
  validUntil: null,
  softMaxAgeSeconds: null,
  renderedAt: 0,
  ...overrides,
});
const frontier = (changes: Array<[string, number]>, overrides: Partial<CacheFrontier> = {}): CacheFrontier => ({
  apiVersion: "api-a",
  sentAt: 0,
  S: 20,
  horizon: 5,
  floor: 0,
  changes: new Map(changes),
  ...overrides,
});

describe("dependency key hash", () => {
  it("is 48 bits of lower-case hex, stable across runtimes, and spreads similar keys", () => {
    expect(h("p:a")).toMatch(/^[0-9a-f]{12}$/);
    expect(h("p:a")).toBe(h("p:a"));
    expect(isCacheDepHash(h("lm:cat:c1"))).toBe(true);
    expect(isCacheDepHash("p:a")).toBe(false);
    const hashes = new Set(Array.from({ length: 50_000 }, (_, index) => h(`p:${index}`)));
    expect(hashes.size).toBe(50_000);
  });
});

describe("frontier merge", () => {
  it("does not carry a frontier across API deployments", () => {
    const old = frontier([[h("p:a"), 15]]);
    const merged = mergeCacheFrontier(old, { apiVersion: "api-b", S: 20, horizon: 20, floor: 0, changes: [] }, 100);
    expect(merged.apiVersion).toBe("api-b");
    expect(merged.horizon).toBe(20);
    expect(merged.changes.size).toBe(0);
  });
  it("keeps the latest seq per key and connects a delta to the frontier it continues", () => {
    const old = mergeCacheFrontier(null, { apiVersion: "api-a", S: 10, horizon: 0, floor: 0, changes: [[h("p:a"), 3], [h("p:b"), 9]] }, 100);
    const merged = mergeCacheFrontier(old, { apiVersion: "api-a", S: 15, horizon: 10, floor: 0, changes: [[h("p:a"), 12]] }, 200);

    expect(merged).toMatchObject({ sentAt: 200, S: 15, horizon: 0 });
    expect(merged.changes.get(h("p:a"))).toBe(12);
    expect(merged.changes.get(h("p:b"))).toBe(9);
  });

  it("replaces a frontier the delta does not connect to", () => {
    const old = mergeCacheFrontier(null, { apiVersion: "api-a", S: 10, horizon: 0, floor: 0, changes: [[h("p:a"), 3]] }, 100);
    const merged = mergeCacheFrontier(old, { apiVersion: "api-a", S: 30, horizon: 25, floor: 0, changes: [[h("p:c"), 30]] }, 200);

    expect(merged.horizon).toBe(25);
    expect([...merged.changes.keys()]).toEqual([h("p:c")]);
  });

  it("trims to the cap, raising the horizon to the newest seq it drops", () => {
    const merged = mergeCacheFrontier(null, {
      apiVersion: "api-a", S: 5, horizon: 0, floor: 0, changes: [[h("a"), 1], [h("b"), 2], [h("c"), 3], [h("d"), 3], [h("e"), 5]],
    }, 0, 2);

    expect(merged.horizon).toBe(3);
    expect([...merged.changes.entries()]).toEqual([[h("e"), 5]]);
  });
});

describe("page hit rule", () => {
  it("rejects missing or changed API deployment identity even without row changes", () => {
    expect(decideCacheFrontierHit(entry(), frontier([], { apiVersion: "api-b" }), 0)).toBe("render");
    expect(decideCacheFrontierHit(entry({ apiVersion: "" }), frontier([]), 0)).toBe("render");
    expect(decideCacheFrontierHit(entry(), frontier([], { apiVersion: "" }), 0)).toBe("render");
  });
  it("serves only with no dependency changed after s0 in a frontier that covers s0", () => {
    expect(decideCacheFrontierHit(entry(), frontier([[h("p:b"), 15]]), 0)).toBe("serve");
    expect(decideCacheFrontierHit(entry(), frontier([[h("p:a"), 11]]), 0)).toBe("render");
    expect(decideCacheFrontierHit(entry(), frontier([[h("p:a"), 10]]), 0)).toBe("serve");
    expect(decideCacheFrontierHit(entry({ s0: 4 }), frontier([]), 0)).toBe("slow");
    expect(decideCacheFrontierHit(entry(), frontier([], { floor: 11 }), 0)).toBe("render");
    expect(decideCacheFrontierHit(entry({ validUntil: 50 }), frontier([]), 50)).toBe("render");
    expect(decideCacheFrontierHit(entry({ softMaxAgeSeconds: 1 }), frontier([]), 1_000)).toBe("render");
  });
});
