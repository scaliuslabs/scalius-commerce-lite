import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { listProducts } from "./read";

function setup() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO products (id, name, price_minor, slug, is_active, updated_at) VALUES
      ('p_live', 'Canvas Tote', 1000, 'tote', 1, 1700000000),
      ('p_inactive', 'Paused Tote', 1000, 'paused', 0, 1700000000);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, barcode, barcode_type, deleted_at) VALUES
      ('v_live', 'p_live', 'TOTE-NEW', 1000, 1, 0, 1, 0, NULL, NULL, NULL),
      ('v_retired', 'p_live', 'RETIREDSKU', 1000, 0, 0, 1, 0, '4006381333931', 'ean13', 1700000000),
      ('v_paused', 'p_inactive', 'PAUSEDSKU', 1000, 1, 0, 1, 0, NULL, NULL, NULL);
  `);
  return harness;
}

const ids = (result: Awaited<ReturnType<typeof listProducts>>) => result.products.map((product) => product.id);

describe("admin order catalog product search", () => {
  it("filters by active or draft status without changing the general catalog default", async () => {
    const { db } = setup();

    expect(ids(await listProducts(db, { search: "PAUSEDSKU" }))).toEqual(["p_inactive"]);
    expect(ids(await listProducts(db, { search: "PAUSEDSKU", status: "active" }))).toEqual([]);
    expect(ids(await listProducts(db, { status: "active" }))).toEqual(["p_live"]);
    expect(ids(await listProducts(db, { status: "draft" }))).toEqual(["p_inactive"]);
    const draftPage = await listProducts(db, { status: "draft" });
    expect(draftPage.pagination.total).toBe(1);
  });

  it("does not surface a product because a retired SKU still matches text or barcode search", async () => {
    const { db } = setup();

    expect(ids(await listProducts(db, { search: "RETIREDSKU" }))).toEqual([]);
    expect(ids(await listProducts(db, { search: "4006381333931" }))).toEqual([]);
    expect(ids(await listProducts(db, { search: "TOTE-NEW" }))).toEqual(["p_live"]);
  });

  it("returns Unix-second timestamps as the matching Date", async () => {
    const { db } = setup();

    const [product] = (await listProducts(db, { search: "TOTE-NEW" })).products;
    expect(new Date(product!.updatedAt).toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });
});
