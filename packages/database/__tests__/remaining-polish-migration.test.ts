import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { eventOutboxSqliteStatements } from "../scripts/event-outbox-triggers";
import { conversationProductReplyGuard, conversationSearchPostgresCollation } from "../scripts/conversation-workspace";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const migration = readFileSync(join(import.meta.dirname, "../migrations/0143_remaining_polish.sql"), "utf8");
const statements = migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const preserved = ["customer_marketing_consents", "customer_marketing_consent_events", "notification_outbox", "notification_delivery_receipts", "event_outbox"];
const seed = [
  "INSERT INTO customers(id,name,phone) VALUES ('cust_migration','Migration fixture','+8801711111111')",
  "INSERT INTO customer_marketing_consents(customer_id,channel,state,contact,source,actor,subscribed_at) VALUES ('cust_migration','email','subscribed','migration@example.test','account','buyer',1)",
  "INSERT INTO notification_outbox(id,dedupe_key,subject_type,subject_id,audience,notification_type,source,payload,status,attempts,claim_id,claim_expires_at) VALUES ('nob_migration','migration:1','customer','cust_migration','customer','marketing_opt_in','newsletter','{\"version\":1}','sending',2,'claim_fixture',1000)",
  "INSERT INTO notification_delivery_receipts(id,receipt_key,outbox_id,subject_type,subject_id,notification_type,channel,provider,recipient_hash,status,provider_message_id,accepted_at) VALUES ('ndr_migration','migration:1:email','nob_migration','customer','cust_migration','marketing_opt_in','email','fixture','hash_fixture','accepted','provider_fixture',500)",
];

describe("0143 conversation and messaging migration", () => {
  it("keeps event generation and provider prefix ordering consistent", () => {
    for (const trigger of eventOutboxSqliteStatements().filter((s) => s.startsWith("CREATE TRIGGER `evt_customer_marketing_consents_"))) {
      expect(migration).toContain(trigger);
    }
    expect(migration).toContain(conversationProductReplyGuard);
    expect(migration).not.toMatch(/^PRAGMA|SELECT CASE WHEN/im);
    const unrelated = 'CREATE TABLE "other" ("term" text NOT NULL);';
    expect(conversationSearchPostgresCollation(`${unrelated}\nCREATE TABLE "conversation_search_terms" ("term" text NOT NULL);`))
      .toBe(`${unrelated}\nCREATE TABLE "conversation_search_terms" ("term" text COLLATE "C" NOT NULL);`);
    expect(() => conversationSearchPostgresCollation('CREATE TABLE "conversation_search_terms" ("unexpected" text NOT NULL);')).toThrow(/missing C collation/);
    const source = createMigratedSqlite();
    try {
      const ddl = String(source.prepare("SELECT sql FROM sqlite_schema WHERE name='conversation_search_terms'").get()!.sql);
      expect(compileSqliteDdlForPostgres(ddl)).toContain('"term" text COLLATE "C" NOT NULL');
    } finally { source.close(); }
  });

  it.each(["SQLite", "Turso"])("preserves populated receipts, claims and consent history with foreign keys on %s", async (provider) => {
    const source = createMigratedSqlite({ beforeMigration: "0143_" });
    const db = provider === "Turso" ? await connect(":memory:") : source;
    try {
      if (provider === "Turso") {
        await db.exec("PRAGMA foreign_keys=ON");
        for (const ddl of [
          "CREATE TABLE customers(id TEXT PRIMARY KEY,name TEXT,phone TEXT)",
          "CREATE TABLE user(id TEXT PRIMARY KEY)",
          "CREATE TABLE orders(id TEXT PRIMARY KEY)",
          "CREATE TABLE conversations(id TEXT PRIMARY KEY)",
        ]) await db.exec(ddl);
        for (const table of ["conversation_messages", "customer_marketing_consents", "customer_marketing_consent_events", "notification_outbox", "notification_delivery_receipts", "event_outbox", "scalius_schema_migrations"]) {
          await db.exec(String(source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)!.sql));
        }
        for (const row of source.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='customer_marketing_consents'").all()) await db.exec(String(row.sql));
      }
      for (const sql of seed) await db.exec(sql);
      const before = [];
      for (const table of preserved) before.push(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
      const triggersBefore = await db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='customer_marketing_consents' ORDER BY name").all();
      const rebuilt = "('customer_marketing_consents','notification_outbox','notification_delivery_receipts')";
      const objectsQuery = `SELECT type,name FROM sqlite_schema WHERE type IN ('index','trigger') AND tbl_name IN ${rebuilt} AND name NOT GLOB 'sqlite_*' ORDER BY 1,2`;
      const objectsBefore = await db.prepare(objectsQuery).all();
      if (provider === "SQLite") {
        // A future child must be preserved too; silently cascading it is never a safe upgrade.
        expect(await db.prepare(`SELECT m.name FROM sqlite_schema m, pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f."table" IN ${rebuilt} AND m.name NOT IN ${rebuilt}`).all()).toEqual([]);
      }
      await db.exec("BEGIN");
      for (const statement of statements) await db.exec(statement);
      await db.exec("COMMIT");
      for (const [index, table] of preserved.entries()) expect(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), table).toEqual(before[index]);
      expect(await db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='customer_marketing_consents' ORDER BY name").all()).toEqual(triggersBefore);
      if (provider === "SQLite") expect(await db.prepare(objectsQuery).all()).toEqual(objectsBefore);
      expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(await db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '__new_*'").all()).toEqual([]);
      await db.exec("UPDATE customer_marketing_consents SET state='unsubscribed',unsubscribed_at=200 WHERE customer_id='cust_migration'");
      expect(await db.prepare("SELECT count(*) AS n FROM customer_marketing_consent_events").get()).toMatchObject({ n: 2 });
      expect(await db.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic='customer.consent_changed'").get()).toMatchObject({ n: 2 });
      await db.exec("INSERT INTO customer_marketing_consents(customer_id,channel,state,contact,source,actor,subscribed_at) VALUES ('cust_migration','push','subscribed','cust_migration','account','buyer',201)");
      expect(await db.prepare("SELECT count(*) AS n FROM customer_marketing_consent_events").get()).toMatchObject({ n: 3 });
      await db.exec("UPDATE notification_outbox SET subject_type='marketing_run',subject_id='run_fixture' WHERE id='nob_migration'");
      await db.exec("UPDATE notification_delivery_receipts SET subject_type='marketing_run',subject_id='run_fixture' WHERE id='ndr_migration'");
      await expect(Promise.resolve().then(() => db.exec("UPDATE customer_marketing_consents SET channel='unknown' WHERE channel='push'"))).rejects.toThrow();
      await expect(Promise.resolve().then(() => db.exec("UPDATE notification_outbox SET subject_type='unknown'"))).rejects.toThrow();
      await db.exec("DELETE FROM notification_outbox WHERE id='nob_migration'");
      expect(await db.prepare("SELECT count(*) AS n FROM notification_delivery_receipts").get()).toMatchObject({ n: 0 });
    } finally {
      if (provider === "Turso") await db.close();
      source.close();
    }
  });
});
