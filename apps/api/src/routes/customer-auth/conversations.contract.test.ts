// C4: internal notes never reach a buyer response. C8: every buyer write is
// rate limited and fails closed without the limiter bindings. Real routes on
// the migrated SQLite schema.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateOrderThread, postConversationMessage } from "@scalius/core/modules/conversations";
import { getDb } from "@scalius/database/client";
import {
  createConversationHarness,
  OTHER_SESSION,
  OWNER_SESSION,
  type Harness,
} from "../__tests__/conversation-harness";

let harness: Harness;

beforeEach(async () => {
  harness = await createConversationHarness();
});
afterEach(() => harness.sqlite.close());

const json = (value: unknown) => JSON.stringify(value);

async function staffNoteAndReply(orderId: string) {
  const db = getDb(harness.env);
  const thread = await getOrCreateOrderThread(db, orderId);
  await postConversationMessage(db, thread, { actor: { kind: "staff", userId: "staff_1" }, body: "INTERNAL: buyer flagged by fraud checker", visibility: "internal" });
  const fresh = (await getOrCreateOrderThread(db, orderId));
  await postConversationMessage(db, fresh, { actor: { kind: "staff", userId: "staff_1" }, body: "Your order ships tomorrow." });
  return thread.id;
}

describe("buyer conversation contract (C4)", () => {
  it("returns only public lines to the account owner, the list and the guest receipt", async () => {
    const posted = await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST",
      session: OWNER_SESSION,
      body: json({ body: "Where is my order?", clientMessageKey: "k1" }),
    });
    expect(posted.status).toBe(201);
    const conversationId = await staffNoteAndReply("ORDEROWNED000001");

    const thread = await harness.request(`/customer-auth/conversations/${conversationId}`, { session: OWNER_SESSION });
    expect(thread.status).toBe(200);
    expect(thread.headers.get("Cache-Control")).toContain("no-store");
    const text = await thread.text();
    expect(text).not.toContain("INTERNAL");
    expect(text).not.toContain("staff_1");
    expect(text).not.toContain("Nadia");
    const { data } = JSON.parse(text) as { data: { conversation: { messages: Array<{ from: string; body: string }>; unread: number } } };
    expect(data.conversation.messages.map((message) => [message.from, message.body])).toEqual([
      ["buyer", "Where is my order?"],
      ["store", "Your order ships tomorrow."],
    ]);
    expect(data.conversation.unread).toBe(1);

    const list = await (await harness.request("/customer-auth/conversations", { session: OWNER_SESSION })).json() as {
      data: { items: Array<{ id: string; unread: number; orderNumber: string }>; canStartStoreConversation: boolean };
    };
    expect(list.data.items).toEqual([expect.objectContaining({ id: conversationId, unread: 1, orderNumber: "#1057" })]);
    expect(list.data.canStartStoreConversation).toBe(true);

    await staffNoteAndReply("ORDERGUEST000001");
    const guest = await harness.request("/orders/receipt/ORDERGUEST000001/conversation", { receipt: true });
    expect(guest.status).toBe(200);
    expect(await guest.text()).not.toContain("INTERNAL");
  });

  it("hides another account's thread and needs the receipt proof in a header, never the URL", async () => {
    await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST",
      session: OWNER_SESSION,
      body: json({ body: "Hello", clientMessageKey: "k2" }),
    });
    const id = (harness.sqlite.prepare("SELECT id FROM conversations").get() as { id: string }).id;
    expect((await harness.request(`/customer-auth/conversations/${id}`, { session: OTHER_SESSION })).status).toBe(404);
    expect((await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", { session: OTHER_SESSION })).status).toBe(404);
    expect((await harness.request("/orders/receipt/ORDERGUEST000001/conversation")).status).toBe(404);
    expect((await harness.request("/orders/receipt/ORDEROWNED000001/conversation", { receipt: true })).status).toBe(404);
  });

  it("refuses contact fields in a message body", async () => {
    const response = await harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST",
      session: OWNER_SESSION,
      body: json({ body: "hi", clientMessageKey: "k3", email: "new@example.test" }),
    });
    expect(response.status).toBe(400);
    expect(harness.sqlite.prepare("SELECT email FROM customers WHERE id = 'cust_owner'").get()).toEqual({ email: "owner@example.test" });
  });
});

describe("buyer write rate limits (C8)", () => {
  const writes: Array<[string, () => Promise<Response>]> = [
    ["account order post", () => harness.request("/customer-auth/orders/ORDEROWNED000001/conversation", {
      method: "POST", session: OWNER_SESSION, body: json({ body: "hi", clientMessageKey: "r1" }),
    })],
    ["store thread", () => harness.request("/customer-auth/conversations", {
      method: "POST", session: OWNER_SESSION, body: json({ subject: "Question", body: "hi", clientMessageKey: "r2" }),
    })],
    ["guest receipt post", () => harness.request("/orders/receipt/ORDERGUEST000001/conversation", {
      method: "POST", receipt: true, body: json({ body: "hi", clientMessageKey: "r3" }),
    })],
    ["guest support request", () => harness.request("/orders/receipt/ORDERGUEST000001/support-requests", {
      method: "POST", body: json({ token: "chk_guestreceipttoken0001", type: "cancel_pre_shipment", reason: "Ordered by mistake" }),
    })],
    ["account support request", () => harness.request("/customer-auth/orders/ORDEROWNED000001/support-requests", {
      method: "POST", session: OWNER_SESSION, body: json({ type: "cancel_pre_shipment", reason: "Ordered by mistake" }),
    })],
    ["guest upload", () => {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])], { type: "image/jpeg" }), "a.jpg");
      return harness.request("/orders/receipt/ORDERGUEST000001/conversation-attachments", { method: "POST", receipt: true, body: form });
    }],
  ];

  it.each(writes)("fails closed without the limiter bindings: %s", async (_name, write) => {
    harness.limiter.missing = true;
    const response = await write();
    expect(response.status).toBe(503);
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM conversation_messages").get()).toEqual({ n: 0 });
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM order_support_requests").get()).toEqual({ n: 0 });
  });

  it.each(writes)("answers 429 over the limit and writes nothing: %s", async (_name, write) => {
    harness.limiter.allow = false;
    const response = await write();
    expect(response.status).toBe(429);
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM conversation_messages").get()).toEqual({ n: 0 });
    expect(harness.r2.size).toBe(0);
  });
});
