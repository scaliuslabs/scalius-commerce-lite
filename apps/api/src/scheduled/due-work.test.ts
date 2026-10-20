import "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { BACKGROUND_DRAINS } from "../scheduled-maintenance";
import { readDueDrains } from "./due-work";

const NOW = 1_800_000_000;
let store: SqliteTestDatabase | null = null;

function open(): SqliteTestDatabase {
  store = createSqliteD1Database();
  store.sqlite.function("unixepoch", () => NOW);
  // Fixture rows stand alone (no orders or subscriptions behind them).
  store.sqlite.exec("PRAGMA foreign_keys = OFF");
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  return store;
}

afterEach(() => {
  store?.sqlite.close();
  store = null;
  vi.restoreAllMocks();
});

const PROBED = BACKGROUND_DRAINS.filter((drain) => drain.due).map((drain) => drain.name).sort();

describe("the due-work probe", () => {
  it("probes the drains that cost a query, and only they skip", () => {
    expect(PROBED).toEqual([
      "bulk_run_drain",
      "event_drain",
      "notification_drain",
      "payment_event_drain",
      "projection_rebuild_drain",
    ]);
  });

  it("answers an idle store in one statement, with no drain due", async () => {
    const { db, binding } = open();
    const prepare = vi.spyOn(binding, "prepare");
    expect(await readDueDrains(db, BACKGROUND_DRAINS)).toEqual(new Set());
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("finds each drain's due rows with the drain's own conditions, and nothing not yet due", async () => {
    const { db, sqlite } = open();
    const due = () => readDueDrains(db, BACKGROUND_DRAINS);
    const notification = (id: string, status: string, nextAttemptAt: number, claimExpiresAt: number | null = null) => sqlite.prepare(
      `INSERT INTO notification_outbox (id,dedupe_key,subject_type,subject_id,order_id,audience,notification_type,source,payload,status,next_attempt_at,claim_expires_at,created_at,updated_at)
       VALUES (?,?,'order','ord_1','ord_1','customer','order_created','test','{}',?,?,?,?,?)`,
    ).run(id, id, status, nextAttemptAt, claimExpiresAt, NOW, NOW);

    // Not due: a retry in the future, a live lease, a sent row.
    notification("ntf_later", "failed", NOW + 60);
    notification("ntf_leased", "processing", 0, NOW + 60);
    notification("ntf_sent", "sent", 0);
    expect(await due()).toEqual(new Set());

    notification("ntf_lapsed", "processing", 0, NOW - 1);
    expect(await due()).toEqual(new Set(["notification_drain"]));

    sqlite.prepare(`INSERT INTO event_outbox (id,topic,resource_type,resource_id,data,status,next_attempt_at)
      VALUES ('evt_later','order.created','order','ord_1','{}','pending',?)`).run(NOW + 60);
    expect((await due())!.has("event_drain")).toBe(false);
    sqlite.prepare(`INSERT INTO event_outbox (id,topic,resource_type,resource_id,data,status,next_attempt_at)
      VALUES ('evt_due','order.created','order','ord_1','{}','failed',?)`).run(NOW);
    expect((await due())!.has("event_drain")).toBe(true);

    sqlite.prepare(`INSERT INTO webhook_events (id,provider,event_type,status,payload,next_attempt_at)
      VALUES ('whe_unreplayable','gw','payment','retrying',NULL,0)`).run();
    expect((await due())!.has("payment_event_drain")).toBe(false);
    sqlite.prepare(`INSERT INTO webhook_events (id,provider,event_type,status,payload,next_attempt_at)
      VALUES ('whe_retry','gw','payment','retrying','{}',?)`).run(NOW);
    expect((await due())!.has("payment_event_drain")).toBe(true);

    sqlite.prepare(`INSERT INTO system_kv (key,value) VALUES ('catalog:projections:rebuild-cursor','')`).run();
    expect((await due())!.has("projection_rebuild_drain")).toBe(true);

    sqlite.prepare(`INSERT INTO bulk_runs (id,kind,status,operation_key,request_hash,input,lease_until)
      VALUES ('blk_leased','customers.tag','running','k1','h','{}',?)`).run(NOW + 60);
    expect((await due())!.has("bulk_run_drain")).toBe(false);
    sqlite.prepare(`INSERT INTO bulk_runs (id,kind,status,operation_key,request_hash,input,lease_until)
      VALUES ('blk_free','customers.tag','running','k2','h','{}',NULL)`).run();
    expect(await due()).toEqual(new Set(PROBED));
  });

  it("runs every drain when the probe cannot be read", async () => {
    const { db, sqlite } = open();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sqlite.exec("DROP TABLE bulk_runs");
    expect(await readDueDrains(db, BACKGROUND_DRAINS)).toBeNull();
  });
});
