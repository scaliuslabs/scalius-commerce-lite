import { eq } from "drizzle-orm";
import { runWithReadObserver } from "@scalius/database/read-observer";
import {
  categories,
  productRecommendations,
  products,
  productVariants,
  settings,
} from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  CACHE_DEP_ENTRY_KEY_BUDGET,
  CACHE_DEP_EXEMPT_TABLES,
  CACHE_DEP_SOFT_MAX_AGE_SECONDS,
  CACHE_DEP_TABLES,
  cacheDep,
  categoryScope,
} from "@scalius/shared/cache-deps";
import { describe, expect, it, vi } from "vitest";

import {
  CACHE_DEP_SOFT_TABLES,
  CacheDepCoverageError,
  coarseKeysForKind,
  deps,
  resolveCacheDependencies,
  withDependencyScope,
} from "./index";

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { log: () => undefined };

describe("dependency scope", () => {
  it("isolates concurrent requests that interleave reads and declarations", async () => {
    const { db } = createSqliteD1Database();
    const renderProduct = async (id: string) => {
      await tick(2);
      await db.select({ id: products.id }).from(products).where(eq(products.id, id)).all();
      deps.product(id);
      await tick(1);
      await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, id)).all();
      return id;
    };
    const renderSettings = async () => {
      await tick(1);
      await db.select({ key: settings.key }).from(settings).all();
      deps.settings("seo", "document");
      await tick(3);
      return "settings";
    };

    const results = await Promise.all([
      withDependencyScope(() => renderProduct("prod_a"), silent),
      withDependencyScope(renderSettings, silent),
      withDependencyScope(() => renderProduct("prod_b"), silent),
    ]);

    expect(results.map((result) => result.value)).toEqual(["prod_a", "settings", "prod_b"]);
    expect(results[0]!.dependencies.keys).toEqual(["p:prod_a", "store"]);
    expect(results[0]!.dependencies.tables).toEqual(["product_variants", "products"]);
    expect(results[1]!.dependencies.keys).toEqual(["set:seo:document", "store"]);
    expect(results[1]!.dependencies.tables).toEqual(["settings"]);
    expect(results[2]!.dependencies.keys).toEqual(["p:prod_b", "store"]);
    for (const { dependencies } of results) {
      expect(dependencies.coarseTables).toEqual([]);
      expect(dependencies.uncacheable).toEqual([]);
    }
  });

  it("records concurrent reads inside one scope together (batch parts in one render)", async () => {
    const { db } = createSqliteD1Database();
    const { dependencies } = await withDependencyScope(async () => {
      await Promise.all([
        db.select({ id: categories.id }).from(categories).all(),
        db.select({ id: products.id }).from(products).all(),
      ]);
      deps.anyCategory();
      deps.listMembership("all");
    }, silent);
    expect(dependencies.tables).toEqual(["categories", "products"]);
    expect(dependencies.keys).toEqual(["c:*", "lm:all", "store"]);
    expect(dependencies.coarseTables).toEqual([]);
  });

  it("declarations outside a scope are no-ops and reads are not recorded", async () => {
    const { db } = createSqliteD1Database();
    expect(deps.active()).toBe(false);
    deps.product("prod_a");
    deps.validUntil(Date.now());
    deps.uncacheable("x");
    await db.select({ id: products.id }).from(products).all();
    const { dependencies } = await withDependencyScope(() => {
      expect(deps.active()).toBe(true);
    }, silent);
    expect(dependencies.keys).toEqual(["store"]);
    expect(dependencies.tables).toEqual([]);
  });

  it("stops recording once closed, even for reads a render leaves running", async () => {
    const { db } = createSqliteD1Database();
    let late: Promise<unknown> = Promise.resolve();
    const { dependencies } = await withDependencyScope(() => {
      late = (async () => {
        await tick(5);
        deps.product("late");
        await db.select({ id: categories.id }).from(categories).all();
      })();
    }, silent);
    await late;
    expect(dependencies.keys).toEqual(["store"]);
    expect(dependencies.tables).toEqual([]);
  });

  it("nested scopes hand their resolved keys, time bounds and failures to the parent", async () => {
    const { db } = createSqliteD1Database();
    const outer = await withDependencyScope(async () => {
      const inner = await withDependencyScope(async () => {
        await db.select({ id: products.id }).from(products).all();
        deps.product("prod_a");
        deps.validUntil(2_000);
      }, silent);
      expect(inner.dependencies.keys).toEqual(["p:prod_a", "store"]);
      deps.validUntil(new Date(5_000));
      await expect(withDependencyScope(() => {
        throw new Error("part failed");
      }, silent)).rejects.toThrow("part failed");
    }, silent);
    expect(outer.dependencies.keys).toEqual(["p:prod_a", "store"]);
    expect(outer.dependencies.tables).toEqual([]);
    expect(outer.dependencies.validUntil).toBe(2_000);
    expect(outer.dependencies.uncacheable).toEqual(["nested-render-failed"]);
  });

  it("forwards reads to a non-scope observer around it", async () => {
    const { db } = createSqliteD1Database();
    const seen: string[] = [];
    await runWithReadObserver({ observeTables: (tables) => seen.push(...tables) }, () =>
      withDependencyScope(() => db.select({ id: products.id }).from(products).all(), silent));
    expect(seen).toEqual(["products"]);
  });
});

describe("coverage fallback", () => {
  it("covers a table by any declared key of a kind the registry lists for it", () => {
    const resolution = resolveCacheDependencies({
      declared: [cacheDep.listMembership(categoryScope("cat_1")), cacheDep.settings("seo", "document")],
      tables: ["products", "product_buyer_state", "category_closure", "settings"],
    });
    expect(resolution.coarseTables).toEqual([]);
    expect(resolution.keys).toEqual(["lm:cat:cat_1", "set:seo:document", "store"]);
  });

  it("falls back to t:<table> for an uncovered registered table and logs it once, masked", async () => {
    const { db } = createSqliteD1Database();
    const log = vi.fn();
    const { dependencies } = await withDependencyScope(async () => {
      await db.select({ id: products.id }).from(products)
        .innerJoin(productVariants, eq(productVariants.productId, products.id)).all();
      await db.select({ id: categories.id }).from(categories).all();
      deps.product("prod_a"); // covers products and product_variants, not categories
    }, { label: "/api/v1/products/red-shirt?utm_source=secret#x", log });
    expect(dependencies.coarseTables).toEqual(["categories"]);
    expect(dependencies.keys).toEqual(["p:prod_a", "store", "t:categories"]);
    expect(dependencies.uncacheable).toEqual([]);
    expect(log).toHaveBeenCalledExactlyOnceWith("[CacheDeps] coarse /api/v1/products/red-shirt categories");
  });

  it("an explicit t:<table> covers its table", () => {
    const resolution = resolveCacheDependencies({ declared: [cacheDep.table("hero_sliders")], tables: ["hero_sliders"] });
    expect(resolution.coarseTables).toEqual([]);
    expect(resolution.keys).toEqual(["store", "t:hero_sliders"]);
  });

  it("exempt tables need no key; soft tables bound the soft max age", async () => {
    const { db } = createSqliteD1Database();
    const { dependencies } = await withDependencyScope(async () => {
      await db.select({ id: productRecommendations.recommendedProductId }).from(productRecommendations).all();
      deps.products(["prod_a", null, "prod_b", undefined, ""]);
    }, silent);
    expect(dependencies.keys).toEqual(["p:prod_a", "p:prod_b", "store"]);
    expect(dependencies.softMaxAgeSeconds).toBe(CACHE_DEP_SOFT_MAX_AGE_SECONDS);
    expect(dependencies.coarseTables).toEqual([]);

    const privateOnly = resolveCacheDependencies({ declared: [], tables: ["customers", "cache_clock"] });
    expect(privateOnly.keys).toEqual(["store"]);
    expect(privateOnly.softMaxAgeSeconds).toBeNull();
  });

  it("declared soft ordering keeps the tighter bound", async () => {
    const { dependencies } = await withDependencyScope(() => {
      deps.softOrdering(120);
      deps.softOrdering(900);
    }, silent);
    expect(dependencies.softMaxAgeSeconds).toBe(120);
  });

  it("an unregistered table makes the entry uncacheable, never silently fresh", async () => {
    const log = vi.fn();
    const { dependencies } = await withDependencyScope(async () => {
      const { observeStatement } = await import("@scalius/database/read-observer");
      observeStatement("select * from brand_new_table");
    }, { label: "/api/v1/x", log });
    expect(dependencies.uncacheable).toEqual(["unregistered-table:brand_new_table"]);
    expect(log).toHaveBeenCalledWith("[CacheDeps] uncacheable /api/v1/x unregistered brand_new_table");
  });

  it("a strict scope (and every scope nested in it) throws instead of falling back", async () => {
    const { db } = createSqliteD1Database();
    await expect(withDependencyScope(async () => {
      await withDependencyScope(() => db.select({ id: categories.id }).from(categories).all());
    }, { strict: true, label: "/api/v1/categories" })).rejects.toBeInstanceOf(CacheDepCoverageError);

    await expect(withDependencyScope(() => deps.key("p:"), { strict: true }))
      .rejects.toThrow(/invalid keys p:/);

    await expect(withDependencyScope(async () => {
      await db.select({ id: categories.id }).from(categories).all();
      deps.category("cat_1");
    }, { strict: true })).resolves.toMatchObject({ dependencies: { keys: ["c:cat_1", "store"] } });
  });

  it("drops a malformed key outside strict mode, so its table falls back instead", async () => {
    const { db } = createSqliteD1Database();
    const log = vi.fn();
    const { dependencies } = await withDependencyScope(async () => {
      await db.select({ id: products.id }).from(products).all();
      deps.key("p:has space");
    }, { log });
    expect(dependencies.keys).toEqual(["store", "t:products"]);
    expect(log).toHaveBeenCalledWith("[CacheDeps] invalid-key (unlabelled) p");
  });

  it("keeps the soft table list equal to the registry's soft exemptions", () => {
    const soft = Object.entries(CACHE_DEP_EXEMPT_TABLES)
      .filter(([, reason]) => reason.startsWith("Soft ordering"))
      .map(([table]) => table)
      .sort();
    expect([...CACHE_DEP_SOFT_TABLES].sort()).toEqual(soft);
  });
});

describe("entry key budget", () => {
  it("collapses the most numerous kind to the coarse keys of every table that advances it", () => {
    const productKeys = Array.from({ length: CACHE_DEP_ENTRY_KEY_BUDGET + 20 }, (_, index) => cacheDep.product(`prod_${index}`));
    const resolution = resolveCacheDependencies({
      declared: [...productKeys, cacheDep.listMembership("all"), cacheDep.category("cat_1"), cacheDep.theme()],
      tables: ["products", "product_variants", "categories", "theme_settings"],
    });
    const pTables = Object.entries(CACHE_DEP_TABLES)
      .filter(([, spec]) => (spec.kinds as readonly string[]).includes("p"))
      .map(([table]) => cacheDep.table(table));
    expect(resolution.collapsedKinds).toEqual(["p"]);
    expect(resolution.overBudget).toBe(false);
    expect(resolution.keys.some((key) => key.startsWith("p:"))).toBe(false);
    expect(resolution.keys).toEqual([...pTables, "c:cat_1", "lm:all", "store", "theme"].sort());
    expect(coarseKeysForKind("p")).toEqual(pTables);
  });

  it("collapses kinds largest first until the entry fits, and leaves small kinds precise", () => {
    const many = (build: (id: string) => string, count: number) =>
      Array.from({ length: count }, (_, index) => build(`id_${index}`));
    const resolution = resolveCacheDependencies({
      declared: [...many(cacheDep.product, 150), ...many(cacheDep.media, 140), ...many(cacheDep.category, 5)],
      tables: [],
    });
    // 296 keys: collapsing p (150 -> 11 t: keys) alone fits.
    expect(resolution.collapsedKinds).toEqual(["p"]);
    expect(resolution.keys.filter((key) => key.startsWith("m:"))).toHaveLength(140);
    expect(resolution.keys.filter((key) => key.startsWith("c:"))).toHaveLength(5);
    expect(resolution.keys.length).toBeLessThanOrEqual(CACHE_DEP_ENTRY_KEY_BUDGET);
  });

  it("reports the collapse through the scope", async () => {
    const log = vi.fn();
    const { dependencies } = await withDependencyScope(() => {
      deps.products(Array.from({ length: 300 }, (_, index) => `prod_${index}`));
    }, { label: "/api/v1/products", log });
    expect(dependencies.collapsedKinds).toEqual(["p"]);
    expect(dependencies.keys.length).toBeLessThanOrEqual(CACHE_DEP_ENTRY_KEY_BUDGET);
    expect(dependencies.uncacheable).toEqual([]);
    expect(log).toHaveBeenCalledWith("[CacheDeps] budget /api/v1/products collapsed p");
  });

  it("an entry that cannot fit even collapsed is uncacheable", async () => {
    const { dependencies } = await withDependencyScope(() => {
      deps.products(["a", "b", "c", "d"]);
      deps.settings("seo", "document");
      deps.theme();
    }, { budget: 2, log: () => undefined });
    expect(dependencies.uncacheable).toEqual(["over-budget"]);
  });
});
