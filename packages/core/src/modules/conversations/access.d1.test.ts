import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  createStoreThread,
  getBuyerThread,
  listBuyerThreads,
  postBuyerOrderMessage,
  postStaffOrderMessage,
  resolveBuyerThread,
} from "./index";

/**
 * C1: buyer access to threads (account owner, receipt proof, verified account)
 * including a guest order claimed later and a merged guest record.
 * C2: posting never touches customers or orders contacts.
 */
describe("conversation access (C1) and identity safety (C2)", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO customers (id, name, phone, email, origin, account_claimed_at, phone_verified_at)
        VALUES ('acct_verified', 'Rahim', '+8801711111111', 'rahim@example.test', 'account', 1780000000, 1780000000),
               ('acct_other', 'Karim', '+8801722222222', NULL, 'account', 1780000000, 1780000000),
               ('acct_unverified', 'Guest', '+8801733333333', NULL, 'order', NULL, NULL);
      INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status, account_owner_customer_id, customer_id)
        VALUES ('order_owned', 'Rahim', '+8801711111111', 'rahim@example.test', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', 'acct_verified', 'acct_verified'),
               ('order_guest', 'Guest Buyer', '+8801744444444', NULL, 'House 2', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', NULL, 'acct_unverified');
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin');
    `);
  });

  afterEach(() => sqlite.close());

  const snapshot = () => ({
    customers: sqlite.prepare("SELECT * FROM customers ORDER BY id").all(),
    orders: sqlite.prepare("SELECT id, customer_name, customer_phone, customer_email, customer_id, account_owner_customer_id, updated_at FROM orders ORDER BY id").all(),
  });

  it("lets the verified owner and the receipt holder use an order thread, and nobody else", async () => {
    const posted = await postBuyerOrderMessage(db, "order_owned", {
      actor: { kind: "customer", customerId: "acct_verified" },
      body: "Is my parcel on the way?",
    });

    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_verified" }, posted.conversationId)).resolves.toMatchObject({ id: posted.conversationId });
    await expect(resolveBuyerThread(db, { kind: "guest_receipt", orderId: "order_owned" }, posted.conversationId)).resolves.toMatchObject({ id: posted.conversationId });
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_other" }, posted.conversationId)).rejects.toThrow("Conversation not found");
    await expect(resolveBuyerThread(db, { kind: "guest_receipt", orderId: "order_guest" }, posted.conversationId)).rejects.toThrow("Conversation not found");
    await expect(postBuyerOrderMessage(db, "order_owned", { actor: { kind: "customer", customerId: "acct_other" }, body: "hi" }))
      .rejects.toThrow("Conversation not found");
  });

  it("carries a guest order's thread into the account that claims the order, with no thread write", async () => {
    const guest = await postBuyerOrderMessage(db, "order_guest", {
      actor: { kind: "guest_receipt", orderId: "order_guest" },
      body: "Can I change the size?",
    });
    const before = sqlite.prepare("SELECT * FROM conversations").all();
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_other" }, guest.conversationId)).rejects.toThrow();

    // The order is claimed by a verified account (customers/order-account-claim).
    sqlite.exec("UPDATE orders SET account_owner_customer_id = 'acct_other' WHERE id = 'order_guest'");
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_other" }, guest.conversationId)).resolves.toMatchObject({ id: guest.conversationId });
    expect((await listBuyerThreads(db, "acct_other")).items.map((item) => item.id)).toEqual([guest.conversationId]);
    expect(sqlite.prepare("SELECT * FROM conversations").all()).toEqual(before);
  });

  it("does not leak a thread through a merged guest record: threads follow the order, never the customer row", async () => {
    const guest = await postBuyerOrderMessage(db, "order_guest", {
      actor: { kind: "guest_receipt", orderId: "order_guest" },
      body: "Hello",
    });
    expect(sqlite.prepare("SELECT customer_id FROM conversations WHERE id = ?").get(guest.conversationId)).toEqual({ customer_id: null });
    // The guest record is merged into another account, but the order was never claimed by it.
    sqlite.exec("UPDATE customers SET merged_into_customer_id = 'acct_verified', deleted_at = 1780000500 WHERE id = 'acct_unverified'");
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_verified" }, guest.conversationId)).rejects.toThrow();
    expect((await listBuyerThreads(db, "acct_verified")).items).toEqual([]);
  });

  it("derives buyer access for warranty-claim and review threads from their order (decision 28)", async () => {
    sqlite.exec(`
      INSERT INTO conversations (id, subject_type, subject_id, order_id, status, last_message_at, created_at, updated_at)
        VALUES ('cnv_claim_owned01', 'warranty_claim', 'wcl_owned', 'order_owned', 'open', 1780000100, 1780000100, 1780000100),
               ('cnv_review_owned1', 'review', 'rev_owned', 'order_owned', 'open', 1780000200, 1780000200, 1780000200),
               ('cnv_review_guest1', 'review', 'rev_guest', 'order_guest', 'open', 1780000300, 1780000300, 1780000300);
    `);
    const owner = { kind: "customer", customerId: "acct_verified" } as const;
    await expect(resolveBuyerThread(db, owner, "cnv_claim_owned01")).resolves.toMatchObject({ subjectType: "warranty_claim" });
    await expect(resolveBuyerThread(db, owner, "cnv_review_owned1")).resolves.toMatchObject({ subjectType: "review" });
    await expect(resolveBuyerThread(db, { kind: "guest_receipt", orderId: "order_owned" }, "cnv_claim_owned01")).resolves.toBeTruthy();
    // Another order's threads stay 404 for the owner, another account and the wrong receipt.
    await expect(resolveBuyerThread(db, owner, "cnv_review_guest1")).rejects.toThrow("Conversation not found");
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_other" }, "cnv_claim_owned01")).rejects.toThrow("Conversation not found");
    await expect(resolveBuyerThread(db, { kind: "guest_receipt", orderId: "order_guest" }, "cnv_review_owned1")).rejects.toThrow("Conversation not found");
    expect((await listBuyerThreads(db, "acct_verified")).items.map((item) => item.id)).toEqual(["cnv_review_owned1", "cnv_claim_owned01"]);
    expect((await listBuyerThreads(db, "acct_other")).items).toEqual([]);

    // Claiming the guest order carries its review thread into the account, with no thread write.
    const before = sqlite.prepare("SELECT * FROM conversations").all();
    sqlite.exec("UPDATE orders SET account_owner_customer_id = 'acct_other' WHERE id = 'order_guest'");
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_other" }, "cnv_review_guest1")).resolves.toMatchObject({ id: "cnv_review_guest1" });
    expect((await listBuyerThreads(db, "acct_other")).items.map((item) => item.id)).toEqual(["cnv_review_guest1"]);
    expect(sqlite.prepare("SELECT * FROM conversations").all()).toEqual(before);
  });

  it("allows store threads only for verified accounts and only to their owner", async () => {
    await expect(createStoreThread(db, "acct_unverified", { subject: "Question", body: "Do you ship abroad?" }))
      .rejects.toThrow("Verify your phone or email");
    const created = await createStoreThread(db, "acct_verified", { subject: "Question", body: "Do you ship abroad?" });
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_verified" }, created.conversationId)).resolves.toBeTruthy();
    await expect(resolveBuyerThread(db, { kind: "customer", customerId: "acct_other" }, created.conversationId)).rejects.toThrow();
    await expect(resolveBuyerThread(db, { kind: "guest_receipt", orderId: "order_owned" }, created.conversationId)).rejects.toThrow();
  });

  it("caps open store threads per account at five", async () => {
    for (let index = 0; index < 5; index += 1) {
      await createStoreThread(db, "acct_verified", { subject: `Question ${index}`, body: "Hello" });
    }
    await expect(createStoreThread(db, "acct_verified", { subject: "Sixth", body: "Hello" })).rejects.toThrow("several open conversations");
  });

  it("C2: posting, replying and starting threads never change customers or order contacts", async () => {
    const before = snapshot();
    const order = await postBuyerOrderMessage(db, "order_guest", {
      actor: { kind: "guest_receipt", orderId: "order_guest" },
      body: "My number changed to 01799999999, email new@example.test",
    });
    await postStaffOrderMessage(db, "order_guest", { actor: { kind: "staff", userId: "staff_1" }, body: "Thanks, noted." });
    await createStoreThread(db, "acct_verified", { subject: "Hi", body: "Please update my address" });
    const thread = await getBuyerThread(db, (await resolveBuyerThread(db, { kind: "guest_receipt", orderId: "order_guest" }, order.conversationId)));
    expect(thread.messages.map((message) => message.from)).toEqual(["buyer", "store"]);
    expect(snapshot()).toEqual(before);
  });
});
