import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

/**
 * D1 budget of each storefront page render. A page is one storefront batch
 * (see storefront-batch.ts) whose parts run concurrently; on a cache miss
 * each part reads D1. `roundTrips` counts D1 calls (a batch is one) and
 * `waves` the dependent rounds, the part that costs a full database round
 * trip each. Budgets are the measured values of this seeded store, so a new
 * query or a new sequential await fails here before it reaches production.
 */
const PAGE_D1_BUDGETS = {
  home: { roundTrips: 13, waves: 2 },
  product: { roundTrips: 21, waves: 3 },
  category: { roundTrips: 9, waves: 3 },
  search: { roundTrips: 9, waves: 2 },
} as const;

const PAGE_PARTS: Record<keyof typeof PAGE_D1_BUDGETS, string[]> = {
  home: ["/api/v1/storefront/layout", "/api/v1/storefront/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  product: ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  category: ["/api/v1/storefront/layout", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest"],
  search: ["/api/v1/storefront/layout", "/api/v1/products?page=1&limit=20&sort=relevance&search=linen"],
};

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
    ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1),
    ('p_cotton', 'Cotton Panjabi', 180000, 'cotton-panjabi', 'cat_panjabi', 1);
  INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_linen', 'Size', 'size', 0);
  INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
    ('ov_m', 'opt_size', 'M', 'm', 0), ('ov_l', 'opt_size', 'L', 'l', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key) VALUES
    ('v_linen_m', 'p_linen', 'LIN-M', 250000, 5, 0, 0, 1, 'M'),
    ('v_linen_l', 'p_linen', 'LIN-L', 250000, 5, 0, 0, 1, 'L'),
    ('v_cotton', 'p_cotton', 'COT-1', 180000, 5, 0, 1, 1, NULL);
  INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
    ('v_linen_m', 'opt_size', 'ov_m'), ('v_linen_l', 'opt_size', 'ov_l');
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600);
  INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_linen', 'p_linen', 'media_linen', 1, 0);
`;

interface Meter {
  binding: D1Database;
  roundTrips: number;
  waves: number;
}

/**
 * Wraps the D1 binding so every call waits for the current wave: calls made
 * before the wave starts share it, calls made from a result start the next.
 */
function meteredBinding(inner: D1Database): Meter {
  const meter = { roundTrips: 0, waves: 0 } as Meter;
  let queued: Array<() => void> = [];
  const roundTrip = <T>(work: () => Promise<T>): Promise<T> => {
    meter.roundTrips += 1;
    return new Promise<T>((resolve, reject) => {
      queued.push(() => void work().then(resolve, reject));
      if (queued.length === 1) {
        setTimeout(() => {
          meter.waves += 1;
          const run = queued;
          queued = [];
          for (const start of run) start();
        }, 0);
      }
    });
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
      }
      if (["all", "first", "run", "raw"].includes(String(property))) {
        return (...args: unknown[]) => roundTrip(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => roundTrip(() => target.batch(statements));
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  return meter;
}

async function renderPage(page: keyof typeof PAGE_PARTS) {
  const { sqlite, binding } = createSqliteD1Database();
  sqlite.exec(SEED);
  const meter = meteredBinding(binding);
  const env = {
    DB: meter.binding,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "render-budget-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "render-budget-credential-key-0123456789abcdef",
  } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const responses = await Promise.all(PAGE_PARTS[page].map((path) =>
    fetchRuntimeApiApp(new Request(`https://api.internal${path}`), env, ctx)));
  return { statuses: responses.map((response) => response.status), roundTrips: meter.roundTrips, waves: meter.waves };
}

describe("storefront page render D1 budget", () => {
  // Load every route module first: a first dynamic import would otherwise
  // show up as extra waves that production (one bundle) never has.
  beforeAll(async () => {
    for (const page of Object.keys(PAGE_PARTS) as Array<keyof typeof PAGE_PARTS>) await renderPage(page);
  });

  it.each(Object.keys(PAGE_D1_BUDGETS) as Array<keyof typeof PAGE_D1_BUDGETS>)(
    "%s page stays within its D1 round trips and waves",
    async (page) => {
      const result = await renderPage(page);

      expect(result.statuses.every((status) => status === 200), JSON.stringify(result.statuses)).toBe(true);
      expect({ page, roundTrips: result.roundTrips, waves: result.waves }).toEqual({
        page,
        roundTrips: Math.min(result.roundTrips, PAGE_D1_BUDGETS[page].roundTrips),
        waves: Math.min(result.waves, PAGE_D1_BUDGETS[page].waves),
      });
    },
  );
});
