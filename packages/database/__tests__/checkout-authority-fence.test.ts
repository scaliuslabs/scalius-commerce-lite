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
      INSERT INTO products (id, name, price, slug, is_active)
      VALUES ('product_fence', 'Fence product', 100, 'fence-product', 1);
      INSERT INTO product_variants (
        id, product_id, sku, price, stock, reserved_stock,
        stock_version, track_inventory, is_default
      ) VALUES (
        'variant_fence', 'product_fence', 'FENCE-1', 100, 100, 0,
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
      SET price = 125, version = version + 1, updated_at = unixepoch()
      WHERE id = 'variant_fence';
    `);
    expect(revision(database)).toBe(beforeInventory + 1);

    const beforeShipping = revision(database);
    database.exec(`
      INSERT INTO shipping_methods (
        id, name, fee, is_active, sort_order, created_at, updated_at
      ) VALUES (
        'shipping_fence', 'Fence shipping', 60, 1, 0, unixepoch(), unixepoch()
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

    const beforeMeta = revision(database);
    database.exec(`
      INSERT INTO meta_conversions_settings (
        id, singleton_key, pixel_id, access_token, is_enabled,
        log_retention_days, created_at, updated_at
      ) VALUES (
        'meta_fence', 'default', 'pixel_fence', 'token_fence', 0,
        30, unixepoch(), unixepoch()
      );
    `);
    expect(revision(database)).toBe(beforeMeta + 1);

    database.exec(`
      UPDATE meta_conversions_settings
      SET is_enabled = 1, updated_at = unixepoch()
      WHERE id = 'meta_fence';
    `);
    expect(revision(database)).toBe(beforeMeta + 2);

    const beforeRetention = revision(database);
    database.exec(`
      UPDATE meta_conversions_settings
      SET log_retention_days = 60, updated_at = unixepoch()
      WHERE id = 'meta_fence';
    `);
    expect(revision(database)).toBe(beforeRetention);
  });
});
