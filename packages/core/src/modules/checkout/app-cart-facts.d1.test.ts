// The facts an app cart carries (packages/shared/src/plugins/functions.ts) on
// the real migrated schema: the signed-in customer's real tags, and the
// market of the order's country, both read in the one facts batch.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { functionCartSchema } from "@scalius/shared/plugins";
import { appCartMarketCountry, buildAppFunctionCart, loadAppFunctionCartFacts } from "./app-functions";

describe("the app cart's customer tags and market", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_a', 'Tea', 'tea', 50000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_a', 'p_a', 'TEA-1', 50000, 10, 0, 0, 1, 1, 'physical');
      INSERT INTO customers (id, name, phone, origin) VALUES ('cust_tags', 'Tagged', '+8801712345678', 'account'), ('cust_plain', 'Plain', '+8801712345679', 'account');
      INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_tags', 'wholesale'), ('cust_tags', 'vip'), ('cust_tags', 'new year');
      INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active'), ('mkt_pk', 'pakistan', 'Pakistan', 'draft');
      INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in'), ('PK', 'mkt_pk');
    `);
  });
  afterEach(() => sqlite.close());

  const facts = (input: { customerId?: string | null; country?: string | null }) =>
    loadAppFunctionCartFacts(db, { productIds: ["p_a"], variantIds: ["v_a"], customerId: input.customerId ?? null, marketCountry: input.country ?? null });

  it("lists the signed-in customer's real tags, sorted, and none for a customer without tags or a guest", async () => {
    expect((await facts({ customerId: "cust_tags" })).customer).toMatchObject({ id: "cust_tags", tags: ["new year", "vip", "wholesale"] });
    expect((await facts({ customerId: "cust_plain" })).customer).toMatchObject({ id: "cust_plain", tags: [] });
    expect((await facts({})).customer).toBeNull();
  });

  it("names the market that sells to the country, else the backup market", async () => {
    expect((await facts({ country: "IN" })).market).toEqual({ id: "mkt_in", country: "IN" });
    // A draft market does not sell yet; an unlisted country and an unknown country fall back.
    expect((await facts({ country: "PK" })).market).toEqual({ id: "mkt_backup", country: "PK" });
    expect((await facts({ country: "BD" })).market).toEqual({ id: "mkt_backup", country: "BD" });
    expect((await facts({})).market).toEqual({ id: "mkt_backup", country: null });
  });

  it("builds a cart that passes the contract with the market and no attributes", async () => {
    const cart = buildAppFunctionCart({
      currency: { code: "BDT", decimalPlaces: 2 },
      channel: "online_store",
      lines: [{ lineId: "cart:0:v_a", productId: "p_a", variantId: "v_a", title: "Tea", quantity: 1, unitPriceMinor: 50_000, discountMinor: 0, properties: [] }],
      facts: await facts({ customerId: "cust_tags", country: "IN" }),
      destination: { country: "IN", city: "Mumbai", zone: null },
      discountCodes: [],
    });
    expect(functionCartSchema.safeParse(cart).success).toBe(true);
    expect(cart).toMatchObject({ market: { id: "mkt_in", country: "IN" }, attributes: {}, customer: { tags: ["new year", "vip", "wholesale"] } });
  });
});

describe("appCartMarketCountry", () => {
  it("is the shipping country, else the billing country, else none", () => {
    expect(appCartMarketCountry({ country: "in", city: null, zone: null })).toBe("IN");
    // Bangladesh's delivery hierarchy names no country.
    expect(appCartMarketCountry({ city: "Dhaka", zone: null })).toBe("BD");
    expect(appCartMarketCountry(null, "gb")).toBe("GB");
    expect(appCartMarketCountry({ country: "IN", city: null, zone: null }, "GB")).toBe("IN");
    expect(appCartMarketCountry(null)).toBeNull();
    expect(appCartMarketCountry(null, "not a country")).toBeNull();
  });
});
