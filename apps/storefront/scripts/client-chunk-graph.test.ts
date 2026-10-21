// Byte budget of a buyer's first add to cart, over the built storefront.
// Skipped without a build: run `pnpm --filter ./apps/storefront build` first.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ADD_TO_CART_LAZY_CHUNKS,
  BUYER_PAGE_SCRIPTS,
  OTHER_ACTION_LAZY_CHUNKS,
  forbiddenRuntimes,
  loadClientGraph,
  pageEntries,
  productPageBudget,
  totals,
} from "./client-chunk-graph.mjs";

const storefrontDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const graph = loadClientGraph(storefrontDir);

/**
 * Gzip KiB ceilings, measured on 2026-10-21 (57.0 and 107.9) plus about
 * 3 KiB of headroom for copy and shared-chunk regrouping. Shrink the output
 * to fit; do not raise them to admit a runtime. Before, the first add to cart
 * added 150 KiB gzip (zod, the checkout language catalog), and a card's quick
 * add 25.5 KiB more (the generated SDK and the SSR transport).
 */
const BUDGET_GZIP_KIB = {
  firstPaint: 60,
  addedByFirstAddToCart: 111,
};

const chunkName = (id: string) => id.split("/").pop()!;

describe.skipIf(!graph)("built storefront: buyer page JavaScript", () => {
  const budget = graph ? productPageBudget(graph) : null;

  it("finds the product page scripts and every lazy load of the first add to cart", () => {
    expect(budget!.firstPaint.size).toBeGreaterThan(10);
    // The cart store is already on the page; the others load on the add.
    expect([...budget!.matched].sort()).toEqual(ADD_TO_CART_LAZY_CHUNKS.filter((name) => name !== "cart").sort());
    // React's DOM renderer comes with the drawer: the walk followed the drawer's imports.
    expect([...budget!.added].some((id) => graph!.chunk(id).code.includes("react-dom"))).toBe(true);
  });

  it.each(Object.keys(BUYER_PAGE_SCRIPTS))(
    "the %s page downloads neither zod nor the generated SDK: first paint, first add to cart, sign-in, search, zoom",
    (page) => {
      const firstPaint = graph!.closure(pageEntries(graph!, BUYER_PAGE_SCRIPTS[page as keyof typeof BUYER_PAGE_SCRIPTS]));
      const { chunks: afterAdd } = graph!.withLazy(firstPaint, ADD_TO_CART_LAZY_CHUNKS);
      expect(forbiddenRuntimes(graph!, afterAdd)).toEqual([]);
      const others = [...graph!.lazyLoads(afterAdd)].filter(([target]) =>
        OTHER_ACTION_LAZY_CHUNKS.some((name) => chunkName(target).startsWith(`${name}.`)));
      expect(others.length).toBeGreaterThanOrEqual(2);
      for (const [target, deps] of others) {
        expect(forbiddenRuntimes(graph!, graph!.closure([target, ...deps])), chunkName(target)).toEqual([]);
      }
    },
  );

  it("keeps the product page within its gzip budgets", () => {
    const kib = (ids: Set<string>) => Math.round((totals(graph!, ids).gzip / 1024) * 10) / 10;
    expect(kib(budget!.firstPaint)).toBeLessThanOrEqual(BUDGET_GZIP_KIB.firstPaint);
    expect(kib(budget!.added)).toBeLessThanOrEqual(BUDGET_GZIP_KIB.addedByFirstAddToCart);
  });
});
