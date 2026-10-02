import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { selectReservationVariantStates } from "./reserve";

// D1 allows 100 bound parameters per statement (the shim enforces it). The
// checkout read batch looks every cart line's SKU up in one statement, and a
// cart may hold more lines than that.
describe("selectReservationVariantStates", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    const insertProduct = sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES (?, ?, ?, 100, 1)");
    const insertVariant = sqlite.prepare(`INSERT INTO product_variants
      (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES (?, ?, ?, 100, 5, 0, 1, 1)`);
    for (let index = 1; index <= 150; index += 1) {
      insertProduct.run(`p_${index}`, `Item ${index}`, `item-${index}`);
      insertVariant.run(`v_${index}`, `p_${index}`, `SKU-${index}`);
    }
  });

  afterEach(() => sqlite.close());

  it.each([1, 97, 98, 99, 150])("reads the counters of %i distinct cart lines in one statement", async (lines) => {
    const ids = Array.from({ length: lines }, (_, index) => `v_${index + 1}`);
    const rows = await selectReservationVariantStates(db, ids).all();
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(rows.every((row) => row.stock === 5 && row.reservedStock === 0)).toBe(true);
  });

  it("answers an empty cart and unknown or repeated ids without error", async () => {
    expect(await selectReservationVariantStates(db, []).all()).toEqual([]);
    const rows = await selectReservationVariantStates(db, ["v_1", "v_1", "missing"]).all();
    expect(rows.map((row) => row.id)).toEqual(["v_1"]);
  });
});
