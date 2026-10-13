import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { backfillConversationSearch, findConversationMessages, getConversationSearchCoverage } from "./search";

afterAll(closeNativePostgres);
describe.runIf(nativePostgresUrl())("historical search bulk projection on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("indexes a cold thread with nested JSON term arrays and preserves global coverage", async () => {
    const { db } = await createNativePostgres({ label: "search_backfill" });
    await db.run(sql`INSERT INTO orders(id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,subtotal_amount_minor,status)
      VALUES('pg_search_order','Buyer','+8801711111111','House','c','z',1000,1000,'confirmed')`);
    await db.run(sql`INSERT INTO "user"(id,name,email,email_verified,role) VALUES('pg_search_staff','Nadia','search@example.test',1,'admin')`);
    await db.run(sql`INSERT INTO conversations(id,subject_type,order_id) VALUES('cnv_pg_search_thread','order','pg_search_order')`);
    for (let seq = 1; seq <= 2; seq++) {
      await db.run(sql`UPDATE conversations SET last_seq=${seq} WHERE id='cnv_pg_search_thread'`);
      await db.run(sql`INSERT INTO conversation_messages(id,conversation_id,seq,kind,visibility,author_type,author_user_id,body)
        VALUES(${`msg_pg_search_000${seq}`},'cnv_pg_search_thread',${seq},'message','public','staff','pg_search_staff',${`বাংলা warranty ${seq}`})`);
    }
    expect(await findConversationMessages(db, "cnv_pg_search_thread", { q: "বাংলা warranty" }))
      .toMatchObject({ items: [{ seq: 2 }, { seq: 1 }], bodyCoverage: "complete" });
    expect(await getConversationSearchCoverage(db)).toBe("since_index");
    expect(await backfillConversationSearch(db)).toMatchObject({ indexed: 2, complete: true });
    expect(await getConversationSearchCoverage(db)).toBe("complete");
  });
});
