import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformSettings } from "../platform";
import { applyStoreSetup, getStoreSetupStatus, STORE_SETUP_DONE } from "./store-setup.service";

function row<T>(sqlite: DatabaseSync, query: string): T {
  return sqlite.prepare(query).get() as T;
}

function documentOf(sqlite: DatabaseSync, category: string): Record<string, unknown> {
  const stored = sqlite.prepare("SELECT value FROM settings WHERE category = ? AND key = 'document'").get(category) as { value: string } | undefined;
  return stored ? JSON.parse(stored.value) as Record<string, unknown> : {};
}

describe("store setup", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("starts a fresh install from the Bangladesh backup market that migration 0112 created", async () => {
    await expect(getStoreSetupStatus(db)).resolves.toMatchObject({
      needed: true,
      done: null,
      currencyLocked: false,
      current: {
        storeName: "",
        countryCode: "BD",
        currencyCode: "BDT",
        locale: "en",
        timeZone: "Asia/Dhaka",
        unitSystem: "metric",
        weightUnit: "g",
      },
    });
  });

  it("makes a new store the country's in one write, then never again", async () => {
    const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const result = await applyStoreSetup(db, {
      storeName: " Acme Goods ",
      countryCode: "us",
      timeZone: "America/New_York",
    }, kv);

    expect(result).toEqual({
      values: {
        storeName: "Acme Goods",
        countryCode: "US",
        currencyCode: "USD",
        locale: "en",
        timeZone: "America/New_York",
        unitSystem: "imperial",
        weightUnit: "lb",
      },
      // Whole taka (100) became cents (1): every card price is re-rounded.
      priceIncrementChanged: true,
    });
    expect(row(sqlite, "SELECT name, handle, price_increment_minor AS increment, revision FROM markets WHERE id = 'mkt_backup'"))
      .toEqual({ name: "United States", handle: "united-states", increment: 1, revision: 2 });
    expect(sqlite.prepare("SELECT country_code FROM market_countries WHERE market_id = 'mkt_backup'").all())
      .toEqual([{ country_code: "US" }]);
    expect(documentOf(sqlite, "currency")).toMatchObject({ currencyCode: "USD", currencySymbol: "$" });
    expect(documentOf(sqlite, "business")).toMatchObject({ companyName: "Acme Goods", country: "United States" });
    await expect(getPlatformSettings(db)).resolves.toMatchObject({ timeZone: "America/New_York", unitSystem: "imperial", weightUnit: "lb" });
    // The KV mirror Worker entry reads carries the new zone at once.
    expect(kv.put).toHaveBeenCalledWith("settings:platform", expect.stringContaining("America/New_York"));

    await expect(getStoreSetupStatus(db)).resolves.toMatchObject({ needed: false, done: "markets_configured" });
    await expect(applyStoreSetup(db, { storeName: "Again", countryCode: "BD", timeZone: "Asia/Dhaka" }))
      .rejects.toMatchObject({ status: 409, code: STORE_SETUP_DONE });
    expect(row(sqlite, "SELECT name FROM markets WHERE id = 'mkt_backup'")).toEqual({ name: "United States" });
  });

  it("keeps a Bangladesh store exactly as it was (whole taka, Dhaka time)", async () => {
    const result = await applyStoreSetup(db, { storeName: "Dhaka Mart", countryCode: "BD", locale: "bn", timeZone: "Asia/Dhaka" });
    expect(result).toEqual({
      values: {
        storeName: "Dhaka Mart",
        countryCode: "BD",
        currencyCode: "BDT",
        locale: "bn",
        timeZone: "Asia/Dhaka",
        unitSystem: "metric",
        weightUnit: "kg",
      },
      priceIncrementChanged: false,
    });
    expect(row(sqlite, "SELECT price_increment_minor AS increment FROM markets WHERE id = 'mkt_backup'")).toEqual({ increment: 100 });
    expect(row(sqlite, "SELECT locale FROM market_presences WHERE market_id = 'mkt_backup' AND value = ''")).toEqual({ locale: "bn" });
    // The currency document is not rewritten when the currency stays.
    expect(row(sqlite, "SELECT count(*) AS n FROM settings WHERE category = 'currency'")).toEqual({ n: 0 });
  });

  it("never rewrites a store that took an order", async () => {
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        shipping_amount_minor, total_amount_minor, total_shop_minor, status)
      VALUES ('ord_1', 'Buyer', '+8801711111111', 'Dhaka', 'dhaka', 'zone_1', 0, 10000, 10000, 'pending')`);
    await expect(getStoreSetupStatus(db)).resolves.toMatchObject({ needed: false, done: "has_orders" });
    await expect(applyStoreSetup(db, { storeName: "Late", countryCode: "US", timeZone: "UTC" }))
      .rejects.toMatchObject({ status: 409, code: STORE_SETUP_DONE });
    expect(row(sqlite, "SELECT name, revision FROM markets WHERE id = 'mkt_backup'")).toEqual({ name: "Bangladesh", revision: 1 });
  });

  it("keeps a currency products are already priced in", async () => {
    sqlite.exec("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Tea', 'tea', 10000, 1)");
    await expect(getStoreSetupStatus(db)).resolves.toMatchObject({ needed: true, currencyLocked: true });
    await expect(applyStoreSetup(db, { storeName: "Tea", countryCode: "IN", timeZone: "Asia/Kolkata" }))
      .rejects.toThrow(/priced in BDT/);
    await expect(applyStoreSetup(db, { storeName: "Tea", countryCode: "IN", currencyCode: "BDT", timeZone: "Asia/Kolkata" }))
      .resolves.toMatchObject({ values: { countryCode: "IN", currencyCode: "BDT" } });
  });

  it("refuses what it cannot set", async () => {
    await expect(applyStoreSetup(db, { storeName: " ", countryCode: "US", timeZone: "UTC" })).rejects.toThrow(/name/);
    await expect(applyStoreSetup(db, { storeName: "A", countryCode: "ZZ", timeZone: "UTC" })).rejects.toThrow(/country/);
    await expect(applyStoreSetup(db, { storeName: "A", countryCode: "US", timeZone: "Mars/Olympus" })).rejects.toThrow(/time zone/);
    await expect(applyStoreSetup(db, { storeName: "A", countryCode: "US", timeZone: "UTC", weightUnit: "kg" })).rejects.toThrow(/imperial/);
    expect(row(sqlite, "SELECT revision FROM markets WHERE id = 'mkt_backup'")).toEqual({ revision: 1 });
  });
});
