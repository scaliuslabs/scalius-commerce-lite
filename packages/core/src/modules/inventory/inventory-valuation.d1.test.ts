import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInventoryValuation } from "./inventory-insights";

describe("inventory valuation", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let queries: Array<{ query: string; params: readonly SQLInputValue[] }>;

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query, params) => queries.push({ query, params }) }));
    sqlite.exec(`
      UPDATE inventory_locations SET name = 'Main', code = 'MAIN' WHERE id = 'loc_default';
      INSERT INTO inventory_locations (id, name, code, status, position) VALUES
        ('loc_shop', 'Shop', 'SHOP', 'active', 1),
        ('loc_empty', 'Empty', 'EMPTY', 'active', 2),
        ('loc_archived', 'Archived stock', 'OLD', 'archived', 1),
        ('loc_archived_empty', 'Archived empty', 'OLD-EMPTY', 'archived', 2);
    `);
  });
  afterEach(() => sqlite.close());

  function sku(id: string, units: number, cost: number | null) {
    sqlite.prepare("INSERT INTO products (id, name, slug, price_minor) VALUES (?, ?, ?, 1000)").run(`prod_${id}`, id, id);
    sqlite.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, cost_minor)
      VALUES (?, ?, ?, 1000, ?, 1, 1, ?)`).run(id, `prod_${id}`, id, units, cost);
  }

  it.each([
    ["BDT", "৳", 5.24, 1.31],
    ["JPY", "¥", 524, 131],
  ])("preserves per-location, distinct missing-cost and transit totals in %s", async (code, symbol, totalValue, transitValue) => {
    sqlite.prepare(`INSERT INTO settings (id, key, value, type, category)
      VALUES ('currency_doc', 'document', ?, 'json', 'currency')`).run(JSON.stringify({ currencyCode: code, currencySymbol: symbol }));
    sku("var_cost", 4, 131);
    sku("var_free", 2, 0);
    sku("var_unknown", 5, null);
    sku("var_retired", 1, null);
    sku("var_empty", 0, null);
    sqlite.exec(`
      UPDATE inventory_levels SET on_hand = 3 WHERE variant_id = 'var_unknown' AND location_id = 'loc_default';
      INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ('var_unknown', 'loc_shop', 2);
      UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = 'var_retired' AND location_id = 'loc_default';
      INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ('var_retired', 'loc_archived', 1);
      UPDATE product_variants SET deleted_at = unixepoch() WHERE id = 'var_retired';
      INSERT INTO inventory_transfers (id, number, origin_location_id, destination_location_id, status) VALUES
        ('transfer_live', 1, 'loc_default', 'loc_shop', 'draft'),
        ('transfer_draft', 2, 'loc_default', 'loc_shop', 'draft');
      INSERT INTO inventory_transfer_lines (id, transfer_id, variant_id, quantity, shipped_quantity, received_quantity, returned_quantity) VALUES
        ('line_cost', 'transfer_live', 'var_cost', 3, 3, 1, 1),
        ('line_unknown', 'transfer_live', 'var_unknown', 2, 2, 0, 0),
        ('line_draft', 'transfer_draft', 'var_cost', 10, 0, 0, 0);
      UPDATE inventory_transfers SET status = 'partially_received' WHERE id = 'transfer_live';
    `);

    const value = await getInventoryValuation(db);
    expect(value.currencyCode).toBe(code);
    expect(value.locations.map(({ locationId, units, value, unitsWithoutCost, skusWithoutCost }) =>
      [locationId, units, value, unitsWithoutCost, skusWithoutCost])).toEqual([
      ["loc_default", 9, totalValue, 3, 1],
      ["loc_shop", 2, 0, 2, 1],
      ["loc_empty", 0, 0, 0, 0],
      ["loc_archived", 1, 0, 1, 1],
    ]);
    expect(value.total).toEqual({ units: 12, value: totalValue, unitsWithoutCost: 6, skusWithoutCost: 2 });
    expect(value.inTransit).toEqual({ units: 3, value: transitValue, unitsWithoutCost: 2 });
    expect(value.locations[0]).toMatchObject({ name: "Main", code: "MAIN", isDefault: true, status: "active" });
    expect(value.locations.at(-1)).toMatchObject({ isDefault: false, status: "archived" });
  });

  it("groups narrow stock rows in index order and checks missing-cost SKUs without a distinct sort", async () => {
    sku("var_unknown", 1, null);
    await getInventoryValuation(db);
    const locationRead = queries.find(({ query }) => query.includes('"valuation_stock"'))!;
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${locationRead.query}`).all(...locationRead.params)
      .map((row) => String(row.detail)).join("\n");
    expect(plan).toMatch(/SEARCH inventory_levels\b[^\n]*USING (?:COVERING )?INDEX \S+ \(location_id=\? AND on_hand>\?\)/);
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR GROUP BY/);
    const missingRead = queries.find(({ query }) => query.includes("EXISTS") && query.includes('"cost_minor" IS NULL'))!;
    const missingPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${missingRead.query}`).all(...missingRead.params)
      .map((row) => String(row.detail)).join("\n");
    expect(missingPlan).toMatch(/SEARCH inventory_levels\b[^\n]*USING (?:(?:COVERING )?INDEX \S+|PRIMARY KEY) \(variant_id=\?\)/);
    expect(missingPlan).not.toMatch(/SCAN inventory_levels|USE TEMP B-TREE/);
  });

  it("keeps empty active locations and returns zero totals without stock or transfers", async () => {
    const value = await getInventoryValuation(db);
    expect(value.locations.map(({ locationId }) => locationId)).toEqual(["loc_default", "loc_shop", "loc_empty"]);
    expect(value.locations.every(({ units, value, unitsWithoutCost, skusWithoutCost }) =>
      units === 0 && value === 0 && unitsWithoutCost === 0 && skusWithoutCost === 0)).toBe(true);
    expect(value.total).toEqual({ units: 0, value: 0, unitsWithoutCost: 0, skusWithoutCost: 0 });
    expect(value.inTransit).toEqual({ units: 0, value: 0, unitsWithoutCost: 0 });
  });
});
