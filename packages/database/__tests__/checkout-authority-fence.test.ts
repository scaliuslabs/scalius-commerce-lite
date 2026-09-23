import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProviderSchemaDatabase } from "../scripts/sqlite-provider-schema";

function revision(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT revision FROM checkout_authority WHERE id = 'default'
  `).get() as { revision: number } | undefined;
  return Number(row?.revision);
}

describe("checkout authority fence", () => {
  let database: DatabaseSync;

  beforeEach(async () => {
    database = await createProviderSchemaDatabase("d1");
    database.exec(`
      INSERT INTO products (id, name, price_minor, slug, is_active)
      VALUES ('product_fence', 'Fence product', 10000, 'fence-product', 1);
      INSERT INTO product_variants (
        id, product_id, sku, price_minor, stock, reserved_stock,
        stock_version, track_inventory, is_default
      ) VALUES (
        'variant_fence', 'product_fence', 'FENCE-1', 10000, 100, 0,
        1, 1, 1
      );
    `);
  });

  afterEach(() => database.close());

  it("advances for economic changes but not ordinary inventory reservations", () => {
    const beforeInventory = revision(database);
    database.exec(`
      UPDATE product_variants
      SET stock = 99, reserved_stock = 1, stock_version = stock_version + 1,
          updated_at = unixepoch()
      WHERE id = 'variant_fence';
    `);
    expect(revision(database)).toBe(beforeInventory);

    database.exec(`
      UPDATE product_variants
      SET price_minor = 12500, version = version + 1, updated_at = unixepoch()
      WHERE id = 'variant_fence';
    `);
    expect(revision(database)).toBe(beforeInventory + 1);

    const beforeShipping = revision(database);
    database.exec(`
      INSERT INTO shipping_methods (
        id, name, fee_minor, is_active, sort_order, created_at, updated_at
      ) VALUES (
        'shipping_fence', 'Fence shipping', 6000, 1, 0, unixepoch(), unixepoch()
      );
    `);
    expect(revision(database)).toBe(beforeShipping + 1);
  });

  it("fences side-effect target changes without churning on token liveness timestamps", () => {
    database.exec(`
      INSERT INTO user (id, name, email, role, created_at, updated_at)
      VALUES ('admin_fence', 'Fence admin', 'fence@example.com', 'admin', unixepoch(), unixepoch());
    `);

    const beforeInactiveToken = revision(database);
    database.exec(`
      INSERT INTO admin_fcm_tokens (
        id, user_id, token, is_active, created_at, updated_at
      ) VALUES (
        'fcm_fence', 'admin_fence', 'token_fence', 0, unixepoch(), unixepoch()
      );
    `);
    expect(revision(database)).toBe(beforeInactiveToken);

    database.exec(`
      UPDATE admin_fcm_tokens
      SET is_active = 1, updated_at = unixepoch()
      WHERE id = 'fcm_fence';
    `);
    expect(revision(database)).toBe(beforeInactiveToken + 1);

    const beforeLastUsed = revision(database);
    database.exec(`
      UPDATE admin_fcm_tokens
      SET last_used = unixepoch(), updated_at = unixepoch()
      WHERE id = 'fcm_fence';
    `);
    expect(revision(database)).toBe(beforeLastUsed);

    // Meta CAPI settings are a settings document; every stored change fences checkout.
    const beforeMeta = revision(database);
    database.exec(`
      INSERT INTO settings (id, key, value, type, category)
      VALUES ('meta_fence', 'document', '{"pixelId":"pixel_fence","isEnabled":false}', 'json', 'meta_conversions');
    `);
    expect(revision(database)).toBe(beforeMeta + 1);

    database.exec(`
      UPDATE settings
      SET value = '{"pixelId":"pixel_fence","isEnabled":true}', revision = revision + 1
      WHERE id = 'meta_fence';
    `);
    expect(revision(database)).toBe(beforeMeta + 2);

    const beforeTimestamp = revision(database);
    database.exec(`
      UPDATE settings SET updated_at = unixepoch() + 1 WHERE id = 'meta_fence';
    `);
    expect(revision(database)).toBe(beforeTimestamp);
  });
});
