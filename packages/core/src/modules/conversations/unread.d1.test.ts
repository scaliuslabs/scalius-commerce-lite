import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { findOrderConversationForStaff } from "../orders/fulfilment-reads";
import {
  getBuyerThread, getOrCreateOrderThread, getStaffInboxSummary, getStaffOrderThread, getStaffThread,
  listStaffInbox, markStaffRead, planConversationAppend, postConversationMessage, readThread,
  type ConversationLine,
} from "./index";

describe("staff unread counts incoming public message lines", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let queries: Array<{ sql: string; values: readonly SQLInputValue[] }>;
  const guest: ConversationLine = { kind: "message", visibility: "public", authorType: "guest_receipt", body: "Buyer question" };
  const customer: ConversationLine = { ...guest, authorType: "customer", authorCustomerId: "acct_1" };
  const reply: ConversationLine = { ...guest, authorType: "staff", authorUserId: "staff_1", body: "Staff reply" };
  const note: ConversationLine = { ...reply, visibility: "internal", body: "Private note" };
  const event: ConversationLine = { kind: "event", visibility: "public", authorType: "system", eventKind: "support_request_status" };

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (sql, values) => queries.push({ sql, values }) }));
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
        total_amount_minor, subtotal_amount_minor, status, order_number)
      VALUES ('order_1', 'Buyer', '+8801711111111', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', 1057);
      INSERT INTO customers (id, name, phone, origin) VALUES ('acct_1', 'Buyer', '+8801711111111', 'account');
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Staff', 'staff@example.test', 1, 'admin');
    `);
    queries = [];
  });
  afterEach(() => sqlite.close());

  async function append(id: string, lines: ConversationLine[]) {
    const thread = (await readThread(db, id))!;
    const plan = planConversationAppend(db, thread, lines, { notify: false });
    await db.batch(plan.statements as unknown as Parameters<Database["batch"]>[0]);
  }

  it("counts both incoming authors across notes, replies and events in list/thread/order reads", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await append(thread.id, [guest, reply, note, event, customer, { ...event, authorType: "customer", authorCustomerId: "acct_1" }, guest, event]);
    expect((await readThread(db, thread.id))?.staffReadSeq).toBe(0);
    expect((await listStaffInbox(db, "staff_1", { status: "all" })).items[0]?.unread).toBe(3);
    expect(await getStaffThread(db, thread.id)).toMatchObject({ unread: 3, lastSeq: 8, staffReadSeq: 0 });
    expect(await getStaffOrderThread(db, "order_1")).toMatchObject({ unread: 3 });
    expect(await findOrderConversationForStaff(db, "order_1")).toEqual({ id: thread.id, unread: true });
    const buyer = await getBuyerThread(db, (await readThread(db, thread.id))!);
    expect(JSON.stringify(buyer)).not.toContain("Private note");
    expect(buyer.messages.some((line) => line.from === "store")).toBe(true);
  });

  it("does not acknowledge incoming lines when staff sends either a public reply or note", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await append(thread.id, [guest, customer]);
    for (const visibility of ["public", "internal"] as const) {
      await postConversationMessage(db, (await readThread(db, thread.id))!, {
        actor: { kind: "staff", userId: "staff_1" }, visibility, body: "Staff message",
      });
      expect(await getStaffThread(db, thread.id)).toMatchObject({ unread: 2, staffReadSeq: 0 });
    }
  });

  it("marks only through the displayed sequence and preserves monotonic clamping", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await append(thread.id, [guest, note, customer, event, guest]);
    await markStaffRead(db, thread.id, 2);
    expect(await getStaffThread(db, thread.id)).toMatchObject({ unread: 2, staffReadSeq: 2 });
    await markStaffRead(db, thread.id, 1);
    expect(await getStaffThread(db, thread.id)).toMatchObject({ unread: 2, staffReadSeq: 2 });
    await markStaffRead(db, thread.id, 4);
    expect((await getStaffThread(db, thread.id)).unread).toBe(1);
    await markStaffRead(db, thread.id, 999);
    expect(await getStaffThread(db, thread.id)).toMatchObject({ unread: 0, staffReadSeq: 5 });
    await append(thread.id, [event, note]);
    expect((await getStaffThread(db, thread.id)).unread).toBe(0);
    expect(await findOrderConversationForStaff(db, "order_1")).toEqual({ id: thread.id, unread: false });
  });

  it("keeps a concurrently appended buyer message unread after marking the displayed tail", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await append(thread.id, [guest]);
    const displayed = (await readThread(db, thread.id))!;
    await Promise.all([
      postConversationMessage(db, displayed, { actor: { kind: "guest_receipt", orderId: "order_1" }, body: "Arrived after display" }),
      markStaffRead(db, thread.id, displayed.lastSeq),
    ]);
    expect(await getStaffThread(db, thread.id)).toMatchObject({ lastSeq: 2, staffReadSeq: 1, unread: 1 });
    expect((await getStaffInboxSummary(db, "staff_1")).unread).toBe(1);
  });

  it("returns unread when no thread is open and leaves empty headers out of status counts", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    expect(await getStaffInboxSummary(db, "staff_1")).toEqual({ open: 0, mineOpen: 0, unassignedOpen: 0, unread: 0 });
    await append(thread.id, [guest, customer, reply]);
    expect(await getStaffInboxSummary(db, "staff_1")).toEqual({ open: 0, mineOpen: 0, unassignedOpen: 0, unread: 2 });
    await markStaffRead(db, thread.id, 3);
    expect((await getStaffInboxSummary(db, "staff_1")).unread).toBe(0);
    await expect(markStaffRead(db, thread.id, -1)).rejects.toThrow("Invalid read position");
    await expect(markStaffRead(db, thread.id, 1.5)).rejects.toThrow("Invalid read position");
  });

  it("keeps full-thread unread counts when only an older message page is returned", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await append(thread.id, Array.from({ length: 60 }, () => ({ ...guest })));
    const view = await getStaffThread(db, thread.id, { beforeSeq: 11 });
    expect(view.messages).toHaveLength(10);
    expect(view.messages.at(-1)?.seq).toBe(10);
    expect(view.unread).toBe(60);
  });

  it("returns zero for an empty thread without inventing an unread message", async () => {
    expect(await findOrderConversationForStaff(db, "order_1")).toBeNull();
    const thread = await getOrCreateOrderThread(db, "order_1");
    expect(await getStaffThread(db, thread.id)).toMatchObject({ unread: 0, lastSeq: 0 });
    expect(await findOrderConversationForStaff(db, "order_1")).toEqual({ id: thread.id, unread: false });
  });

  function seedHistory(threadCount: number, lineCount: number) {
    const thread = sqlite.prepare(`INSERT INTO conversations
      (id, subject_type, customer_id, status, closed_at, last_message_at, created_at, updated_at)
      VALUES (?, 'store', 'acct_1', ?, ?, ?, 1, 1)`);
    const advance = sqlite.prepare("UPDATE conversations SET last_seq = ?, last_author_type = ? WHERE id = ?");
    const message = sqlite.prepare(`INSERT INTO conversation_messages
      (id, conversation_id, seq, kind, visibility, author_type, author_user_id, body, event_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    sqlite.exec("BEGIN");
    for (let index = 0; index < threadCount; index++) {
      const id = `cnv_history_${String(index).padStart(5, "0")}`;
      const status = ["open", "pending", "closed"][index % 3]!;
      thread.run(id, status, status === "closed" ? 1 : null, index + 1);
      for (let seq = 1; seq <= lineCount; seq++) {
        const line = seq % 10 === 7 ? reply : seq % 10 === 8 ? note : seq % 10 === 9 ? event : guest;
        advance.run(seq, line.authorType, id);
        message.run(`msg_history_${index}_${seq}`, id, seq, line.kind, line.visibility, line.authorType,
          line.authorUserId ?? null, line.body ?? null, line.eventKind ?? null);
      }
    }
    sqlite.exec("UPDATE conversations SET staff_read_seq = last_seq; COMMIT");
  }

  it("bounds list enrichment to its 25 rows and indexes unread suffixes", async () => {
    seedHistory(30, 10);
    sqlite.exec("UPDATE conversations SET staff_read_seq = 5");
    queries = [];
    const page = await listStaffInbox(db, "staff_1", { status: "all" });
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.every((item) => item.unread === 2)).toBe(true);
    expect(queries).toHaveLength(2);
    const counts = queries[1]!;
    expect(counts.values).toHaveLength(29); // 25 returned thread ids + the four incoming-message predicates.
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${counts.sql}`).all(...counts.values) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => /SEARCH unread_message.*conversation_id=\? AND seq>\?/.test(detail))).toBe(true);
  });

  it("counts global unread beyond the first page across statuses without rereading old message history", async () => {
    seedHistory(300, 100);
    sqlite.exec(`UPDATE conversations SET staff_read_seq = 95 WHERE id IN ('cnv_history_00000', 'cnv_history_00001', 'cnv_history_00002');
      UPDATE conversations SET assignee_user_id = 'staff_1' WHERE id = 'cnv_history_00000'`);
    queries = [];
    const summary = await getStaffInboxSummary(db, "staff_1");
    expect(summary).toEqual({ open: 100, mineOpen: 1, unassignedOpen: 99, unread: 6 });
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values) as Array<{ detail: string }>;
    expect(plan.every(({ detail }) => !/SCAN|conversation_messages|SEARCH conversations /.test(detail))).toBe(true);
    expect(plan.filter(({ detail }) => /SEARCH .*inbox_counts.*scope=\?/.test(detail))).toHaveLength(2);
    sqlite.exec("UPDATE conversations SET staff_read_seq = 0 WHERE id = 'cnv_history_00002'");
    expect((await getStaffInboxSummary(db, "staff_1")).unread).toBe(74);
  });

  it("fails closed if the global counter row is missing", async () => {
    sqlite.exec("DELETE FROM conversation_inbox_counts WHERE scope='*'");
    await expect(getStaffInboxSummary(db, "staff_1")).rejects.toThrow("not initialized");
  });
});
