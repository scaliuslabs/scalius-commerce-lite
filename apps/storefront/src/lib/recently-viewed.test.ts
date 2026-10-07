// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECENTLY_VIEWED_STORAGE_KEY,
  pruneStoredRecentlyViewed,
  recentlyViewedGoneIds,
  recentlyViewedIds,
  recentlyViewedRecordScript,
  recentlyViewedRenderScript,
} from "./recently-viewed";
import { checkRecentlyViewed, dropGoneFromRows } from "./recently-viewed-client";

const entry = (n: number) => ({ id: `prod_${n}`, slug: `item-${n}`, name: `Item ${n}`, image: `https://cdn.test/${n}.jpg` });

function run(script: string) {
  new Function(script)();
}

function mountRow(id = "recently-viewed") {
  document.body.innerHTML = `<section id="${id}" data-recently-viewed hidden><ul data-recently-viewed-list></ul></section>`;
  return document.getElementById(id) as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});
afterEach(() => {
  localStorage.clear();
});

describe("recently viewed list", () => {
  it("records each product once, newest first, under the v2 key", () => {
    expect(RECENTLY_VIEWED_STORAGE_KEY).toBe("scalius:recently-viewed:v2");
    run(recentlyViewedRecordScript(entry(1)));
    run(recentlyViewedRecordScript(entry(2)));
    run(recentlyViewedRecordScript({ ...entry(1), name: "Item 1 renamed" }));
    const stored = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY)!);
    expect(stored.map((x: { id: string }) => x.id)).toEqual(["prod_1", "prod_2"]);
    expect(stored[0].name).toBe("Item 1 renamed");
  });

  it("keeps old v1 entries out", () => {
    localStorage.setItem("scalius:recently-viewed:v1", JSON.stringify([{ slug: "old", name: "Old", image: null }]));
    const row = mountRow();
    run(recentlyViewedRenderScript("recently-viewed"));
    expect(row.hidden).toBe(true);
  });

  it("draws the row with product ids and leaves out entries without one", () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([entry(1), { slug: "no-id", name: "No id", image: null }, entry(2)]));
    const row = mountRow();
    run(recentlyViewedRenderScript("recently-viewed", "item-2"));
    expect(row.hidden).toBe(false);
    const items = [...row.querySelectorAll("li")];
    expect(items.map((li) => li.getAttribute("data-recently-viewed-id"))).toEqual(["prod_1"]);
  });
});

describe("checking the list against the public catalogue", () => {
  it("sends only distinct product ids, at most twelve", () => {
    const entries = [...Array.from({ length: 15 }, (_, n) => entry(n)), entry(0), { slug: "x" }, null];
    const ids = recentlyViewedIds(entries);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids.every((id) => id.startsWith("prod_"))).toBe(true);
  });

  it("finds the products the catalogue no longer returns", () => {
    const gone = recentlyViewedGoneIds(["a", "b", "c"], new Set(["a", "c"]));
    expect([...gone]).toEqual(["b"]);
    expect(recentlyViewedGoneIds(["a"], new Set(["a"])).size).toBe(0);
  });

  it("prunes gone products from storage and keeps a view recorded meanwhile", () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([entry(3), entry(2), entry(1)]));
    expect(pruneStoredRecentlyViewed(localStorage, new Set(["prod_2"]))).toBe(true);
    expect(JSON.parse(localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY)!).map((x: { id: string }) => x.id)).toEqual(["prod_3", "prod_1"]);
    expect(pruneStoredRecentlyViewed(localStorage, new Set(["prod_9"]))).toBe(false);
    expect(pruneStoredRecentlyViewed(localStorage, new Set())).toBe(false);
  });

  it("does not throw on a broken or blocked store", () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, "{not json");
    expect(pruneStoredRecentlyViewed(localStorage, new Set(["a"]))).toBe(false);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    expect(pruneStoredRecentlyViewed(blocked, new Set(["a"]))).toBe(false);
  });

  it("removes gone products from the row and hides a row left empty", () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([entry(1), entry(2)]));
    const row = mountRow();
    run(recentlyViewedRenderScript("recently-viewed"));
    dropGoneFromRows([row], new Set(["prod_1"]));
    expect(row.hidden).toBe(false);
    expect(row.querySelectorAll("li")).toHaveLength(1);
    dropGoneFromRows([row], new Set(["prod_2"]));
    expect(row.hidden).toBe(true);
  });

  it("drops gone products from the row and storage after the read", async () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([entry(1), entry(2), entry(3)]));
    const row = mountRow();
    run(recentlyViewedRenderScript("recently-viewed"));
    let asked: readonly string[] = [];
    await checkRecentlyViewed(async (ids) => {
      asked = ids;
      return new Set(["prod_1", "prod_3"]);
    });
    expect(asked).toEqual(["prod_1", "prod_2", "prod_3"]);
    expect([...row.querySelectorAll("li")].map((li) => li.getAttribute("data-recently-viewed-id"))).toEqual(["prod_1", "prod_3"]);
    expect(JSON.parse(localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY)!).map((x: { id: string }) => x.id)).toEqual(["prod_1", "prod_3"]);
  });

  it("hides the section when every product is gone", async () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([entry(1)]));
    const row = mountRow();
    run(recentlyViewedRenderScript("recently-viewed"));
    await checkRecentlyViewed(async () => new Set());
    expect(row.hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY)!)).toEqual([]);
  });

  it("keeps the list as it is when the read fails", async () => {
    localStorage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify([entry(1), entry(2)]));
    const row = mountRow();
    run(recentlyViewedRenderScript("recently-viewed"));
    await checkRecentlyViewed(async () => null);
    expect(row.hidden).toBe(false);
    expect(row.querySelectorAll("li")).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY)!)).toHaveLength(2);
  });

  it("makes no read when no row is shown", async () => {
    mountRow();
    let reads = 0;
    await checkRecentlyViewed(async () => {
      reads++;
      return new Set();
    });
    expect(reads).toBe(0);
  });
});
