import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSetupGuideFacts } from "./setup-guide.service";

describe("setup guide facts", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  it("reads nothing as done on a fresh install", async () => {
    await expect(getSetupGuideFacts(db)).resolves.toEqual({
      hasProducts: false,
      draftProducts: 0,
      newestDraftProductId: null,
      testOrderProductSlug: null,
      themePublished: false,
      shippingReady: false,
      hasOrders: false,
      onlinePaidProducts: 0,
    });
  });

  it("counts a product until it is in the trash", async () => {
    sqlite.prepare("INSERT INTO products (id, name, slug) VALUES ('p1', 'Panjabi', 'panjabi')").run();
    expect((await getSetupGuideFacts(db)).hasProducts).toBe(true);
    expect((await getSetupGuideFacts(db)).testOrderProductSlug).toBe("panjabi");
    sqlite.prepare("UPDATE products SET deleted_at = unixepoch() WHERE id = 'p1'").run();
    expect((await getSetupGuideFacts(db)).hasProducts).toBe(false);
    expect((await getSetupGuideFacts(db)).testOrderProductSlug).toBeNull();
  });

  it("counts only live products; drafts are counted apart", async () => {
    sqlite.exec(`
      INSERT INTO products (id, name, slug, is_active, created_at) VALUES
        ('p_old', 'Old draft', 'old-draft', 0, 100),
        ('p_new', 'New draft', 'new-draft', 0, 200),
        ('p_card', 'Gift card', 'gift-card', 1, 300);
      UPDATE products SET is_gift_card = 1 WHERE id = 'p_card';
    `);
    // A live gift card is a live product, but a test buyer can't add it to the cart in one link.
    expect(await getSetupGuideFacts(db)).toMatchObject({ hasProducts: true, draftProducts: 2, newestDraftProductId: "p_new", testOrderProductSlug: null });
    sqlite.prepare("UPDATE products SET is_active = 0 WHERE id = 'p_card'").run();
    expect(await getSetupGuideFacts(db)).toMatchObject({ hasProducts: false, draftProducts: 3 });
    sqlite.prepare("UPDATE products SET is_active = 1 WHERE id = 'p_new'").run();
    expect(await getSetupGuideFacts(db)).toMatchObject({ hasProducts: true, draftProducts: 2, newestDraftProductId: "p_card", testOrderProductSlug: "new-draft" });
  });

  it("counts an order only once a buyer placed one through the storefront", async () => {
    const insert = (id: string, channel: string) => sqlite.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
        total_amount_minor, balance_due_minor, status, channel, created_at, updated_at)
      VALUES (?, 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'Dhaka', 'Mirpur', 100000, 100000, 'pending', ?, 1, 1)
    `).run(id, channel);
    // An order the merchant typed in shows nothing about the buyer's checkout.
    insert("order_admin", "admin");
    expect((await getSetupGuideFacts(db)).hasOrders).toBe(false);
    insert("order_store", "online_store");
    expect((await getSetupGuideFacts(db)).hasOrders).toBe(true);
  });

  it("counts a theme only once it was published, not the seeded one", async () => {
    sqlite.prepare("INSERT INTO theme_settings_versions (id, published_revision, theme, source) VALUES ('v1', 1, '{}', 'migration')").run();
    expect((await getSetupGuideFacts(db)).themePublished).toBe(false);
    sqlite.prepare("INSERT INTO theme_settings_versions (id, published_revision, theme, source) VALUES ('v2', 2, '{}', 'publish')").run();
    expect((await getSetupGuideFacts(db)).themePublished).toBe(true);
  });

  it("counts shipping only for a live rate that serves somewhere", async () => {
    sqlite.prepare("INSERT INTO delivery_zones (id, name) VALUES ('z1', 'Dhaka')").run();
    sqlite.prepare("INSERT INTO shipping_methods (id, name, zone_id) VALUES ('m1', 'Standard', 'z1')").run();
    // A zone with no region or place serves nobody.
    expect((await getSetupGuideFacts(db)).shippingReady).toBe(false);

    sqlite.prepare("INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'z1')").run();
    expect((await getSetupGuideFacts(db)).shippingReady).toBe(true);

    sqlite.prepare("UPDATE shipping_methods SET is_active = 0 WHERE id = 'm1'").run();
    expect((await getSetupGuideFacts(db)).shippingReady).toBe(false);

    sqlite.prepare("INSERT INTO shipping_methods (id, name, kind, pickup_address) VALUES ('m2', 'Pick up', 'pickup', '12 Road')").run();
    expect((await getSetupGuideFacts(db)).shippingReady).toBe(true);
    sqlite.prepare("UPDATE shipping_methods SET deleted_at = unixepoch() WHERE id = 'm2'").run();
    expect((await getSetupGuideFacts(db)).shippingReady).toBe(false);
  });

  it("counts active products only an online payment can pay for", async () => {
    sqlite.exec(`
      INSERT INTO products (id, name, slug, is_gift_card) VALUES
        ('p_key', 'Licence key', 'licence-key', 0),
        ('p_mixed', 'Course and book', 'course-and-book', 0),
        ('p_shirt', 'Shirt', 'shirt', 0),
        ('p_card', 'Gift card', 'gift-card', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, is_default, fulfillment_kind, option_combination_key) VALUES
        ('v_key', 'p_key', 'KEY-1', 50000, 1, 'digital', NULL),
        ('v_course', 'p_mixed', 'COURSE-1', 50000, 0, 'digital', 'format=course'),
        ('v_book', 'p_mixed', 'BOOK-1', 50000, 0, 'physical', 'format=book'),
        ('v_shirt', 'p_shirt', 'SHIRT-1', 50000, 1, 'physical', NULL),
        ('v_card', 'p_card', 'CARD-1', 100000, 1, 'physical', NULL);
    `);
    // The key and the gift card; a product with a book in it can be paid in cash.
    expect((await getSetupGuideFacts(db)).onlinePaidProducts).toBe(2);
    // With the book retired, the course is paid only online.
    sqlite.prepare("UPDATE product_variants SET deleted_at = unixepoch() WHERE id = 'v_book'").run();
    expect((await getSetupGuideFacts(db)).onlinePaidProducts).toBe(3);
    // Drafts and trashed products are not for sale.
    sqlite.prepare("UPDATE products SET is_active = 0 WHERE id = 'p_key'").run();
    sqlite.prepare("UPDATE products SET deleted_at = unixepoch() WHERE id = 'p_card'").run();
    expect((await getSetupGuideFacts(db)).onlinePaidProducts).toBe(1);
  });
});
