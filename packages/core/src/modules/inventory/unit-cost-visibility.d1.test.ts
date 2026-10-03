// A SKU's unit cost (migration 0109) is staff-only: buyer reads (product
// page, listing, cart search, catalog feed) never carry it; staff reads of
// the product and its variants present it in decimal major units.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getStorefrontProductBySlug } from "../catalog/product-page";
import { getStorefrontProducts } from "../catalog/listing";
import { searchStorefrontProducts } from "../catalog/search";
import { getStorefrontFeedProducts } from "../catalog/feed";
import { getProductDetails } from "../product-admin/read";
import { getProductVariants } from "../product-admin/variants";
import { rebuildCatalogProjections } from "../products/catalog-projections";

// A cost no price, stock or id in the fixture contains.
const COST_MINOR = 3_141_593;

let sqlite: DatabaseSync;
let db: Database;

beforeEach(async () => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_kurta', 'Kurta', 'kurta', 250000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, cost_minor)
      VALUES ('v_kurta', 'p_kurta', 'KURTA-1', 250000, 5, 1, 1, ${COST_MINOR});
  `);
  await rebuildCatalogProjections(db);
});

afterEach(() => sqlite.close());

const leaks = (value: unknown) => {
  const json = JSON.stringify(value);
  return /"cost(Minor)?"\s*:/.test(json) || json.includes(String(COST_MINOR)) || json.includes("31415.93");
};

describe("unit cost visibility", () => {
  it("never reaches a buyer read", async () => {
    const page = await getStorefrontProductBySlug(db, "kurta");
    expect(page).not.toBeNull();
    expect(leaks(page)).toBe(false);
    const listing = await getStorefrontProducts(db, { page: 1, limit: 10 } as never);
    expect(JSON.stringify(listing)).toContain("Kurta");
    expect(leaks(listing)).toBe(false);
    const search = await searchStorefrontProducts(db, { search: "Kurta", page: 1, limit: 10 });
    expect(leaks(search)).toBe(false);
    const feed = await getStorefrontFeedProducts(db, { limit: 10 } as never);
    expect(leaks(feed)).toBe(false);
  });

  it("is presented in major units on staff reads", async () => {
    const detail = await getProductDetails(db, "p_kurta");
    expect(detail?.variants.map((variant) => (variant as { cost?: number | null }).cost)).toEqual([31_415.93]);
    expect(JSON.stringify(detail)).not.toContain("costMinor");
    const variants = await getProductVariants(db, "p_kurta");
    expect(variants.map((variant) => (variant as { cost?: number | null }).cost)).toEqual([31_415.93]);
  });
});
