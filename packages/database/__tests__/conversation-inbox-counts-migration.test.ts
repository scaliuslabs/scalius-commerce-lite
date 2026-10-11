import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { CONVERSATION_INBOX_COUNTS_MIGRATION, conversationInboxCountsRebuild, generateConversationInboxCountsTriggers, renderConversationInboxCountsMigration } from "../scripts/conversation-inbox-counts";
import { normalizeSqliteDatabaseToTursoDatabase } from "../scripts/normalize-d1-export-core";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { inboxAppend, inboxCountsActual, inboxCountsHistory, inboxCountsMutations, inboxCountsOracle, inboxCountsSeed } from "./conversation-inbox-counts-fixture";

const read = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${CONVERSATION_INBOX_COUNTS_MIGRATION}.sql`), "utf8");
const statements = (text: string) => text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const guards = (db: DatabaseSync) => db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('conversations','conversation_messages') ORDER BY name").all() as Array<{ name: string; sql: string }>;

describe("transactional conversation inbox counts", () => {
  it("reproduces both provider artifacts with ten single-statement triggers", () => {
    const ddl = statements(read()).filter((s) => /^CREATE TABLE /i.test(s));
    expect(ddl).toHaveLength(1);
    const generated = renderConversationInboxCountsMigration(ddl);
    expect(generated.sqlite).toBe(read());
    expect(generated.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((m) => m.version === 141)?.sourceSha256).toBe(generated.digest);
    expect(generateConversationInboxCountsTriggers()).toHaveLength(10);
    for (const { sqlite } of generateConversationInboxCountsTriggers()) {
      expect(sqlite.slice(sqlite.indexOf("BEGIN\n")).match(/;/g)).toHaveLength(1);
      expect(sqlite).not.toContain("SELECT CASE WHEN");
    }
  });

  it.each(["SQLite", "Turso"])("backfills and preserves exact lifecycle counts on %s", async (provider) => {
    const source = createMigratedSqlite({ beforeMigration: "0141_" });
    const db = provider === "Turso" ? await connect(":memory:") : source;
    try {
      if (provider === "Turso") {
        await db.exec("PRAGMA foreign_keys=ON");
        await db.exec("CREATE TABLE customers(id TEXT PRIMARY KEY,name TEXT,phone TEXT,origin TEXT)");
        await db.exec("CREATE TABLE orders(id TEXT PRIMARY KEY)");
        await db.exec("CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,email_verified INTEGER,role TEXT)");
        for (const table of ["conversations", "conversation_messages", "scalius_schema_migrations"]) {
          await db.exec(String(source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)!.sql));
        }
        for (const row of source.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name IN ('conversations','conversation_messages') AND sql IS NOT NULL").all()) await db.exec(String(row.sql));
        for (const guard of guards(source)) await db.exec(guard.sql);
      }
      for (const statement of [...inboxCountsSeed, ...inboxCountsHistory]) await db.exec(statement);
      const before = await db.prepare("SELECT * FROM conversations ORDER BY id").all();
      const messages = await db.prepare("SELECT * FROM conversation_messages ORDER BY id").all();
      for (const statement of statements(read())) await db.exec(statement);
      expect(await db.prepare("SELECT * FROM conversations ORDER BY id").all()).toEqual(before);
      expect(await db.prepare("SELECT * FROM conversation_messages ORDER BY id").all()).toEqual(messages);
      const check = async () => expect(await db.prepare(inboxCountsActual).all()).toEqual(await db.prepare(inboxCountsOracle).all());
      await check();
      for (const mutation of inboxCountsMutations) { await db.exec(mutation); await check(); }
      // Existing history is counted once on activation, then the new incoming insert once.
      for (const statement of inboxAppend("cnv_count_0001", 7)) await db.exec(statement);
      await check();
      const duplicate = inboxAppend("cnv_count_0001", 7)[1]!.replace("INSERT INTO", "INSERT OR IGNORE INTO");
      const stable = await db.prepare(inboxCountsActual).all();
      await db.exec(duplicate);
      expect(await db.prepare(inboxCountsActual).all()).toEqual(stable);
      await db.exec("BEGIN");
      for (const statement of inboxAppend("cnv_count_0002", 7)) await db.exec(statement);
      await db.exec("ROLLBACK");
      expect(await db.prepare(inboxCountsActual).all()).toEqual(stable);
      await db.exec("BEGIN");
      await db.exec("UPDATE conversations SET last_seq=8 WHERE id='cnv_count_0001' AND last_seq=6"); // Stale CAS changes nothing.
      await expect(Promise.resolve().then(() => db.exec(inboxAppend("cnv_count_0001", 8)[1]!))).rejects.toThrow();
      await db.exec("ROLLBACK");
      await check();
      for (const blocked of ["DELETE FROM conversations", "DELETE FROM conversation_messages", "UPDATE conversation_messages SET body='Changed'", "UPDATE conversations SET last_seq=999"]) {
        await expect(Promise.resolve().then(() => db.exec(blocked))).rejects.toThrow();
        await check();
      }
      await db.exec("UPDATE conversation_inbox_counts SET unread=0,open=0,unassigned_open=0");
      for (let pass = 0; pass < 2; pass++) {
        await db.exec("BEGIN");
        for (const statement of conversationInboxCountsRebuild) await db.exec(statement);
        await db.exec("COMMIT");
        await check();
      }
    } finally {
      if (provider === "Turso") await db.close();
      source.close();
    }
  });

  it("only visits the acknowledged interval and skips zero-contribution writes", () => {
    const db = createMigratedSqlite();
    try {
      for (const statement of inboxCountsSeed) db.exec(statement);
      for (let seq = 1; seq <= 200; seq++) for (const statement of inboxAppend("cnv_count_0001", seq, seq % 2 ? "guest" : "event")) db.exec(statement);
      db.exec("UPDATE conversations SET staff_read_seq=190 WHERE id='cnv_count_0001'");
      let visits = 0; let writes = 0;
      db.function("inbox_kind_probe", (value) => { visits++; return value; });
      db.function("inbox_write_probe", () => { writes++; return 0; });
      for (const name of ["conversation_inbox_read_advance", "conversation_inbox_read_retreat"]) {
        const ddl = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql);
        db.exec(`DROP TRIGGER ${name}`);
        db.exec(ddl.replaceAll("m.kind", "inbox_kind_probe(m.kind)"));
      }
      for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER count_${event} AFTER ${event} ON conversation_inbox_counts BEGIN SELECT inbox_write_probe(); END`);
      db.exec("UPDATE conversations SET staff_read_seq=194 WHERE id='cnv_count_0001'");
      expect(visits).toBeLessThanOrEqual(5); // One EXISTS witness plus exactly four interval rows.
      expect(writes).toBe(1);
      visits = 0; writes = 0;
      db.exec("UPDATE conversations SET staff_read_seq=194,updated_at=2 WHERE id='cnv_count_0001'");
      db.exec("UPDATE conversations SET staff_read_seq=CASE WHEN 193>staff_read_seq THEN 193 ELSE staff_read_seq END WHERE id='cnv_count_0001'");
      expect(visits).toBe(0); expect(writes).toBe(0);
      for (const statement of inboxAppend("cnv_count_0001", 201, "guest")) db.exec(statement);
      expect(writes).toBe(1);
      writes = 0;
      for (const statement of inboxAppend("cnv_count_0001", 202, "event")) db.exec(statement);
      expect(writes).toBe(0);
      expect(db.prepare(inboxCountsActual).all()).toEqual(db.prepare(inboxCountsOracle).all());
    } finally { db.close(); }
  });

  it("roundtrips populated counters through the supported snapshot normalizer without double-counting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scalius-inbox-normalize-"));
    const sourcePath = join(directory, "source.sqlite");
    const targetPath = join(directory, "target.sqlite");
    const source = createMigratedSqlite();
    let target: DatabaseSync | undefined;
    try {
      for (const statement of [...inboxCountsSeed, ...inboxCountsHistory]) source.exec(statement);
      source.exec("UPDATE conversations SET assignee_user_id='staff_count_a',staff_read_seq=2 WHERE id='cnv_count_0001'");
      const expected = source.prepare(inboxCountsActual).all();
      source.prepare("VACUUM INTO ?").run(sourcePath);
      const bytes = readFileSync(sourcePath);
      await normalizeSqliteDatabaseToTursoDatabase({
        sourcePath, sourceProvider: "d1", sourceBytes: bytes.length,
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        targetDatabasePath: targetPath,
      });
      target = new DatabaseSync(targetPath);
      target.exec("PRAGMA foreign_keys=ON");
      expect(target.prepare(inboxCountsActual).all()).toEqual(expected);
      expect(target.prepare(inboxCountsActual).all()).toEqual(target.prepare(inboxCountsOracle).all());
      expect(target.prepare("SELECT count(*) AS n FROM conversation_inbox_counts WHERE scope='*'").get()).toMatchObject({ n: 1 });
      for (const statement of inboxAppend("cnv_count_0001", 7)) target.exec(statement);
      target.exec("DELETE FROM user WHERE id='staff_count_a'");
      expect(target.prepare(inboxCountsActual).all()).toEqual(target.prepare(inboxCountsOracle).all());
    } finally {
      source.close(); target?.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
