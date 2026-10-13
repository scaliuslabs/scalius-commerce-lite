import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import {
  readConversationCartShare,
  shareConversationCart,
  withdrawConversationCart,
  type CartShareLine,
} from "./cart-share";

describe("explicit conversation cart sharing", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const owner = { kind: "customer", customerId: "acct_owner" } as const;
  const guest = { kind: "guest_receipt", orderId: "order_guest" } as const;
  const line = { productId: "product_a", skuId: "sku_a", quantity: 1 };
  const storeThread = "cnv_store_owner";
  const guestThread = "cnv_order_guest";

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_100_000);
    sqlite.exec(`
      INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at)
        VALUES ('acct_owner', 'Owner', '+8801711111111', 'account', 1780000000, 1780000000),
               ('acct_other', 'Other', '+8801722222222', 'account', 1780000000, 1780000000);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
          city_name, zone_name, total_amount_minor, subtotal_amount_minor, status, account_owner_customer_id)
        VALUES ('order_owned', 'Owner', '+8801711111111', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', 'acct_owner'),
               ('order_guest', 'Guest', '+8801733333333', 'House 2', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', NULL);
      INSERT INTO conversations (id, subject_type, order_id, customer_id, status, closed_at)
        VALUES ('cnv_store_owner', 'store', NULL, 'acct_owner', 'closed', 1780000000),
               ('cnv_order_guest', 'order', 'order_guest', NULL, 'open', NULL),
               ('cnv_order_owned', 'order', 'order_owned', NULL, 'open', NULL);
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it("versions creation, updates, withdrawal and explicit re-sharing without changing commerce or messages", async () => {
    const snapshot = () => ({
      threads: sqlite.prepare("SELECT * FROM conversations ORDER BY id").all(),
      orders: sqlite.prepare("SELECT * FROM orders ORDER BY id").all(),
      messages: sqlite.prepare("SELECT * FROM conversation_messages").all(),
      notifications: sqlite.prepare("SELECT * FROM notification_outbox").all(),
    });
    const before = snapshot();
    expect(await readConversationCartShare(db, storeThread)).toBeNull();
    const first = await shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: 0 });
    expect(first).toEqual({ lines: [line], sharedAt: 1780000100, withdrawnAt: null, version: 1 });
    await expect(shareConversationCart(db, owner, storeThread, { lines: [], expectedVersion: 0 }))
      .rejects.toBeInstanceOf(ConflictError);

    vi.mocked(Date.now).mockReturnValue(1_780_000_200_000);
    const updated = await shareConversationCart(db, owner, storeThread, { lines: [{ ...line, quantity: 2 }], expectedVersion: 1 });
    expect(updated).toMatchObject({ lines: [{ ...line, quantity: 2 }], sharedAt: 1780000200, version: 2 });
    await expect(withdrawConversationCart(db, owner, storeThread, 1)).rejects.toBeInstanceOf(ConflictError);

    vi.mocked(Date.now).mockReturnValue(1_780_000_300_000);
    const withdrawn = await withdrawConversationCart(db, owner, storeThread, 2);
    expect(withdrawn).toEqual({ lines: [], sharedAt: 1780000200, withdrawnAt: 1780000300, version: 3 });
    expect(await readConversationCartShare(db, storeThread)).toEqual(withdrawn);
    await expect(shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: 2 }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: 0 }))
      .rejects.toBeInstanceOf(ConflictError);

    vi.mocked(Date.now).mockReturnValue(1_780_000_400_000);
    expect(await shareConversationCart(db, owner, storeThread, { lines: [], expectedVersion: 3 }))
      .toEqual({ lines: [], sharedAt: 1780000400, withdrawnAt: null, version: 4 });
    expect(snapshot()).toEqual(before);
  });

  it("merges duplicate SKUs before the 99-item limit and rejects mismatched products or excessive quantities", async () => {
    const lines = Array.from({ length: 99 }, (_, i) => ({ productId: `product_${i}`, skuId: `sku_${i}`, quantity: 1 }));
    const result = await shareConversationCart(db, owner, storeThread, {
      lines: [...lines, { ...lines[0]!, quantity: 2 }], expectedVersion: 0,
    });
    expect(result.lines).toHaveLength(99);
    expect(result.lines[0]?.quantity).toBe(3);
    for (const invalid of [
      [...lines, line],
      [line, { ...line, productId: "another_product" }],
      [{ ...line, quantity: 99 }, line],
      [{ ...line, quantity: 0 }],
      [{ ...line, quantity: -1 }],
      [{ ...line, quantity: 1.5 }],
      [{ ...line, quantity: 100 }],
      [{ ...line, productId: "invalid/id" }],
      [{ ...line, skuId: "s".repeat(129) }],
      [null] as unknown as CartShareLine[],
    ]) {
      await expect(shareConversationCart(db, owner, storeThread, { lines: invalid, expectedVersion: 1 }))
        .rejects.toBeInstanceOf(ValidationError);
    }
    expect(await readConversationCartShare(db, storeThread)).toEqual(result);
  });

  it("allows only the verified store-thread owner and the exact order owner or receipt holder", async () => {
    const first = await shareConversationCart(db, guest, guestThread, { lines: [line], expectedVersion: 0 });
    expect(first.version).toBe(1);
    await expect(shareConversationCart(db, owner, "cnv_order_owned", { lines: [line], expectedVersion: 0 }))
      .resolves.toMatchObject({ version: 1 });
    for (const [actor, thread] of [
      [{ kind: "customer", customerId: "acct_other" }, storeThread],
      [guest, storeThread],
      [guest, "cnv_order_owned"],
      [owner, guestThread],
      [{ kind: "staff", userId: "staff_1" }, guestThread],
    ] as const) {
      await expect(shareConversationCart(db, actor, thread, { lines: [line], expectedVersion: 0 }))
        .rejects.toBeInstanceOf(NotFoundError);
      await expect(withdrawConversationCart(db, actor, thread, 1)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await withdrawConversationCart(db, guest, guestThread, 1)).toMatchObject({ lines: [], version: 2 });
    sqlite.exec("UPDATE customers SET phone_verified_at = NULL WHERE id = 'acct_owner'");
    await expect(shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: 0 }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("retains bounded server-resolved labels until the buyer withdraws them", async () => {
    const labeled = { ...line, title: "Shirt", variantLabel: "Size: M" };
    const share = await shareConversationCart(db, owner, storeThread, { lines: [labeled], expectedVersion: 0 });
    expect((await readConversationCartShare(db, storeThread))?.lines).toEqual([labeled]);
    for (const invalid of [
      { ...labeled, title: "😀".repeat(161) },
      { ...labeled, variantLabel: "😀".repeat(81) },
    ]) {
      await expect(shareConversationCart(db, owner, storeThread, { lines: [invalid], expectedVersion: share.version }))
        .rejects.toBeInstanceOf(ValidationError);
    }
    await withdrawConversationCart(db, owner, storeThread, share.version);
    expect(sqlite.prepare("SELECT lines_json FROM conversation_cart_shares").get()).toEqual({ lines_json: "[]" });
  });

  it("rejects missing or invalid versions and admits only one concurrent update", async () => {
    await expect(withdrawConversationCart(db, owner, storeThread, 1)).rejects.toBeInstanceOf(ConflictError);
    for (const version of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
      await expect(shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: version }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(withdrawConversationCart(db, owner, storeThread, version)).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(withdrawConversationCart(db, owner, storeThread, 0)).rejects.toBeInstanceOf(ValidationError);
    const created = await Promise.allSettled([
      shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: 0 }),
      shareConversationCart(db, owner, storeThread, { lines: [], expectedVersion: 0 }),
    ]);
    expect(created.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const changed = await Promise.allSettled([
      shareConversationCart(db, owner, storeThread, { lines: [line], expectedVersion: 1 }),
      withdrawConversationCart(db, owner, storeThread, 1),
    ]);
    expect(changed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await readConversationCartShare(db, storeThread))?.version).toBe(2);
  });
});
