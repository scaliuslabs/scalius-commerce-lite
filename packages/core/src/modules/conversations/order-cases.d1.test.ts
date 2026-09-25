import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  createReceiptOrderSupportRequest,
  getBuyerThread,
  getStaffThread,
  readOrderThread,
  updateAdminOrderSupportRequestStatus,
} from "./index";

describe("support requests as cases on the order thread", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status, payment_status, fulfillment_status)
        VALUES ('order_1', 'Rahim', '+8801711111111', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'pending', 'unpaid', 'pending');
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin');
    `);
  });

  afterEach(() => sqlite.close());

  it("records the case, an event and the buyer's words on the order thread in one batch", async () => {
    const result = await createReceiptOrderSupportRequest(db, "order_1", {
      type: "cancel_pre_shipment",
      reason: "Ordered by mistake",
      message: "Please cancel before it ships",
    });
    const thread = await readOrderThread(db, "order_1");
    expect(result.conversationId).toBe(thread?.id);
    expect(sqlite.prepare("SELECT conversation_id, message FROM order_support_requests").get())
      .toEqual({ conversation_id: thread?.id, message: null });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_support_request_events").get()).toEqual({ n: 0 });

    const buyerView = await getBuyerThread(db, thread!);
    expect(buyerView.messages.map((message) => [message.kind, message.from, message.eventKind, message.body])).toEqual([
      ["event", "system", "support_request_submitted", null],
      ["message", "buyer", null, "Ordered by mistake\n\nPlease cancel before it ships"],
    ]);
    expect(thread).toMatchObject({ status: "open", lastSeq: 2, customerReadSeq: 2, staffReadSeq: 0 });

    await expect(createReceiptOrderSupportRequest(db, "order_1", { type: "cancel_pre_shipment", reason: "Again please" }))
      .rejects.toThrow(/already open/);
    expect((await readOrderThread(db, "order_1"))?.lastSeq).toBe(2);
  });

  it("puts a status change on the thread as a public event and the note as an internal note", async () => {
    const created = await createReceiptOrderSupportRequest(db, "order_1", { type: "cancel_pre_shipment", reason: "Ordered by mistake" });
    const updated = await updateAdminOrderSupportRequestStatus(db, "order_1", created.request.id, {
      status: "rejected",
      note: "Already packed; offer a return instead",
      actorId: "staff_1",
    });
    expect(updated).toMatchObject({ statusChanged: true, previousStatus: "submitted", newStatus: "rejected" });

    const staffView = await getStaffThread(db, created.conversationId);
    expect(staffView.messages.slice(-2).map((message) => [message.kind, message.visibility, message.eventKind, message.body])).toEqual([
      ["event", "public", "support_request_status", null],
      ["message", "internal", null, "Already packed; offer a return instead"],
    ]);
    expect(staffView.cases).toEqual([expect.objectContaining({ id: created.request.id, status: "rejected", active: false })]);

    const buyerView = await getBuyerThread(db, (await readOrderThread(db, "order_1"))!);
    expect(JSON.stringify(buyerView)).not.toContain("offer a return instead");
    expect(buyerView.messages.at(-1)).toMatchObject({ eventKind: "support_request_status", eventData: { toStatus: "rejected" } });
  });
});
