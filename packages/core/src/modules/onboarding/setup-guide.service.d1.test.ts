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
      themePublished: false,
      shippingReady: false,
      hasOrders: false,
    });
  });

  it("counts a product until it is in the trash", async () => {
    sqlite.prepare("INSERT INTO products (id, name, slug) VALUES ('p1', 'Panjabi', 'panjabi')").run();
    expect((await getSetupGuideFacts(db)).hasProducts).toBe(true);
    sqlite.prepare("UPDATE products SET deleted_at = unixepoch() WHERE id = 'p1'").run();
    expect((await getSetupGuideFacts(db)).hasProducts).toBe(false);
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
});
