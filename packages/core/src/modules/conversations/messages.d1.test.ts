import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  getBuyerThread,
  getOrCreateOrderThread,
  getStaffInboxSummary,
  getStaffThread,
  listStaffInbox,
  markBuyerRead,
  markStaffRead,
  postConversationMessage,
  readThread,
  stageConversationAttachment,
  sweepOrphanConversationAttachments,
  updateStaffThread,
} from "./index";

/** C3: append-only messages, gap-free seq under concurrency, idempotent keys; plus status, unread and attachments. */
describe("conversation messages (C3)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const buyer = { kind: "guest_receipt" as const, orderId: "order_1" };
  const staff = { kind: "staff" as const, userId: "staff_1" };

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status, order_number)
        VALUES ('order_1', 'Rahim', '+8801711111111', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', 1057);
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin');
    `);
  });

  afterEach(() => sqlite.close());

  const seqs = () => (sqlite.prepare("SELECT seq FROM conversation_messages ORDER BY seq").all() as Array<{ seq: number }>).map((row) => row.seq);

  it("keeps seq gap-free and contiguous when many posts race", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      postConversationMessage(db, thread, {
        actor: index % 2 === 0 ? buyer : staff,
        body: `Message ${index}`,
        clientMessageKey: `key-${index}`,
      })));
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    // Lost races retry up to three times; whatever landed is contiguous from 1.
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(seqs()).toEqual(Array.from({ length: fulfilled.length }, (_, index) => index + 1));
    expect((await readThread(db, thread.id))?.lastSeq).toBe(fulfilled.length);
  });

  it("returns the first message for a repeated client key instead of posting twice", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    const first = await postConversationMessage(db, thread, { actor: buyer, body: "Hello", clientMessageKey: "same" });
    const again = await postConversationMessage(db, (await readThread(db, thread.id))!, { actor: buyer, body: "Hello", clientMessageKey: "same" });
    expect(again).toEqual({ ...first, created: false });
    expect(seqs()).toEqual([1]);
  });

  it("is append-only: stored messages can't be edited or deleted, and threads can't be deleted", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await postConversationMessage(db, thread, { actor: buyer, body: "Hello" });
    expect(() => sqlite.exec("UPDATE conversation_messages SET body = 'changed'")).toThrow(/append-only/);
    expect(() => sqlite.exec("DELETE FROM conversation_messages")).toThrow(/append-only/);
    expect(() => sqlite.exec("DELETE FROM conversations")).toThrow(/durable/);
  });

  it("moves status with the conversation: buyer opens, public reply waits on the buyer, notes change nothing", async () => {
    let thread = await getOrCreateOrderThread(db, "order_1");
    await postConversationMessage(db, thread, { actor: buyer, body: "Where is it?" });
    thread = (await readThread(db, thread.id))!;
    expect(thread).toMatchObject({ status: "open", customerReadSeq: 1, staffReadSeq: 0 });

    await postConversationMessage(db, thread, { actor: staff, body: "Checking with the courier", visibility: "internal" });
    thread = (await readThread(db, thread.id))!;
    expect(thread).toMatchObject({ status: "open", lastSeq: 2, staffReadSeq: 2, customerReadSeq: 2 });

    await postConversationMessage(db, thread, { actor: staff, body: "It arrives tomorrow." });
    thread = (await readThread(db, thread.id))!;
    expect(thread.status).toBe("pending");

    const updated = await updateStaffThread(db, thread.id, { version: thread.version, status: "closed" });
    expect(updated.status).toBe("closed");
    await expect(updateStaffThread(db, thread.id, { version: thread.version, status: "open" })).rejects.toThrow("Someone else changed");

    await postConversationMessage(db, (await readThread(db, thread.id))!, { actor: buyer, body: "Thanks!" });
    expect((await readThread(db, thread.id))?.status).toBe("open");
  });

  it("counts unread per side, and a buyer never sees internal notes as unread", async () => {
    let thread = await getOrCreateOrderThread(db, "order_1");
    await postConversationMessage(db, thread, { actor: buyer, body: "Hello" });
    thread = (await readThread(db, thread.id))!;
    await postConversationMessage(db, thread, { actor: staff, body: "Reply" });
    thread = (await readThread(db, thread.id))!;
    await postConversationMessage(db, thread, { actor: staff, body: "Note", visibility: "internal" });
    thread = (await readThread(db, thread.id))!;

    const buyerView = await getBuyerThread(db, thread);
    expect(buyerView.unread).toBe(1);
    expect(buyerView.messages.map((message) => message.body)).toEqual(["Hello", "Reply"]);
    await markBuyerRead(db, thread, 2);
    thread = (await readThread(db, thread.id))!;
    expect(thread.customerReadSeq).toBe(3);
    expect((await getBuyerThread(db, thread)).unread).toBe(0);

    const inbox = await listStaffInbox(db, "staff_1", { status: "all" });
    expect(inbox.items[0]).toMatchObject({ id: thread.id, orderNumber: "#1057", customerName: "Rahim", unread: 0, preview: "Note" });
    await postConversationMessage(db, thread, { actor: buyer, body: "Any update?" });
    expect((await getStaffInboxSummary(db, "staff_1")).open).toBe(1);
    expect((await listStaffInbox(db, "staff_1", { status: "open", q: "1057" })).items[0]?.unread).toBe(1);
    await markStaffRead(db, thread.id, 99);
    expect((await readThread(db, thread.id))?.staffReadSeq).toBe(4);
  });

  it("caps buyer messages per thread per day", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    for (let index = 0; index < 30; index += 1) {
      await postConversationMessage(db, (await readThread(db, thread.id))!, { actor: buyer, body: `m${index}` });
    }
    await expect(postConversationMessage(db, (await readThread(db, thread.id))!, { actor: buyer, body: "one more" }))
      .rejects.toThrow("a lot of messages");
    // Staff replies are never capped.
    await expect(postConversationMessage(db, (await readThread(db, thread.id))!, { actor: staff, body: "ok" })).resolves.toBeTruthy();
  });

  it("attaches the uploader's own staged images once, at most three per message, and sweeps orphans", async () => {
    const bucket = { put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) } as unknown as R2Bucket;
    const thread = await getOrCreateOrderThread(db, "order_1");
    const image = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer;
    const staged = [];
    for (let index = 0; index < 4; index += 1) {
      staged.push(await stageConversationAttachment(db, bucket, { conversationId: thread.id, actor: buyer, webp: image, width: 10, height: 10 }));
    }
    const other = await stageConversationAttachment(db, bucket, { conversationId: thread.id, actor: staff, webp: image, width: 10, height: 10 });

    await expect(postConversationMessage(db, thread, { actor: buyer, body: "Screenshots", attachmentIds: staged.map((row) => row.id) }))
      .rejects.toThrow("up to 3 images");
    await expect(postConversationMessage(db, thread, { actor: buyer, body: "Theirs", attachmentIds: [other.id] }))
      .rejects.toThrow("missing or already attached");

    await postConversationMessage(db, thread, { actor: buyer, body: "bKash screenshot", attachmentIds: [staged[0]!.id, staged[1]!.id] });
    const view = await getStaffThread(db, thread.id);
    expect(view.messages[0]?.attachments.map((attachment) => attachment.id).sort()).toEqual([staged[0]!.id, staged[1]!.id].sort());
    await expect(postConversationMessage(db, (await readThread(db, thread.id))!, { actor: buyer, body: "Again", attachmentIds: [staged[0]!.id] }))
      .rejects.toThrow("missing or already attached");

    const swept = await sweepOrphanConversationAttachments(db, bucket, { now: Math.floor(Date.now() / 1000) + 3601 });
    expect(swept).toEqual({ scanned: 3, deleted: 3 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_attachments").get()).toEqual({ n: 2 });
  });
});
