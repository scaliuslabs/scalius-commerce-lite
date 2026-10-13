import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { ConflictError, NotFoundError } from "@scalius/core/errors";
import { clearStaffAlerts, markAllStaffAlertsRead, markStaffAlertRead, pruneStaffAlerts, readStaffAlerts, readStaffAlertSummary, recordStaffAlert, STAFF_ALERT_INBOX_KEEP, STAFF_ALERT_RETENTION_SECONDS, undoStaffAlertsClear } from "./staff-alerts";
import { seedStaffAlerts, seedStaffAlertEvent } from "./testing/staff-alerts";

let db: Database;
let sqlite: DatabaseSync;
let reads: Array<{ text: string; params: SQLInputValue[] }>;
beforeEach(async () => {
  reads = [];
  ({ db, sqlite } = createSqliteD1Database({ onQuery: (text, params) => reads.push({ text, params: params.map((value) => value as SQLInputValue) }) }));
  await seedStaffAlerts(db);
});
afterEach(() => sqlite.close());
async function append(id: string, conversation = false, time = 1000) {
  await seedStaffAlertEvent(db, id, conversation, time);
  await recordStaffAlert(db, id, true);
}
const state = () => sqlite.prepare("SELECT * FROM staff_alert_state ORDER BY user_id,scope").all();
const revisions = (summary: Awaited<ReturnType<typeof readStaffAlertSummary>>) => summary.scopes.map(({ scope, revision }) => ({ scope, revision }));

describe("durable staff alert inbox", () => {
  it("records without devices, strips private text, fixes recipients once and keeps a monotonic late-event order", async () => {
    await append("bell_first");
    await append("bell_late", false, 1);
    await recordStaffAlert(db, "bell_first", true);
    let page = await readStaffAlerts(db, "bell_a");
    expect(page.items.map((item) => [item.seq,item.id,item.orderNumber])).toEqual([[2,"bell_late","1234"],[1,"bell_first","1234"]]);
    expect(JSON.stringify(page)).not.toMatch(/Private Buyer|Private address|1711111111/);
    await db.run(sql`INSERT INTO user (id,name,email,is_super_admin) VALUES ('bell_new','New','new@example.test',1)`);
    await recordStaffAlert(db, "bell_first", true);
    expect((await readStaffAlerts(db, "bell_new")).items).toEqual([]);
    await append("bell_new_event");
    expect((await readStaffAlerts(db, "bell_new")).items.map((item) => item.seq)).toEqual([1]);
    page = await readStaffAlerts(db, "bell_a", { limit: 1 });
    expect(page.nextBefore).toBe(3);
    const next = await readStaffAlerts(db, "bell_a", { limit: 2, beforeSeq: page.nextBefore! });
    expect(next.items.map((item) => item.id)).toEqual(["bell_late","bell_first"]);
    expect(next.nextBefore).toBeNull();
  });

  it("does not record disabled, buyer-only or missing-outbox events", async () => {
    await seedStaffAlertEvent(db, "bell_disabled");
    await recordStaffAlert(db, "bell_disabled", false);
    await db.run(sql`UPDATE notification_outbox SET notification_type='conversation_reply' WHERE id='bell_disabled'`);
    await recordStaffAlert(db, "bell_disabled", true);
    await recordStaffAlert(db, undefined, true);
    expect((await readStaffAlerts(db, "bell_a")).items).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM staff_alerts").get()).toEqual({ n: 0 });
  });

  it("fixes an empty recipient set and rolls failed fanout back before any retry", async () => {
    await db.run(sql`UPDATE user_permissions SET granted=0`);
    await append("bell_empty");
    await db.run(sql`UPDATE user_permissions SET granted=1`);
    await recordStaffAlert(db, "bell_empty", true);
    expect((await readStaffAlerts(db, "bell_a")).items).toEqual([]);
    await seedStaffAlertEvent(db, "bell_failure");
    sqlite.exec("CREATE TRIGGER bell_fail BEFORE INSERT ON staff_alert_inbox WHEN NEW.user_id='bell_b' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    await expect(recordStaffAlert(db, "bell_failure", true)).rejects.toThrow("test failure");
    expect(sqlite.prepare("SELECT count(*) AS n FROM staff_alerts WHERE id='bell_failure'").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM staff_alert_state").get()).toEqual({ n: 0 });
    sqlite.exec("DROP TRIGGER bell_fail");
    await recordStaffAlert(db, "bell_failure", true);
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => item.seq)).toEqual([1]);
  });

  it("filters recording and reading by current grants, bans, and per-account scopes", async () => {
    await append("bell_order_event"); await append("bell_message", true);
    expect((await readStaffAlerts(db, "bell_b")).items.map((item) => item.id)).toEqual(["bell_order_event"]);
    await expect(markStaffAlertRead(db, "bell_b", 2)).rejects.toBeInstanceOf(NotFoundError);
    await db.run(sql`UPDATE user_permissions SET granted=0 WHERE id='bell_a_orders'`);
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => item.id)).toEqual(["bell_message"]);
    await db.run(sql`UPDATE user_permissions SET granted=1 WHERE id='bell_a_orders'`);
    expect((await readStaffAlertSummary(db, "bell_a")).unreadCount).toBe(2);
    await db.run(sql`UPDATE user SET banned=1 WHERE id='bell_a'`);
    expect((await readStaffAlertSummary(db, "bell_a")).unreadCount).toBe(0);
    await append("bell_banned");
    expect(sqlite.prepare("SELECT count(*) AS n FROM staff_alert_inbox WHERE user_id='bell_a'").get()).toEqual({ n: 2 });
  });

  it("read-all acknowledges only the observed frontier and no newly granted scope", async () => {
    await append("bell_one"); await append("bell_two", true);
    const shown = await readStaffAlertSummary(db, "bell_a");
    await append("bell_three");
    await markAllStaffAlertsRead(db, "bell_a", { through: shown.head, scopes: ["orders"] });
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => [item.seq,item.read])).toEqual([[3,false],[2,false],[1,true]]);
  });

  it("clear-all marks read, undo restores prior markers, individual receipts survive, and new deliveries remain", async () => {
    await append("bell_one"); await append("bell_two", true);
    await markStaffAlertRead(db, "bell_a", 1);
    const shown = await readStaffAlertSummary(db, "bell_a");
    const input = { operationId: "clear_test_01", through: shown.head, scopes: revisions(shown) };
    const cleared = await clearStaffAlerts(db, "bell_a", input);
    const clearedState = state();
    expect((await readStaffAlerts(db, "bell_a")).items).toEqual([]);
    expect(cleared.summary.unreadCount).toBe(0);
    await clearStaffAlerts(db, "bell_a", input); // Lost-response retry preserves Undo snapshot.
    expect(state()).toEqual(clearedState);
    await append("bell_three");
    await undoStaffAlertsClear(db, "bell_a", cleared.undo!);
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => [item.seq,item.read])).toEqual([[3,false],[2,false],[1,true]]);
    await expect(clearStaffAlerts(db, "bell_a", input)).rejects.toBeInstanceOf(ConflictError);
  });

  it("prunes only history no reader or Undo can reach, and alerts left without an inbox row", async () => {
    await append("bell_one"); await append("bell_two", true); await append("bell_three");
    // Alerts are recorded at database time; prune a month and a minute later.
    const now = Math.floor(Date.now() / 1000) + STAFF_ALERT_RETENTION_SECONDS + 60;
    // Nothing is cleared or beyond the kept window: nothing goes.
    expect(await pruneStaffAlerts(db, now)).toEqual({ inbox: 0, alerts: 0 });
    const shown = await readStaffAlertSummary(db, "bell_a");
    const cleared = await clearStaffAlerts(db, "bell_a", { operationId: "clear_prune_01", through: shown.head, scopes: revisions(shown) });
    // Undo can still restore the first clear: its rows stay.
    expect(await pruneStaffAlerts(db, now)).toEqual({ inbox: 0, alerts: 0 });
    await append("bell_four");
    const again = await readStaffAlertSummary(db, "bell_a");
    await clearStaffAlerts(db, "bell_a", { operationId: "clear_prune_02", through: again.head, scopes: revisions(again) });
    // The first clear is now beyond Undo: bell_a's three oldest rows go; bell_b keeps its own,
    // so only the conversation alert (bell_a's alone) is left without a row.
    expect(await pruneStaffAlerts(db, now)).toEqual({ inbox: 3, alerts: 1 });
    expect(sqlite.prepare("SELECT user_id, seq FROM staff_alert_inbox ORDER BY user_id, seq").all())
      .toEqual([{ user_id: "bell_a", seq: 4 }, { user_id: "bell_b", seq: 1 }, { user_id: "bell_b", seq: 2 }, { user_id: "bell_b", seq: 3 }]);
    expect(cleared.undo).toBeDefined();
    // A staff member's history beyond the newest STAFF_ALERT_INBOX_KEEP rows goes, then alerts nobody holds.
    sqlite.prepare("UPDATE staff_alert_state SET last_seq = last_seq + ? WHERE user_id = 'bell_b' AND scope = '*'").run(STAFF_ALERT_INBOX_KEEP);
    expect(await pruneStaffAlerts(db, now)).toEqual({ inbox: 3, alerts: 2 });
    expect(sqlite.prepare("SELECT id FROM staff_alerts").all()).toEqual([{ id: "bell_four" }]);
    expect((await readStaffAlerts(db, "bell_a")).items).toEqual([]);
    expect(await pruneStaffAlerts(db, now)).toEqual({ inbox: 0, alerts: 0 });
  });

  it("keeps an explicit read after Clear all and refuses an Undo that would cross it", async () => {
    await append("bell_receipt");
    const shown = await readStaffAlertSummary(db, "bell_a");
    const cleared = await clearStaffAlerts(db, "bell_a", { operationId: "clear_receipt_01", through: shown.head, scopes: revisions(shown) });
    await markStaffAlertRead(db, "bell_a", 1);
    expect(sqlite.prepare("SELECT read_at FROM staff_alert_inbox WHERE user_id='bell_a' AND seq=1").get()?.read_at).not.toBeNull();
    const before = state();
    await expect(undoStaffAlertsClear(db, "bell_a", cleared.undo!)).rejects.toBeInstanceOf(ConflictError);
    expect(state()).toEqual(before);
  });

  it("rolls back all scopes and lazy state inserts when even one clear revision is stale", async () => {
    await append("bell_one"); await append("bell_two", true);
    await markStaffAlertRead(db, "bell_a", 1);
    const before = state();
    const shown = await readStaffAlertSummary(db, "bell_a");
    const scopes = revisions(shown).map((entry) => entry.scope === "conversations" ? { ...entry, revision: entry.revision + 1 } : entry);
    await expect(clearStaffAlerts(db, "bell_a", { operationId: "clear_stale_01", through: shown.head, scopes })).rejects.toBeInstanceOf(ConflictError);
    expect(state()).toEqual(before);
    expect((await readStaffAlerts(db, "bell_a")).items).toHaveLength(2);
  });

  it("undo makes no partial change after another scope read or permission revocation", async () => {
    await append("bell_one"); await append("bell_two", true);
    const shown = await readStaffAlertSummary(db, "bell_a");
    const cleared = await clearStaffAlerts(db, "bell_a", { operationId: "clear_test_02", through: shown.head, scopes: revisions(shown) });
    await append("bell_three", true);
    await markStaffAlertRead(db, "bell_a", 3);
    const before = state();
    await expect(undoStaffAlertsClear(db, "bell_a", cleared.undo!)).rejects.toBeInstanceOf(ConflictError);
    expect(state()).toEqual(before);
    await db.run(sql`UPDATE user_permissions SET granted=0 WHERE id='bell_a_orders'`);
    await expect(clearStaffAlerts(db, "bell_a", { operationId: "clear_revoke_01", through: 3, scopes: revisions(shown) })).rejects.toBeInstanceOf(ConflictError);
    expect(state()).toEqual(before);
  });

  it("caps honestly and uses the unread partial index and limited scope ranges after clearing a long read history", async () => {
    sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1200)
      INSERT INTO staff_alerts (id,scope,kind,subject_id,occurred_at,fanout_complete)
      SELECT 'bulk_'||i,'orders','order_created','bell_order',1000,1 FROM n;
      INSERT INTO staff_alert_inbox(user_id,seq,alert_id,scope,read_at)
      SELECT 'bell_a',CAST(substr(id,6) AS INTEGER),id,'orders',CASE WHEN CAST(substr(id,6) AS INTEGER)<=1000 THEN 1001 ELSE NULL END FROM staff_alerts;
      INSERT INTO staff_alert_state(user_id,scope,last_seq) VALUES('bell_a','*',1200);`);
    expect(await readStaffAlertSummary(db, "bell_a")).toMatchObject({ unreadCount: 99, unreadCountCapped: true, countCap: 99 });
    const shown = await readStaffAlertSummary(db, "bell_a");
    await clearStaffAlerts(db, "bell_a", { operationId: "clear_long_01", through: 1190, scopes: revisions(shown) });
    reads = [];
    const page = await readStaffAlerts(db, "bell_a", { limit: 5 });
    expect(page.items.map((item) => item.seq)).toEqual([1200,1199,1198,1197,1196]);
    expect(page).toMatchObject({ unreadCount: 10, unreadCountCapped: false });
    expect(reads).toHaveLength(1); // Feed, count, head and revisions share one statement snapshot.
    const query = reads[0]!;
    expect(query.params.length).toBeLessThanOrEqual(100);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.text}`).all(...query.params).map((row) => String(row.detail)).join("\n");
    expect(plan).toContain("staff_alert_inbox_unread_idx");
    expect(plan).toMatch(/staff_alert_inbox_scope_seq_idx \(user_id=\? AND scope=\? AND seq>\?\)/);
    expect(plan).not.toMatch(/SCAN (?:staff_alert_inbox|i)(?:\s|$)/);
  });

  it("seeks a sparse authorized scope below the cursor without walking opposite-scope history", async () => {
    sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1200)
      INSERT INTO staff_alerts(id,scope,kind,subject_id,occurred_at,fanout_complete)
      SELECT 'sparse_'||i,CASE WHEN i=1 THEN 'orders' ELSE 'conversations' END,
        CASE WHEN i=1 THEN 'order_created' ELSE 'conversation_message' END,'bell_order',1000,1 FROM n;
      INSERT INTO staff_alert_inbox(user_id,seq,alert_id,scope)
      SELECT 'bell_b',CAST(substr(id,8) AS INTEGER),id,scope FROM staff_alerts;
      INSERT INTO staff_alert_state(user_id,scope,last_seq) VALUES('bell_b','*',1200);`);
    reads = [];
    const page = await readStaffAlerts(db, "bell_b", { beforeSeq: 1200 });
    expect(page.items.map((item) => item.seq)).toEqual([1]);
    expect(page).toMatchObject({ unreadCount: 1, nextBefore: null });
    expect(reads).toHaveLength(1);
    const query = reads[0]!;
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.text}`).all(...query.params).map((row) => String(row.detail)).join("\n");
    expect(plan.match(/staff_alert_inbox_scope_seq_idx \(user_id=\? AND scope=\? AND seq>\? AND seq<\?\)/g)).toHaveLength(2);
    expect(plan).not.toContain("sqlite_autoindex_staff_alert_inbox_1");
  });
});
