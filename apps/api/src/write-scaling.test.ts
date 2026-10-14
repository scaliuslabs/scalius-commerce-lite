// Extends zod with .openapi() before the route schemas load.
import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storefrontBatchPath } from "@scalius/shared/public-api-cache-routes";
import type { FreePlanCounters } from "./testing/free-plan-meter";
import { createFreePlanStore, type FreePlanStore } from "./testing/free-plan-store";
import { seedCatalog } from "./testing/free-plan-seed";
import { placeOrder, taxQuote } from "./testing/free-plan-checkout";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";

/**
 * The lightweight form of the scale proof (docs/SCALE.md): no operation may cost more than linear in what it
 * touches, and no read may cost more as the catalogue grows. Small seeds, so it runs with every test run; the
 * full proof (scripts/scale-proof.mjs) measures the same shapes at 1M orders and 150k SKUs.
 *
 * - A checkout's writes grow with its lines and nothing else: the marginal rows written per line is the same
 *   from 3 to 33 lines as from 33 to 99 (a trigger or a statement per line that reads or writes the whole
 *   order would make it climb), and the D1 round trips do not grow with the lines.
 * - A trigger's work is per row: updating 100 SKUs writes the same rows per SKU as updating 10.
 * - A buyer's page returns the rows of its own page, and runs no more full scans, when the catalogue
 *   holds 20 times the products.
 */
describe("write and read scaling", () => {
  let store: FreePlanStore;
  let randomSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeAll(async () => {
    // A hit in 1,000 is re-rendered after the response to audit its dependencies: random, and a gate must not be.
    const draw = Math.random.bind(Math);
    randomSpy = vi.spyOn(Math, "random").mockImplementation(() => 0.001 + draw() * 0.999);
    store = await createFreePlanStore();
    seedCatalog(store.sqlite);
    await store.ownerCookie();
  }, 120_000);

  afterAll(() => {
    store?.close();
    randomSpy?.mockRestore();
  });

  async function measureOrder(lines: number): Promise<FreePlanCounters> {
    const { quoteFingerprint } = await taxQuote(store, lines);
    await store.meter.settle();
    const { counters } = await store.meter.measure(() => placeOrder(store, lines, quoteFingerprint));
    return counters;
  }

  it("grows a checkout's rows written linearly with its lines, and its round trips not at all", async () => {
    await measureOrder(3); // warm: caches, settings mirror, first-run fills
    const small = await measureOrder(3);
    const middle = await measureOrder(33);
    const large = await measureOrder(99);

    const first = (middle.d1RowsChanged - small.d1RowsChanged) / 30;
    const second = (large.d1RowsChanged - middle.d1RowsChanged) / 66;
    expect(first, "rows written per added line (3 to 33 lines)").toBeGreaterThan(0);
    expect(second, `rows written per added line (33 to 99 lines) against ${first.toFixed(1)} before`).toBeLessThanOrEqual(first * 1.1);

    const firstRead = (middle.d1RowsRead - small.d1RowsRead) / 30;
    const secondRead = (large.d1RowsRead - middle.d1RowsRead) / 66;
    expect(secondRead, `rows read per added line (33 to 99 lines) against ${firstRead.toFixed(1)} before`).toBeLessThanOrEqual(firstRead * 1.1 + 1);

    expect(large.d1Calls, "D1 round trips of a 99-line order against a 3-line one").toBeLessThanOrEqual(small.d1Calls + 8);
    expect(large.d1RowsChanged, "a 99-line order writes about 99/3 times a 3-line one's per-line rows, never more").toBeLessThanOrEqual(small.d1RowsChanged + 96 * first * 1.1);
  });

  it("writes the same rows per SKU whether 10 or 100 SKUs change at once", () => {
    const changes = (): number => Number((store.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number | bigint }).n);
    const bump = (count: number): number => {
      const before = changes();
      store.sqlite.exec(`UPDATE product_variants SET price_minor = price_minor + 1 WHERE id IN (SELECT id FROM product_variants WHERE id LIKE 'v_bulk_%' ORDER BY id LIMIT ${count})`);
      return (changes() - before) / count;
    };
    bump(10); // warm
    const few = bump(10);
    const many = bump(100);
    expect(few, "rows written per SKU").toBeGreaterThan(1);
    expect(many, `rows written per SKU at 100 SKUs against ${few.toFixed(2)} at 10`).toBeLessThanOrEqual(few * 1.05);
  });

  it("returns the same rows for a page of a catalogue 20 times the size", async () => {
    const pages = {
      product: ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi"],
      category: ["/api/v1/storefront/layout", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest"],
    } as const;
    const render = async (parts: readonly string[]) => {
      store.meter.cache.entries.clear();
      const { counters, value } = await store.meter.measure(async () => {
        const response = await store.worker.fetch(new Request(`https://api.internal${storefrontBatchPath(parts)}`, { headers: { "X-Scalius-Cache-Generation": "gen1" } }));
        expect(response.status).toBe(200);
        return await response.text();
      });
      return { counters, body: value };
    };
    const measure = async (parts: readonly string[]) => { await render(parts); return render(parts); };

    const before = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, parts]) => [name, await measure(parts)] as const)));
    store.sqlite.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO products (id, name, price_minor, slug, category_id, is_active)
      SELECT 'p_grow_' || i, 'Grown item ' || i, 10000 + i, 'grown-item-' || i, 'cat_panjabi', 1 FROM n;
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      SELECT 'v_' || substr(id, 3), id, 'GROW-' || substr(id, 8), price_minor, 100, 0, 0, 1, 1, 'physical' FROM products WHERE id LIKE 'p_grow_%';
    `);
    await rebuildCatalogProjections(store.db);
    for (const [name, parts] of Object.entries(pages)) {
      const after = await measure(parts);
      const base = before[name]!;
      // The listing carries the catalogue's total: the page really faced the larger catalogue.
      if (name === "category") {
        const { pagination } = JSON.parse(JSON.parse(after.body).data.parts[1].body).data as { pagination: { total: number } };
        expect(pagination.total, "the listing faces the grown catalogue (its total is capped)").toBeGreaterThan(500);
      }
      // Rows returned are exact (the scan estimate ignores LIMIT); a hidden scan is the scale proof's to find.
      expect(after.counters.d1RowsReturned, `${name} page rows returned at 2,102 products (102 before) against ${base.counters.d1RowsReturned} at 102`).toBeLessThanOrEqual(base.counters.d1RowsReturned);
      expect(after.counters.d1FullScans, `${name} page full scans`).toBeLessThanOrEqual(base.counters.d1FullScans);
      expect(after.counters.d1Calls, `${name} page D1 round trips`).toBeLessThanOrEqual(base.counters.d1Calls);
    }
  });
});
