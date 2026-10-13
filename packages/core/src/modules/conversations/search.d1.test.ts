import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeBatch, type Database } from "@scalius/database/client";
import { conversations } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  conversationBodySearchCondition,
  findConversationMessages,
  planConversationSearchIndex,
  tokenizeConversationSearch,
  type ConversationSearchMessage,
} from "./search";

describe("conversation search index", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let seq: number;
  let queries: Array<{ sql: string; binds: number }>;
  const conversationId = "cnv_search_fixture";

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({
      onQuery: (query, values) => queries.push({ sql: query, binds: values.length }),
    }));
    seq = 0;
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status, order_number)
        VALUES ('search_order', 'Rahim', '+8801711111111', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', 1057);
      INSERT INTO user (id, name, email, email_verified, role)
        VALUES ('search_staff', 'Nadia', 'search-staff@shop.test', 1, 'admin');
      INSERT INTO conversations (id, subject_type, order_id) VALUES ('cnv_search_fixture', 'order', 'search_order');
    `);
  });

  afterEach(() => sqlite.close());

  function append(body: string | null, options: { internal?: boolean; cards?: boolean; id?: string } = {}): ConversationSearchMessage {
    seq++;
    const id = options.id ?? `msg_${String(seq).padStart(12, "0")}`;
    const eventData = options.cards ? JSON.stringify({ v: 1, cards: [{
      productId: "product_1", skuId: "sku_1", title: "বাংলা পাঞ্জাবি", variantLabel: "Blue large",
    }] }) : null;
    sqlite.prepare("UPDATE conversations SET last_seq = ? WHERE id = ?").run(seq, conversationId);
    sqlite.prepare(`INSERT INTO conversation_messages
      (id, conversation_id, seq, kind, visibility, author_type, author_user_id, body, event_kind, event_data)
      VALUES (?, ?, ?, ?, ?, 'staff', 'search_staff', ?, ?, ?)`)
      .run(id, conversationId, seq, options.cards ? "event" : "message", options.internal ? "internal" : "public",
        body, options.cards ? "product_reply" : null, eventData);
    return { id, conversationId, seq, body, eventKind: options.cards ? "product_reply" : null, eventData };
  }

  async function index(message: ConversationSearchMessage) {
    const statements = planConversationSearchIndex(db, message);
    if (statements.length) await safeBatch(db, statements);
  }

  it("indexes all body terms and product-card titles with four binds and idempotent replay", async () => {
    const body = Array.from({ length: 220 }, (_, number) => `word${number}`).join(" ");
    const message = append(body);
    await index(message);
    await index(message);
    await index(append(null, { cards: true }));
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_search_terms WHERE message_id = ?").get(message.id))
      .toEqual({ n: 220 });
    expect(queries.filter((query) => /insert into "conversation_search_terms"/i.test(query.sql))
      .every((query) => query.binds === 4)).toBe(true);
    expect((await findConversationMessages(db, conversationId, { q: "word219" })).items).toEqual([{ seq: 1 }]);
    expect((await findConversationMessages(db, conversationId, { q: "বাংলা blu" })).items).toEqual([{ seq: 2 }]);
  });

  it("matches all words on one message for find, while the inbox condition can span messages", async () => {
    await index(append("red dress"));
    await index(append("blue scarf", { internal: true }));
    await index(append("red blue denim"));
    const inbox = await db.select({ id: conversations.id }).from(conversations)
      .where(conversationBodySearchCondition(conversations.id, "dress scarf")).all();
    expect(inbox).toEqual([{ id: conversationId }]);
    expect((await findConversationMessages(db, conversationId, { q: "dress scarf" })).items).toEqual([]);
    expect((await findConversationMessages(db, conversationId, { q: "red blu" })).items).toEqual([{ seq: 3 }]);
    expect((await findConversationMessages(db, conversationId, { q: "scarf" })).items).toEqual([{ seq: 2 }]);
    queries.length = 0;
    await findConversationMessages(db, conversationId, { q: "absent" });
    const findQuery = queries.find((query) => query.sql.includes("WITH candidates AS MATERIALIZED"))!;
    expect(findQuery.sql).toContain("SELECT seq FROM conversation_messages");
    expect(findQuery.sql).not.toMatch(/SELECT[^;]*\bbody\b/i);
    expect(findQuery.sql).toContain("LIMIT");
  });

  it("distinguishes an exhausted search from an empty candidate window with more history", async () => {
    const insert = sqlite.prepare("INSERT INTO conversation_search_terms (conversation_id, message_id, seq, term) VALUES (?, ?, ?, ?)");
    for (let number = 1; number <= 2001; number++) {
      const message = append(number === 1 ? "common needle" : "common filler");
      for (const term of tokenizeConversationSearch(message.body!)) insert.run(conversationId, message.id, message.seq, term);
    }
    const first = await findConversationMessages(db, conversationId, { q: "common needle" });
    expect(first).toMatchObject({ items: [], scanned: 2000, scanExhausted: false, nextCursor: 2 });
    expect(await findConversationMessages(db, conversationId, { q: "common needle", cursor: first.nextCursor! }))
      .toMatchObject({ items: [{ seq: 1 }], scanned: 1, scanExhausted: true, nextCursor: null });
    const page = await findConversationMessages(db, conversationId, { q: "common" });
    expect(page.items).toHaveLength(50);
    expect(page).toMatchObject({ scanned: 50, scanExhausted: false, nextCursor: 1952 });
  });

  it("fails closed for missing threads and rejects invalid cursors", async () => {
    await expect(findConversationMessages(db, "cnv_missing_thread", { q: "hello" })).rejects.toThrow("not found");
    await expect(findConversationMessages(db, conversationId, { q: "hello", cursor: 0 })).rejects.toThrow("cursor");
    expect(await findConversationMessages(db, conversationId, { q: "a !" }))
      .toMatchObject({ items: [], scanned: 0, scanExhausted: true, nextCursor: null });
  });
});
