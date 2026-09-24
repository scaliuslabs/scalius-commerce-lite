import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { customers, orders } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { withPublicMediaUrl } from "../../integrations/storage";
import { getCustomerOrderDetail } from "./customers.service";
import { claimGuestOrderToAccount } from "./order-account-claim";

describe("guest order account claim", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    ({ sqlite, db } = createSqliteD1Database());
    await db.insert(customers).values([
      { id: "guest_crm", name: "Guest", email: "buyer@example.com", phone: "+8801711111111", totalOrders: 1 },
      { id: "account_1", name: "Buyer", email: "buyer@example.com", phone: "+8801722222222" },
      { id: "account_2", name: "Other", email: "other@example.com", phone: "+8801733333333" },
    ]);
    await db.insert(orders).values({
      id: "order_1",
      customerName: "Buyer",
      customerPhone: "+8801722222222",
      customerEmail: "buyer@example.com",
      shippingAddress: "Dhaka",
      city: "dhaka",
      zone: "zone_1",
      totalAmountMinor: 10_000,
      balanceDueMinor: 10_000,
      customerId: "guest_crm",
      accountOwnerCustomerId: null,
    });
  });

  afterEach(() => sqlite.close());

  it("atomically files the receipt-proven order under the account for buyer and merchant alike", async () => {
    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_1",
      customerEmail: "BUYER@example.com",
      customerPhone: "+8801722222222",
    })).resolves.toEqual({
      orderId: "order_1",
      customerId: "account_1",
      alreadyClaimed: false,
    });

    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_1",
      customerEmail: "buyer@example.com",
      customerPhone: "+8801711111111",
    })).resolves.toMatchObject({ alreadyClaimed: true });

    const claimed = await db.select({
      customerId: orders.customerId,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
    }).from(orders).where(eq(orders.id, "order_1")).get();
    const account = await db.select({
      totalOrders: customers.totalOrders,
    }).from(customers).where(eq(customers.id, "account_1")).get();
    expect(claimed).toEqual({ customerId: "account_1", accountOwnerCustomerId: "account_1" });
    expect(account).toEqual({ totalOrders: 0 });
  });

  it("fails closed for a different contact and for an order already owned by another account", async () => {
    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_2",
      customerEmail: "other@example.com",
      customerPhone: "+8801733333333",
    })).rejects.toMatchObject({ status: 403 });

    sqlite.prepare("UPDATE orders SET account_owner_customer_id = ? WHERE id = ?").run("account_1", "order_1");
    await expect(claimGuestOrderToAccount(db, {
      orderId: "order_1",
      customerId: "account_2",
      customerEmail: "buyer@example.com",
      customerPhone: "+8801733333333",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("shows the claimed account the order-line snapshot, never the product's current media", async () => {
    sqlite.exec(`
      UPDATE orders SET account_owner_customer_id = 'account_1' WHERE id = 'order_1';
      INSERT INTO products (id, name, slug, price_minor) VALUES ('product_1', 'Renamed product', 'renamed', 10000);
      INSERT INTO media (id, filename, kind, object_key, size, mime_type) VALUES
        ('med_snapshot0001', 'old.webp', 'image', 'media/med_snapshot0001.webp', 1, 'image/webp'),
        ('med_current00001', 'new.webp', 'image', 'media/med_current00001.webp', 1, 'image/webp');
      INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order)
        VALUES ('pmed_current01', 'product_1', 'med_current00001', 1, 0);
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor, product_name, product_image_media_id)
        VALUES ('item_1', 'order_1', 'product_1', 1, 10000, 'Original name', 'med_snapshot0001');
    `);

    const detail = await withPublicMediaUrl("https://media.example", () => getCustomerOrderDetail(db, "account_1", "order_1"));
    expect(JSON.stringify(detail)).toContain("https://media.example/media/med_snapshot0001.webp");
    expect(JSON.stringify(detail)).not.toContain("med_current00001");
    expect(JSON.stringify(detail)).toContain("Original name");
    await expect(getCustomerOrderDetail(db, "account_2", "order_1")).rejects.toThrow();
  });
});
