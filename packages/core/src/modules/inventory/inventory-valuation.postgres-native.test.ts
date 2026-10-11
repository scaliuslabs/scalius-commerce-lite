import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { getInventoryValuation } from "./inventory-insights";

afterAll(closeNativePostgres);

describe.runIf(nativePostgresUrl())("inventory valuation on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("maps exact location, distinct missing-cost and transit totals through the production adapter", async () => {
    const { db, client } = await createNativePostgres({ label: "inventory_valuation" });
    await client.query(`INSERT INTO settings (id, key, value, type, category)
      VALUES ('currency_doc', 'document', $1, 'json', 'currency')`, [JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳" })]);
    await client.query(`
      UPDATE inventory_locations SET name = 'Main', code = 'MAIN' WHERE id = 'loc_default';
      INSERT INTO inventory_locations (id, name, code, status, position) VALUES
        ('loc_shop', 'Shop', 'SHOP', 'active', 1),
        ('loc_empty', 'Empty', 'EMPTY', 'active', 2),
        ('loc_archived', 'Archived stock', 'OLD', 'archived', 1),
        ('loc_archived_empty', 'Archived empty', 'OLD-EMPTY', 'archived', 2);
      INSERT INTO products (id, name, slug, price_minor) VALUES
        ('prod_cost', 'Cost', 'cost', 1000),
        ('prod_free', 'Free', 'free', 1000),
        ('prod_unknown', 'Unknown', 'unknown', 1000),
        ('prod_retired', 'Retired', 'retired', 1000),
        ('prod_empty', 'Empty', 'empty', 1000);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, cost_minor) VALUES
        ('var_cost', 'prod_cost', 'PG-COST', 1000, 4, 1, 1, 131),
        ('var_free', 'prod_free', 'PG-FREE', 1000, 2, 1, 1, 0),
        ('var_unknown', 'prod_unknown', 'PG-UNKNOWN', 1000, 5, 1, 1, NULL),
        ('var_retired', 'prod_retired', 'PG-RETIRED', 1000, 1, 1, 1, NULL),
        ('var_empty', 'prod_empty', 'PG-EMPTY', 1000, 0, 1, 1, NULL);
      UPDATE inventory_levels SET on_hand = 3 WHERE variant_id = 'var_unknown' AND location_id = 'loc_default';
      INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ('var_unknown', 'loc_shop', 2);
      UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = 'var_retired' AND location_id = 'loc_default';
      INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ('var_retired', 'loc_archived', 1);
      UPDATE product_variants SET deleted_at = 1700000000 WHERE id = 'var_retired';
      INSERT INTO inventory_transfers (id, number, origin_location_id, destination_location_id, status) VALUES
        ('transfer_live', 1, 'loc_default', 'loc_shop', 'draft'),
        ('transfer_draft', 2, 'loc_default', 'loc_shop', 'draft');
      INSERT INTO inventory_transfer_lines (id, transfer_id, variant_id, quantity, shipped_quantity, received_quantity, returned_quantity) VALUES
        ('line_cost', 'transfer_live', 'var_cost', 3, 3, 1, 1),
        ('line_unknown', 'transfer_live', 'var_unknown', 2, 2, 0, 0),
        ('line_draft', 'transfer_draft', 'var_cost', 10, 0, 0, 0);
      UPDATE inventory_transfers SET status = 'partially_received' WHERE id = 'transfer_live';
    `);

    expect(await getInventoryValuation(db)).toEqual({
      currencyCode: "BDT",
      locations: [
        { locationId: "loc_default", name: "Main", code: "MAIN", isDefault: true, status: "active", units: 9, value: 5.24, unitsWithoutCost: 3, skusWithoutCost: 1 },
        { locationId: "loc_shop", name: "Shop", code: "SHOP", isDefault: false, status: "active", units: 2, value: 0, unitsWithoutCost: 2, skusWithoutCost: 1 },
        { locationId: "loc_empty", name: "Empty", code: "EMPTY", isDefault: false, status: "active", units: 0, value: 0, unitsWithoutCost: 0, skusWithoutCost: 0 },
        { locationId: "loc_archived", name: "Archived stock", code: "OLD", isDefault: false, status: "archived", units: 1, value: 0, unitsWithoutCost: 1, skusWithoutCost: 1 },
      ],
      total: { units: 12, value: 5.24, unitsWithoutCost: 6, skusWithoutCost: 2 },
      inTransit: { units: 3, value: 1.31, unitsWithoutCost: 2 },
    });

    // Retired stock still uses its current cost, not an active-only or stale projection.
    await client.query("UPDATE product_variants SET cost_minor = 200 WHERE id = 'var_retired'");
    const revalued = await getInventoryValuation(db);
    expect(revalued.total).toEqual({ units: 12, value: 7.24, unitsWithoutCost: 5, skusWithoutCost: 1 });
    expect(revalued.locations.at(-1)).toEqual({ locationId: "loc_archived", name: "Archived stock", code: "OLD", isDefault: false, status: "archived", units: 1, value: 2, unitsWithoutCost: 0, skusWithoutCost: 0 });
    expect(revalued.inTransit).toEqual({ units: 3, value: 1.31, unitsWithoutCost: 2 });
  });
});
