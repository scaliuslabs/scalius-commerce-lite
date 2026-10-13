import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

const server = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function database(sql: string) {
  const name = `scalius_polish_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server!); url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  cleanup.push(async () => { await client.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await client.connect(); await client.query(sql); return client;
}
async function catalog(client: Client) {
  const queries = [
    "SELECT table_name,column_name,data_type,is_nullable,column_default,collation_name FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2",
    "SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2,3",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2",
    "SELECT tgrelid::regclass::text AS table_name,tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2",
  ];
  const result = []; for (const query of queries) result.push((await client.query(query)).rows); return result;
}

describe.runIf(server)("remaining polish native PostgreSQL migrations", () => {
  it("preserves existing delivery/consent facts and equals a fresh schema", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0143_" });
    const upgraded = await database(before.sql);
    await upgraded.query(`
      INSERT INTO customers(id,name,phone) VALUES ('cust_migration','Fixture','+8801711111111');
      INSERT INTO customer_marketing_consents(customer_id,channel,state,contact,source,actor,subscribed_at)
        VALUES ('cust_migration','email','subscribed','fixture@example.test','account','buyer',1);
      INSERT INTO notification_outbox(id,dedupe_key,subject_type,subject_id,audience,notification_type,source,payload,status,claim_id)
        VALUES ('nob_migration','fixture','customer','cust_migration','customer','marketing_opt_in','newsletter','{}','sending','claim_fixture');
      INSERT INTO notification_delivery_receipts(id,receipt_key,outbox_id,subject_type,subject_id,notification_type,channel,provider,recipient_hash,status,provider_message_id)
        VALUES ('ndr_migration','fixture:email','nob_migration','customer','cust_migration','marketing_opt_in','email','fixture','hash_fixture','accepted','provider_fixture');
    `);
    const tables = ["customer_marketing_consents", "customer_marketing_consent_events", "notification_outbox", "notification_delivery_receipts", "event_outbox"];
    const records = []; for (const table of tables) records.push((await upgraded.query(`SELECT * FROM ${table} ORDER BY 1`)).rows);
    await upgraded.query("BEGIN");
    for (const name of ["0143_remaining_polish", "0144_customer_contact_lookup", "0145_conversation_search_cursor"]) {
      const migration = readFileSync(join(import.meta.dirname, `../migrations/postgres/${name}.sql`), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await upgraded.query(statement);
    }
    await upgraded.query("COMMIT");
    for (const [index, table] of tables.entries()) expect((await upgraded.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, table).toEqual(records[index]);
    await upgraded.query("UPDATE customer_marketing_consents SET state='unsubscribed',unsubscribed_at=2");
    expect((await upgraded.query("SELECT count(*)::integer AS n FROM customer_marketing_consent_events")).rows).toEqual([{ n: 2 }]);
    await upgraded.query("INSERT INTO customer_marketing_consents(customer_id,channel,state,contact,source,actor,subscribed_at) VALUES ('cust_migration','push','subscribed','cust_migration','account','buyer',3)");
    expect((await upgraded.query("SELECT count(*)::integer AS n FROM event_outbox WHERE topic='customer.consent_changed'")).rows).toEqual([{ n: 3 }]);
    const fresh = await database((await compileCanonicalPostgresSchema()).sql);
    expect(await catalog(upgraded)).toEqual(await catalog(fresh));
  }, 180_000);
});
