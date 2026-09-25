// Companion statements (Wave B §3.2): a caller's statements commit in the same
// batch as the stock edge, or nothing commits: no stock change without them,
// and never them without the stock change.
import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { digitalLicenceKeys } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeInventoryOperation } from "./inventory-operations";

describe("inventory operation companion statements", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const one = (query: string) => sqlite.prepare(query).get();

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_app', 'App', 'app', 50000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, track_inventory, is_default, fulfillment_kind)
      VALUES ('var_app', 'prod_app', 'APP', 50000, 2, 0, 4, 1, 1, 'digital');
      INSERT INTO digital_assets (id, product_id, variant_id, kind, status, display_name, download_limit)
      VALUES ('dga_pool_00000001', 'prod_app', 'var_app', 'licence_keys', 'ready', 'Key', NULL);
    `);
  });

  afterEach(() => sqlite.close());

  const keyInsert = (id: string, hash: string) => db.insert(digitalLicenceKeys).values({
    id,
    assetId: "dga_pool_00000001",
    keyCiphertext: "v1:x:y",
    keyHash: hash,
    keyLast4: "ABCD",
    status: "available",
    importId: "lki_1",
  }) as BatchItem<"sqlite">;

  const operation = (key: string, delta: number, companions: BatchItem<"sqlite">[]) => executeInventoryOperation(db, {
    operationKey: key,
    operationType: "licence_keys",
    variantId: "var_app",
    pool: "stock",
    mode: "relative",
    delta,
    reason: "Imported",
  }, undefined, { companionStatements: companions });

  it("commits the companions with the stock edge", async () => {
    await expect(operation("licence-import:lki_aaaaaaaaaaaa", 1, [keyInsert("dlk_1", "h1")]))
      .resolves.toEqual({ variantId: "var_app", previousStock: 2, newStock: 3, delta: 1 });
    expect(one("SELECT stock, stock_version FROM product_variants")).toEqual({ stock: 3, stock_version: 5 });
    expect(one("SELECT count(*) AS n FROM digital_licence_keys")).toEqual({ n: 1 });
    expect(one("SELECT count(*) AS n FROM inventory_movements")).toEqual({ n: 1 });
  });

  it("rolls the stock edge back when a companion fails", async () => {
    await operation("licence-import:lki_bbbbbbbbbbbb", 1, [keyInsert("dlk_1", "h1")]);
    await expect(operation("licence-import:lki_cccccccccccc", 1, [keyInsert("dlk_2", "h1")])).rejects.toThrow(/UNIQUE/);
    expect(one("SELECT stock, stock_version FROM product_variants")).toEqual({ stock: 3, stock_version: 5 });
    expect(one("SELECT count(*) AS n FROM inventory_operations")).toEqual({ n: 1 });
    expect(one("SELECT count(*) AS n FROM inventory_movements")).toEqual({ n: 1 });
  });

  it("refuses companions on an operation that would not change the stock", async () => {
    await expect(operation("licence-import:lki_dddddddddddd", 0, [keyInsert("dlk_1", "h1")])).rejects.toThrow();
    expect(one("SELECT count(*) AS n FROM digital_licence_keys")).toEqual({ n: 0 });
  });
});
