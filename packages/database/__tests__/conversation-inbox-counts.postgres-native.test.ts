import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { safeBatch } from "../src/batch-helper";
import { connectNativePostgres, createPostgresDatabase } from "../src/postgres-adapter";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT, type NativePostgres } from "../src/testing/postgres-native";
import { inboxAppend, inboxCountsActual, inboxCountsHistory, inboxCountsMutations, inboxCountsOracle, inboxCountsSeed } from "./conversation-inbox-counts-fixture";

afterAll(closeNativePostgres);
async function seed(pg: NativePostgres) {
  for (const statement of [...inboxCountsSeed, ...inboxCountsHistory]) await pg.db.run(sql.raw(statement));
}
async function assertCounts(pg: NativePostgres) {
  expect((await pg.client.query(inboxCountsActual)).rows).toEqual((await pg.client.query(inboxCountsOracle)).rows);
}

describe.runIf(nativePostgresUrl())("conversation inbox counters on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("maintains exact timestamp/marker/status/assignment transitions and atomic rollback through the real adapter", async () => {
    const pg = await createNativePostgres({ label: "inbox_counts" });
    expect((await pg.client.query(inboxCountsActual)).rows).toEqual([{ scope: "*", unread: 0, open: 0, unassigned_open: 0 }]);
    await seed(pg);
    await assertCounts(pg);
    for (const mutation of inboxCountsMutations) { await pg.db.run(sql.raw(mutation)); await assertCounts(pg); }
    await safeBatch(pg.db, inboxAppend("cnv_count_0001", 7).map((statement) => pg.db.run(sql.raw(statement))));
    await assertCounts(pg);
    const before = (await pg.client.query(inboxCountsActual)).rows;
    await expect(safeBatch(pg.db, [
      ...inboxAppend("cnv_count_0002", 7).map((statement) => pg.db.run(sql.raw(statement))),
      pg.db.run(sql`UPDATE conversations SET staff_read_seq=-1 WHERE id='cnv_count_0002'`),
    ])).rejects.toThrow();
    expect((await pg.client.query(inboxCountsActual)).rows).toEqual(before);
    await assertCounts(pg);
    for (const blocked of ["DELETE FROM conversations", "DELETE FROM conversation_messages", "UPDATE conversation_messages SET body='Changed'"]) {
      await expect(pg.db.run(sql.raw(blocked))).rejects.toThrow();
      await assertCounts(pg);
    }
  });

  it.each(["append", "read", "status", "assign"] as const)("retries a whole batch when an incoming append overlaps %s on the global row", async (operation) => {
    const pg = await createNativePostgres({ label: `inbox_race_${operation}` });
    await seed(pg);
    if (operation === "assign") await pg.db.run(sql`UPDATE conversations SET status='open' WHERE id='cnv_count_0002'`);
    let retries = 0;
    const db = createPostgresDatabase(pg.url, { connect: connectNativePostgres, onSerializationRetry: () => { retries++; }, sleep: async () => {} });
    const left = new Client({ connectionString: pg.url });
    await left.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await left.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const pid = Number((await left.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      for (const statement of inboxAppend("cnv_count_0001", 7)) await left.query(statement);
      const right = operation === "append" ? inboxAppend("cnv_count_0002", 7)
        : operation === "read" ? ["UPDATE conversations SET staff_read_seq=5 WHERE id='cnv_count_0002'"]
          : operation === "status" ? ["UPDATE conversations SET status='open' WHERE id='cnv_count_0002'"]
            : ["UPDATE conversations SET assignee_user_id='staff_count_a' WHERE id='cnv_count_0002'"];
      pending = safeBatch(db, [
        // This uncontended prefix must commit once after the complete operation retries.
        db.run(sql`UPDATE conversations SET version=version+1 WHERE id='cnv_count_0003'`),
        ...right.map((statement) => db.run(sql.raw(statement))),
      ]);
      const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      let blocked = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const { rows } = await pg.client.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [pid]);
        if (Number(rows[0].n) > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await left.query("COMMIT");
      const result = await settled;
      if (!result.ok) throw result.error;
      expect(blocked).toBe(true);
      expect(retries).toBeGreaterThan(0);
      expect((await pg.client.query("SELECT version FROM conversations WHERE id='cnv_count_0003'")).rows).toEqual([{ version: 2 }]);
      await assertCounts(pg);
    } finally {
      await left.query("ROLLBACK").catch(() => undefined);
      await left.end();
      await pending?.catch(() => undefined);
    }
  });

  it("copies the canonical counter snapshot with maintenance suspended, then resumes exact updates", async () => {
    const source = await createNativePostgres({ label: "inbox_export" });
    const target = await createNativePostgres({ label: "inbox_import" });
    await seed(source);
    const tables = ["customers", "user", "conversations", "conversation_messages", "conversation_inbox_counts"];
    await target.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      for (const table of ["conversations", "conversation_messages"]) await target.client.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
      await target.client.query("DELETE FROM conversation_inbox_counts"); // Replace migration's global seed.
      for (const table of tables) {
        const rows = (await source.client.query(`SELECT * FROM "${table}"`)).rows;
        for (const row of rows) {
          const keys = Object.keys(row);
          await target.client.query(`INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
        }
      }
      // Canonical FKs are initially deferred; resolve their pending events before trigger DDL.
      await target.client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const table of ["conversations", "conversation_messages"]) await target.client.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      await target.client.query("COMMIT");
    } catch (error) { await target.client.query("ROLLBACK"); throw error; }
    expect((await target.client.query(inboxCountsActual)).rows).toEqual((await source.client.query(inboxCountsActual)).rows);
    await safeBatch(target.db, inboxAppend("cnv_count_0001", 7).map((statement) => target.db.run(sql.raw(statement))));
    await assertCounts(target);
  });
});
