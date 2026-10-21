// Byte budget of a buyer's first add to cart, over the built storefront.
// Skipped without a build: run `pnpm --filter ./apps/storefront build` first.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ADD_TO_CART_LAZY_CHUNKS,
  OTHER_ACTION_LAZY_CHUNKS,
  forbiddenRuntimes,
  loadClientGraph,
  productPageBudget,
  totals,
} from "./client-chunk-graph.mjs";

const storefrontDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const graph = loadClientGraph(storefrontDir);

/**
 * Gzip KiB ceilings, measured on 2026-10-21 plus 3 KiB of headroom for copy
 * and shared-chunk regrouping. Shrink the output to fit; do not raise them
 * to admit a runtime. The first add to cart was 203 KiB gzip with zod, the
 * generated SDK and the checkout language catalog in it.
 */
const BUDGET_GZIP_KIB = {
  firstPaint: 60,
  addedByFirstAddToCart: 111,
};

describe.skipIf(!graph)("built storefront: product page JavaScript", () => {
  const budget = graph ? productPageBudget(graph) : null;

  it("finds the page scripts and every lazy load of the first add to cart", () => {
    expect(budget!.firstPaint.size).toBeGreaterThan(10);
    expect([...budget!.matched].sort()).toEqual([...ADD_TO_CART_LAZY_CHUNKS].filter((name) => name !== "cart").sort());
    // React's DOM renderer comes with the drawer: the walk followed the drawer's imports.
    expect([...budget!.added].some((id) => graph!.chunk(id).code.includes("react-dom"))).toBe(true);
  });

  it("downloads neither zod nor the generated SDK at first paint or on the first add to cart", () => {
    expect(forbiddenRuntimes(graph!, budget!.afterAdd)).toEqual([]);
  });

  it("keeps sign-in, search and zoom free of them too", () => {
    const lazy = graph!.lazyLoads(budget!.afterAdd);
    const others = [...lazy].filter(([target]) =>
      OTHER_ACTION_LAZY_CHUNKS.some((name) => target.split("/").pop()!.startsWith(`${name}.`)));
    expect(others.length).toBe(OTHER_ACTION_LAZY_CHUNKS.length);
    for (const [target, deps] of others) {
      expect(forbiddenRuntimes(graph!, graph!.closure([target, ...deps])), target).toEqual([]);
    }
  });

  it("stays within its gzip budgets", () => {
    const kib = (ids: Set<string>) => Math.round((totals(graph!, ids).gzip / 1024) * 10) / 10;
    expect(kib(budget!.firstPaint)).toBeLessThanOrEqual(BUDGET_GZIP_KIB.firstPaint);
    expect(kib(budget!.added)).toBeLessThanOrEqual(BUDGET_GZIP_KIB.addedByFirstAddToCart);
  });
});
