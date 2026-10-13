import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getConversationContext, getBuyerThread, getOrCreateOrderThread, getStaffThread, listConversationAssignees,
  postConversationMessage, queryStaffInbox, readThread, replayConversationPost, updateStaffThread } from "./index";

describe("conversation workspace authority", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const actor = { kind: "staff", userId: "staff_1" } as const;
  const products = [{ productId: "product_1", skuId: "sku_1", title: "Blue shirt", variantLabel: "Large" }];
  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO customers (id,name,phone,email,origin,account_claimed_at,phone_verified_at)
        VALUES ('account_1','Buyer','+8801711111111','buyer@example.test','account',1780000000,1780000000);
      INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,city_name,zone_name,total_amount_minor,subtotal_amount_minor,status,account_owner_customer_id)
        VALUES ('order_1','Buyer','+8801711111111','House','c','z','Dhaka','Mirpur',1000,1000,'confirmed','account_1'),
          ('order_guest','Buyer','+8801711111111','House','c','z','Dhaka','Mirpur',2000,2000,'confirmed',NULL);
      INSERT INTO user (id,name,email,email_verified,role,is_super_admin)
        VALUES ('staff_1','Nadia','nadia@example.test',1,'admin',1),('staff_2','Reader','reader@example.test',1,'admin',0);
    `);
  });
  afterEach(() => sqlite.close());

  it("stores card-only replies honestly, notifies, counts unread and supports exact safe replay", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    const posted = await postConversationMessage(db, thread, { actor, body: "  ", products, clientMessageKey: "card-only" });
    expect(sqlite.prepare("SELECT body,kind,event_kind,visibility FROM conversation_messages").get())
      .toEqual({ body: null, kind: "event", event_kind: "product_reply", visibility: "public" });
    expect(sqlite.prepare("SELECT notification_type FROM notification_outbox").all()).toEqual([{ notification_type: "conversation_reply" }]);
    const fresh = (await readThread(db, thread.id))!;
    expect(fresh.status).toBe("pending");
    const buyer = await getBuyerThread(db, fresh);
    expect(buyer.unread).toBe(1);
    expect(buyer.messages[0]).toMatchObject({ from: "store", body: null, eventData: { v: 1, cards: products } });
    expect(JSON.stringify(buyer)).not.toContain("staff_1");
    expect(await replayConversationPost(db, thread.id, { actor, products: [{ productId: "product_1", skuId: "sku_1" }], clientMessageKey: "card-only" }))
      .toEqual({ ...posted, created: false });
    await expect(postConversationMessage(db, fresh, { actor, body: "Changed", products, clientMessageKey: "card-only" })).rejects.toThrow("different content");
    await expect(postConversationMessage(db, fresh, { actor, products, visibility: "internal" })).rejects.toThrow("public staff reply");
  });

  it("rejects a changed text retry and rolls search terms back when an append fails", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await postConversationMessage(db, thread, { actor, body: "Original", clientMessageKey: "retry" });
    await expect(postConversationMessage(db, (await readThread(db, thread.id))!, { actor, body: "Changed", clientMessageKey: "retry" })).rejects.toThrow("different content");
    sqlite.exec(`CREATE TRIGGER workspace_search_failure BEFORE INSERT ON conversation_search_terms
      WHEN NEW.term = 'failing' BEGIN SELECT RAISE(ABORT,'index unavailable'); END`);
    await expect(postConversationMessage(db, (await readThread(db, thread.id))!, { actor, body: "failing words" })).rejects.toThrow();
    expect((await readThread(db, thread.id))?.lastSeq).toBe(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_search_terms WHERE term='words'").get()).toEqual({ n: 0 });
  });

  it("assigns only currently eligible staff and rejects a ban racing the assignment write", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    expect((await listConversationAssignees(db)).items.map((row) => row.id)).toEqual(["staff_1"]);
    await expect(updateStaffThread(db, thread.id, { version: thread.version, assigneeUserId: "staff_2" })).rejects.toThrow("active teammate");
    const changed = await updateStaffThread(db, thread.id, { version: thread.version, assigneeUserId: "staff_1" });
    expect(changed.assigneeEligible).toBe(true);
    sqlite.exec("UPDATE user SET banned=1 WHERE id='staff_1'");
    expect((await getStaffThread(db, thread.id)).assigneeEligible).toBe(false);
    await expect(updateStaffThread(db, thread.id, { version: changed.version, assigneeUserId: "staff_1" })).rejects.toThrow("active teammate");
    const unassigned = await updateStaffThread(db, thread.id, { version: changed.version, assigneeUserId: null, status: "pending" });
    expect(unassigned).toMatchObject({ assigneeUserId: null, status: "pending" });
  });

  it("finds message bodies privately and preserves truthful unread, note labels and around windows", async () => {
    let thread = await getOrCreateOrderThread(db, "order_1");
    for (let i = 1; i <= 60; i++) {
      await postConversationMessage(db, thread, { actor: i === 1 ? { kind: "guest_receipt", orderId: "order_1" } : actor,
        body: i === 30 ? "বাংলা পাঞ্জাবি" : `Line ${i}`, visibility: i === 60 ? "internal" : "public" });
      thread = (await readThread(db, thread.id))!;
    }
    const page = await queryStaffInbox(db, actor.userId, { status: "all", q: "পাঞ্জাবি", unread: true });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ unread: 1, lastMessageVisibility: "internal" });
    const around = await getStaffThread(db, thread.id, { aroundSeq: 30 });
    expect(around.messages[0]!.seq).toBe(6);
    expect(around.messages.at(-1)!.seq).toBe(55);
    expect(around).toMatchObject({ hasMore: true, hasNewer: true });
  });

  it("returns a continuation for an empty bounded global-search window", async () => {
    const insert = sqlite.prepare("INSERT INTO conversations (id,subject_type,customer_id,subject,last_message_at) VALUES (?,'store','account_1',?,?)");
    for (let i = 1; i <= 2001; i++) insert.run(`cnv_window_${String(i).padStart(8, "0")}`, i === 1 ? "needle" : "ordinary", i);
    const first = await queryStaffInbox(db, actor.userId, { q: "needle" });
    expect(first).toMatchObject({ items: [], scanned: 2000, scanExhausted: false });
    expect(first.nextCursor).toBeTruthy();
    const second = await queryStaffInbox(db, actor.userId, { q: "needle", cursor: first.nextCursor });
    expect(second.items.map((item) => item.subject)).toEqual(["needle"]);
    expect(second).toMatchObject({ scanExhausted: true, nextCursor: null });
  });

  it("gates buyer/order context and never infers ownership from a matching phone", async () => {
    const owned = await getOrCreateOrderThread(db, "order_1");
    const guest = await getOrCreateOrderThread(db, "order_guest");
    expect(await getConversationContext(db, owned.id, "staff_2")).toMatchObject({ customer: null, customerDenied: true, recentOrders: null, ordersDenied: true });
    const context = await getConversationContext(db, owned.id, "staff_1");
    expect(context.customer?.id).toBe("account_1");
    expect(context.recentOrders?.map((order) => order.id)).toEqual(["order_1"]);
    const guestContext = await getConversationContext(db, guest.id, "staff_1");
    expect(guestContext.customer).toBeNull();
    expect(guestContext.recentOrders?.map((order) => order.id)).toEqual(["order_guest"]);
  });
});
