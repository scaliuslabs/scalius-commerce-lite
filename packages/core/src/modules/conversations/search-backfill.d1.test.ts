import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeBatch, type Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { backfillConversationSearch, CONVERSATION_SEARCH_PAGE_BYTES, findConversationMessages,
  getConversationSearchCoverage, planConversationSearchIndex, planConversationSearchPage, tokenizeConversationSearch,
  type ConversationSearchMessage } from "./search";

describe.each(["d1", "turso"] as const)("bounded historical conversation search (%s)", (provider) => {
  let sqlite: DatabaseSync;
  let db: Database;
  let queries: Array<{ text: string; values: SQLInputValue[] }>;
  let batches: number[];
  let seq: number;
  const conversationId = "cnv_backfill_thread";
  beforeEach(() => {
    queries = []; batches = []; seq = 0;
    ({ sqlite, db } = createSqliteD1Database({ provider,
      onQuery: (text, values) => queries.push({ text, values: values as SQLInputValue[] }),
      beforeBatch: (_sqlite, statements) => { batches.push(statements.length); },
    }));
    sqlite.exec(`
      INSERT INTO orders(id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,subtotal_amount_minor,status)
        VALUES('backfill_order','Buyer','+8801711111111','House','c','z',1000,1000,'confirmed');
      INSERT INTO user(id,name,email,email_verified,role) VALUES('backfill_staff','Nadia','search@example.test',1,'admin');
      INSERT INTO conversations(id,subject_type,order_id) VALUES('cnv_backfill_thread','order','backfill_order');
    `);
  });
  afterEach(() => sqlite.close());

  function append(body: string | null, cards = false): ConversationSearchMessage {
    const id = `msg_backfill_${String(++seq).padStart(8, "0")}`;
    const eventData = cards ? { v: 1, cards: [{ productId: "p1", skuId: "s1", title: "বাংলা পাঞ্জাবি", variantLabel: "নীল" }] } : null;
    sqlite.prepare("UPDATE conversations SET last_seq=? WHERE id=?").run(seq, conversationId);
    sqlite.prepare(`INSERT INTO conversation_messages(id,conversation_id,seq,kind,visibility,author_type,author_user_id,body,event_kind,event_data)
      VALUES(?,?,?,?,'public','staff','backfill_staff',?,?,?)`)
      .run(id, conversationId, seq, cards ? "event" : "message", body, cards ? "product_reply" : null, eventData ? JSON.stringify(eventData) : null);
    return { id, conversationId, seq, body, eventKind: cards ? "product_reply" : null, eventData };
  }
  const marker = () => sqlite.prepare("SELECT search_indexed_seq FROM conversations WHERE id=?").get(conversationId)?.search_indexed_seq;

  it("finds a short unindexed legacy thread immediately without claiming global coverage", async () => {
    append("Please explain my warranty");
    append("Your warranty lasts one year");
    const header = sqlite.prepare("SELECT version,last_message_at,updated_at,customer_read_seq,staff_read_seq FROM conversations WHERE id=?").get(conversationId);
    const outbox = sqlite.prepare("SELECT count(*) AS n FROM event_outbox").get();
    const before = queries.length;
    expect(await findConversationMessages(db, conversationId, { q: "warranty" }))
      .toMatchObject({ items: [{ seq: 2 }, { seq: 1 }], bodyCoverage: "complete" });
    expect(queries.length - before).toBe(7);
    expect(batches).toEqual([3]);
    expect(marker()).toBe(2);
    expect(await getConversationSearchCoverage(db)).toBe("since_index");
    expect(sqlite.prepare("SELECT version,last_message_at,updated_at,customer_read_seq,staff_read_seq FROM conversations WHERE id=?").get(conversationId)).toEqual(header);
    expect(sqlite.prepare("SELECT count(*) AS n FROM event_outbox").get()).toEqual(outbox);
  });

  it("indexes 200 historical messages in one three-statement batch and six total queries", async () => {
    for (let i = 0; i < 200; i++) append(`Warranty message ${i}`);
    const before = queries.length;
    expect(await backfillConversationSearch(db, { limit: 200 })).toMatchObject({ indexed: 200, complete: true });
    expect(queries.length - before).toBe(6);
    expect(batches).toEqual([3]);
    const inserts = queries.filter(({ text }) => /insert into "conversation_search_terms"/i.test(text));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toHaveLength(1);
    expect((await findConversationMessages(db, conversationId, { q: "warranty" })).bodyCoverage).toBe("complete");
    // A complete global index needs no redundant per-thread marker write.
    expect(marker()).toBeNull();
  });

  it("uses identical terms for bulk and append indexing, including cards and Bangla marks", async () => {
    const messages = [append("CAFÉ cafe\u0301 বাংলাদেশ 𐐀𐐀 " + "x".repeat(40)), append(null, true)];
    for (const message of messages) await safeBatch(db, planConversationSearchIndex(db, message));
    const rows = () => sqlite.prepare("SELECT message_id,term FROM conversation_search_terms ORDER BY message_id,term").all();
    const expected = rows();
    sqlite.exec("DELETE FROM conversation_search_terms");
    const page = planConversationSearchPage(db, messages);
    await safeBatch(db, [page.statement]);
    expect(rows()).toEqual(expected);
  });

  it("caps the serialized payload by UTF-8 bytes and resumes only after a whole indexed message", async () => {
    const body = Array.from({ length: 450 }, (_, i) => `বাংলা${String(i).padStart(4, "0")}`).join(" ");
    expect([...body].length).toBeLessThanOrEqual(5000);
    for (let i = 0; i < 200; i++) append(body);
    const first = await backfillConversationSearch(db, { limit: 200 });
    expect(first.indexed).toBeGreaterThan(0);
    expect(first.indexed).toBeLessThan(200);
    expect(first.complete).toBe(false);
    const payload = queries.find(({ text }) => /insert into "conversation_search_terms"/i.test(text))!.values[0] as string;
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(CONVERSATION_SEARCH_PAGE_BYTES);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(payload.length);
    expect((JSON.parse(payload) as unknown[]).length).toBe(first.indexed);
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_search_terms WHERE message_id=?").get(first.lastMessageId!))
      .toEqual({ n: tokenizeConversationSearch(body).length });
    const second = await backfillConversationSearch(db, { limit: 200 });
    expect(second.lastMessageId! > first.lastMessageId!).toBe(true);
    expect(sqlite.prepare("SELECT count(DISTINCT message_id) AS n FROM conversation_search_terms").get())
      .toEqual({ n: first.indexed + second.indexed });
  });

  it("reports partial thread coverage until another bounded Find finishes the prefix", async () => {
    for (let i = 1; i <= 201; i++) append(`Warranty ${i}`);
    expect((await findConversationMessages(db, conversationId, { q: "warranty" })).bodyCoverage).toBe("since_index");
    expect(marker()).toBe(200);
    const second = await findConversationMessages(db, conversationId, { q: "warranty" });
    expect(second.bodyCoverage).toBe("complete");
    expect(second.items[0]).toEqual({ seq: 201 });
    expect(marker()).toBe(201);
    expect(await getConversationSearchCoverage(db)).toBe("since_index");
  });

  it("keeps the winning cursor when two Finds overlap", async () => {
    append("Warranty question"); append("Warranty answer");
    let race = true;
    const competing = createSqliteD1Database({ sqlite, provider, beforeBatch: async (_sqlite, statements) => {
      if (!race || !statements.some(({ query }) => /update "conversations" set "search_indexed_seq"/i.test(query))) return;
      race = false;
      await findConversationMessages(db, conversationId, { q: "warranty" });
    } }).db;
    expect(await findConversationMessages(competing, conversationId, { q: "warranty" }))
      .toMatchObject({ items: [{ seq: 2 }, { seq: 1 }], bodyCoverage: "complete" });
    expect(marker()).toBe(2);
  });

  it("rolls back terms and cursor together when bulk insertion fails", async () => {
    append("Warranty failure");
    sqlite.exec(`CREATE TRIGGER backfill_test_failure BEFORE INSERT ON conversation_search_terms
      WHEN NEW.term='failure' BEGIN SELECT RAISE(ABORT,'index unavailable'); END`);
    await expect(findConversationMessages(db, conversationId, { q: "warranty" })).rejects.toThrow("index unavailable");
    expect(marker()).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_search_terms").get()).toEqual({ n: 0 });
    sqlite.exec("DROP TRIGGER backfill_test_failure");
    expect((await findConversationMessages(db, conversationId, { q: "warranty" })).bodyCoverage).toBe("complete");
  });

  it("handles append overlap without certifying uncommitted history", async () => {
    append("Historical warranty");
    let race = true;
    const competing = createSqliteD1Database({ sqlite, provider, beforeBatch: async (_sqlite, statements) => {
      if (!race || !statements.some(({ query }) => /update "conversations" set "search_indexed_seq"/i.test(query))) return;
      race = false;
      const fresh = append("New warranty");
      await safeBatch(db, planConversationSearchIndex(db, fresh));
    } }).db;
    expect(await findConversationMessages(competing, conversationId, { q: "warranty" }))
      .toMatchObject({ items: [{ seq: 2 }, { seq: 1 }], bodyCoverage: "complete" });
    expect(marker()).toBe(1);
    expect((await findConversationMessages(db, conversationId, { q: "warranty" })).bodyCoverage).toBe("complete");
    expect(marker()).toBe(2);
  });

  it("never advances across a gap in damaged legacy sequence data", async () => {
    append("First warranty"); append("Missing warranty"); append("Last warranty");
    sqlite.exec("DROP TRIGGER conversation_messages_delete_blocked");
    sqlite.exec("DELETE FROM conversation_messages WHERE seq=2");
    expect((await findConversationMessages(db, conversationId, { q: "warranty" })).bodyCoverage).toBe("since_index");
    expect(marker()).toBe(1);
    expect((await findConversationMessages(db, conversationId, { q: "warranty" })).bodyCoverage).toBe("since_index");
    expect(marker()).toBe(1);
  });
});
