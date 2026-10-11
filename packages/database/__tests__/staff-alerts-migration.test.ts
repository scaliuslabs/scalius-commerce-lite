import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { renderStaffAlertsMigration, STAFF_ALERTS_MIGRATION } from "../scripts/staff-alerts";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { normalizeSqliteDatabaseToTursoDatabase } from "../scripts/normalize-d1-export-core";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
const read=(provider="")=>readFileSync(join(import.meta.dirname,`../migrations/${provider}${STAFF_ALERTS_MIGRATION}.sql`),"utf8");
const statements=(source:string)=>source.split("--> statement-breakpoint").map((s)=>s.trim()).filter(Boolean);
const seed=[
  "INSERT INTO user(id,name,email) VALUES('bell_migration','Staff','migration@example.test')",
  "INSERT INTO staff_alerts(id,scope,kind,subject_id,occurred_at,fanout_complete) VALUES('bell_event','orders','order_created','retained-subject',1000,1)",
  "INSERT INTO staff_alert_state(user_id,scope,last_seq) VALUES('bell_migration','*',8)",
  "INSERT INTO staff_alert_state(user_id,scope,read_through,cleared_through,revision) VALUES('bell_migration','orders',6,4,3)",
  "INSERT INTO staff_alert_inbox(user_id,seq,alert_id,scope,read_at) VALUES('bell_migration',8,'bell_event','orders',NULL)",
];

describe("staff alert migration",()=>{
  it("reproduces provider artifacts with no triggers, destructive cleanup or backfill",()=>{
    const ddl=statements(read()).filter((s)=>/^CREATE /i.test(s));
    const rendered=renderStaffAlertsMigration(ddl);
    expect(rendered.sqlite).toBe(read());expect(rendered.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((m)=>m.version===142)?.sourceSha256).toBe(rendered.digest);
    expect(ddl.filter((s)=>/^CREATE TABLE /i.test(s))).toHaveLength(3);
    expect(read()).not.toMatch(/CREATE TRIGGER|DELETE FROM|DROP TABLE|PRAGMA|BEGIN TRANSACTION/i);
  });
  it.each(["SQLite","Turso"])("preserves sequence/read state and enforces identity/frontiers on %s",async(provider)=>{
    const db=provider==="SQLite"?new DatabaseSync(":memory:"):await connect(":memory:");
    try{
      await db.exec("PRAGMA foreign_keys=ON");
      await db.exec("CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT)");
      await db.exec("CREATE TABLE scalius_schema_migrations(version INTEGER PRIMARY KEY,name TEXT,source_sha256 TEXT,applied_at INTEGER)");
      for(const statement of statements(read()))await db.exec(statement);
      for(const statement of seed)await db.exec(statement);
      for(const bad of [
        "INSERT INTO staff_alert_inbox(user_id,seq,alert_id,scope) VALUES('bell_migration',9,'bell_event','orders')",
        "UPDATE staff_alert_state SET cleared_through=7 WHERE scope='orders'",
        "UPDATE staff_alert_inbox SET seq=0",
      ])await expect(Promise.resolve().then(()=>db.exec(bad))).rejects.toThrow();
      expect(await db.prepare("SELECT last_seq FROM staff_alert_state WHERE scope='*'").get()).toMatchObject({last_seq:8});
      await db.exec("BEGIN");await db.exec("UPDATE staff_alert_state SET last_seq=9 WHERE scope='*'");await db.exec("ROLLBACK");
      expect(await db.prepare("SELECT last_seq FROM staff_alert_state WHERE scope='*'").get()).toMatchObject({last_seq:8});
    }finally{await db.close();}
  });
  it("roundtrips personal state through the supported normalizer without resetting sequences or receipts",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"scalius-staff-alerts-normalize-"));
    const sourcePath=join(directory,"source.sqlite"),targetPath=join(directory,"target.sqlite");
    const source=createMigratedSqlite();let target:DatabaseSync|undefined;
    try{
      for(const statement of seed)source.exec(statement);
      const tables=["staff_alerts","staff_alert_inbox","staff_alert_state"];
      const snapshot=tables.map((table)=>source.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
      source.prepare("VACUUM INTO ?").run(sourcePath);
      const bytes=readFileSync(sourcePath);
      await normalizeSqliteDatabaseToTursoDatabase({sourcePath,sourceProvider:"d1",sourceBytes:bytes.length,
        sourceSha256:createHash("sha256").update(bytes).digest("hex"),targetDatabasePath:targetPath});
      target=new DatabaseSync(targetPath);
      expect(tables.map((table)=>target!.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())).toEqual(snapshot);
    }finally{source.close();target?.close();rmSync(directory,{recursive:true,force:true});}
  },60_000);
});
