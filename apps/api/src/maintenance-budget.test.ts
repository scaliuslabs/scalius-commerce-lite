// Real Worker/D1 integration budget for bounded scheduled maintenance: a Free
// tick runs the drains and one job of the sweep rotation inline, so every
// tick of a whole rotation (and each job) must fit Workers Free's 50 D1
// queries, with busy work due.
// Isolated migrated SQLite; never uses the running developer store or providers.
import "@hono/zod-openapi";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@scalius/database/client";
import {
  createFreePlanStore,
  type FreePlanStore,
} from "./testing/free-plan-store";
import {
  seedCatalog,
  seedOrders,
} from "./testing/free-plan-seed";
import { readMaintenanceCursor } from "./scheduled/cursor";
import { DRAIN_TICK_MS, MAINTENANCE_SWEEPS, type SweepContext } from "./scheduled-maintenance";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";
import { processPaymentConfirmed, processRefund, REFUND_OBSERVED_EVENT_TYPE } from "@scalius/core/modules/payments";
import { createFakeGateway, FAKE_GATEWAY_ID } from "../../../packages/core/src/modules/payments/gateways/testing";
import * as paymentProviders from "./plugins/providers/payment";

const report: Record<string, unknown> = {};
const clock = 1_800_014_400;
const hour = Math.floor((clock * 1000) / 3_600_000) * 3_600_000;
let store: FreePlanStore;
let serial = 0;
function seedNotification(id: string) {
  store.sqlite.prepare(`INSERT INTO notification_outbox
    (id,dedupe_key,subject_type,subject_id,order_id,audience,notification_type,source,payload,status,next_attempt_at,created_at,updated_at)
    VALUES (?,?,'order','ord_seed_1','ord_seed_1','customer','order_created','maintenance-fixture','{}','pending',0,?,?)`)
    .run(id, id, clock - 900, clock - 900);
}
function seedBusyWork() {
  const prefix = `busy_${serial++}`;
  // More pending notifications than the per-tick flush bound.
  for (let index = 0; index < 100; index += 1)
    seedNotification(`pending_${prefix}_${index}`);
}

/** One sweep, run as its tick runs it, measured as one invocation. */
async function runSweep(name: string) {
  const sweep = MAINTENANCE_SWEEPS.find((item) => item.name === name);
  if (!sweep) throw new Error(`no sweep ${name}`);
  const env = store.worker.env;
  const context = {
    db: getDb(env),
    env,
    executionCtx: store.meter.ctx,
    runContext: { runId: "budget", startedAt: Date.now(), cron: "test", scheduledTime: "test", scheduledAt: hour },
    timed: <T>(_operation: string, fn: () => Promise<T>) => fn(),
  } as unknown as SweepContext;
  const result = await store.meter.measure(() => sweep.run(context));
  expect.soft(result.counters.d1Calls, name).toBeLessThanOrEqual(50);
  return { name, ...result.counters };
}

beforeAll(async () => {
  vi.stubGlobal("__SCALIUS_PLAN__", "free");
  vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
  store = await createFreePlanStore();
  store.sqlite.function("unixepoch", () => clock);
  seedCatalog(store.sqlite);
  seedOrders(store.sqlite, 100);
  store.sqlite.exec(
    "INSERT INTO user(id,name,email,email_verified,role,is_super_admin) VALUES ('budget_owner','Owner','budget@shop.test',1,'admin',1)",
  );

}, 120_000);
afterAll(() => {
  if (process.env.MAINTENANCE_BUDGET_REPORT)
    writeFileSync(
      process.env.MAINTENANCE_BUDGET_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  store?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Free maintenance integration budget", () => {
  it("measures cold initialization and every busy tick of a rotation through the real Worker", async () => {
    const cron = (time: number) =>
      store.worker.scheduled({
        cron: "* * * * *",
        scheduledTime: time,
        noRetry() {},
      } as ScheduledController);
    const cold = await store.meter.measure(() => cron(hour));
    report.cold = cold.counters;
    // Real eligible legacy reservations and stale online orders make the
    // existing slice work non-empty instead of proving only the new domains.
    for (let i = 1; i <= 12; i += 1) {
      store.sqlite
        .prepare("UPDATE product_variants SET reserved_stock=1 WHERE id=?")
        .run(`v_bulk_${i}`);
      store.sqlite
        .prepare(
          "INSERT INTO inventory_movements(id,variant_id,order_id,type,quantity,previous_stock,new_stock,created_at) VALUES (?,?,?,'reserved',1,100000,100000,?)",
        )
        .run(
          `expiry_budget_${i}`,
          `v_bulk_${i}`,
          `missing_expiry_${i}`,
          clock - 7200,
        );
    }
    store.sqlite.exec(
      "UPDATE orders SET status='incomplete',payment_method='stripe',payment_status='unpaid',created_at=1 WHERE id IN ('ord_seed_91','ord_seed_92','ord_seed_93','ord_seed_94','ord_seed_95','ord_seed_96')",
    );
    store.sqlite.exec(`
      INSERT INTO conversations(id,subject_type,order_id) VALUES ('cnv_budget_orphans','order','ord_seed_90');
      INSERT INTO digital_assets(id,product_id,kind,status,display_name,filename,media_type) VALUES ('dga_budget_cleanup','p_cotton','file','draft','File','file.pdf','application/pdf');
    `);
    for (let index = 0; index < 12; index += 1) {
      const id = `att_budget_${String(index).padStart(4, "0")}`;
      store.sqlite
        .prepare(
          "INSERT INTO conversation_attachments(id,conversation_id,uploader_type,uploader_ref,r2_key,size_bytes,sha256,created_at) VALUES (?,'cnv_budget_orphans','staff','budget_owner',?,1,?,1)",
        )
        .run(
          id,
          `private/conversations/cnv_budget_orphans/${id}`,
          "a".repeat(64),
        );
      for (const state of ["uploading", "complete"])
        store.sqlite
          .prepare(
            "INSERT INTO digital_asset_uploads(id,asset_id,r2_key,r2_upload_id,status,created_at,updated_at) VALUES (?,'dga_budget_cleanup',?,'multipart',?,1,1)",
          )
          .run(
            `${state}_${index}`,
            `private/digital/dga_budget_cleanup/${state}_${index}`,
            state,
          );
    }
    const errors = vi.spyOn(console, "error");
    // One minute per job: the whole rotation, each minute with busy work due.
    const ticks = [];
    for (let minute = 1; minute <= MAINTENANCE_SWEEPS.length; minute += 1) {
      seedBusyWork();
      const pendingBefore = (store.sqlite.prepare("SELECT count(*) AS n FROM notification_outbox WHERE status = 'pending'").get() as { n: number }).n;
      const result = await store.meter.measure(() => cron(hour + minute * DRAIN_TICK_MS));
      // The tick's notification drain took its bounded share of the due rows.
      const pendingAfter = (store.sqlite.prepare("SELECT count(*) AS n FROM notification_outbox WHERE status = 'pending'").get() as { n: number }).n;
      expect(pendingBefore - pendingAfter).toBe(PLAN_LIMITS.free.background.notificationsPerDrain);
      ticks.push({ minute, ...result.counters });
    }
    // The 02:00 store-time minute (20:00 UTC for Dhaka) runs only the nightly pass.
    const nightlyAt = Date.UTC(2027, 0, 15, 20, 0);
    const logs = vi.spyOn(console, "log");
    const nightly = await store.meter.measure(() => cron(nightlyAt));
    expect(logs.mock.calls.some((args) => String(args[0]).startsWith("[scheduled] Nightly catalogue"))).toBe(true);
    logs.mockRestore();
    ticks.push({ minute: "nightly", ...nightly.counters });
    report.maintenance = ticks;
    expect(
      errors.mock.calls.filter((args) =>
        args.some((arg) => String(arg).includes("scheduled_operation_failed")),
      ),
    ).toEqual([]);
    errors.mockRestore();
    for (const item of [cold.counters, ...ticks])
      expect.soft(item.d1Calls).toBeLessThanOrEqual(50);
  }, 120_000);

  it("keeps cursor progress under stale writers", async () => {
    const db = getDb(store.meter.bindings as Env);
    const first = await readMaintenanceCursor(db, "cursor-witness");
    await first.save({ rows: "a" });
    const earlier = await readMaintenanceCursor(db, "cursor-witness");
    const newer = await readMaintenanceCursor(db, "cursor-witness");
    await newer.save({ rows: "z" });
    await earlier.save({ rows: "b" });
    expect((await readMaintenanceCursor(db, "cursor-witness")).value.rows).toBe(
      "z",
    );
    expect(PLAN_LIMITS.paid.maintenance).toMatchObject({
      staleOrdersPerRun: 25,
      digitalUploadsPerState: 25,
      orphanAttachmentsPerRun: 50,
    });
  });

  it("advances past a poison stale order and wraps without losing it", async () => {
    store.sqlite.exec(`
      DELETE FROM settings WHERE category='maintenance' AND key='stale-orders';
      UPDATE orders SET status='incomplete',payment_method='stripe',payment_status='unpaid',created_at=1 WHERE id IN ('ord_seed_81','ord_seed_82');
      CREATE TRIGGER budget_poison_stale BEFORE UPDATE ON orders WHEN OLD.id='ord_seed_81' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'budget poison'); END;
    `);
    await runSweep("stale_incomplete_order_cleanup");
    await runSweep("stale_incomplete_order_cleanup");
    expect(
      store.sqlite
        .prepare(
          "SELECT deleted_at IS NOT NULL AS archived FROM orders WHERE id='ord_seed_82'",
        )
        .get(),
    ).toEqual({ archived: 1 });
    expect(
      store.sqlite
        .prepare("SELECT status FROM orders WHERE id='ord_seed_81'")
        .get(),
    ).toEqual({ status: "incomplete" });
    // Dropping the poison makes a later wrapped scan recover the same row.
    store.sqlite.exec("DROP TRIGGER budget_poison_stale");
    for (let tick = 0; tick < 10; tick += 1)
      await runSweep("stale_incomplete_order_cleanup");
    expect(
      store.sqlite
        .prepare(
          "SELECT deleted_at IS NOT NULL AS archived FROM orders WHERE id='ord_seed_81'",
        )
        .get(),
    ).toEqual({ archived: 1 });
  });

  it("repairs one bounded page of stale orders per sweep tick, past a poison row", async () => {
    store.sqlite.exec(`
      DELETE FROM settings WHERE category='maintenance' AND key='stale-orders';
      UPDATE orders SET status='incomplete',payment_method='stripe',payment_status='unpaid',created_at=1,deleted_at=NULL
        WHERE id IN ('ord_seed_71','ord_seed_72','ord_seed_73','ord_seed_74','ord_seed_75','ord_seed_76');
      CREATE TRIGGER budget_poison_chain BEFORE UPDATE ON orders WHEN OLD.id='ord_seed_71' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'budget poison'); END;
    `);
    const samples = [];
    for (let tick = 0; tick < 5; tick += 1) samples.push(await runSweep("stale_incomplete_order_cleanup"));
    const perRun = PLAN_LIMITS.free.maintenance.staleOrdersPerRun;
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM orders WHERE id BETWEEN 'ord_seed_72' AND 'ord_seed_76' AND deleted_at IS NOT NULL").get())
      .toEqual({ n: Math.min(5, 5 * perRun - 1) });
    expect(store.sqlite.prepare("SELECT status FROM orders WHERE id='ord_seed_71'").get()).toEqual({ status: "incomplete" });
    report.staleOrders = samples;
    store.sqlite.exec("DROP TRIGGER budget_poison_chain");
  });

  it("advances upload and orphan cursors past failed rows and retries them after wrapping", async () => {
    store.sqlite.exec(`
      INSERT INTO conversations(id,subject_type,order_id) VALUES ('cnv_poison_orphans','order','ord_seed_89');
      INSERT INTO digital_assets(id,product_id,kind,status,display_name,filename,media_type) VALUES ('dga_poison_cleanup','p_cotton','file','draft','File','file.pdf','application/pdf');
      INSERT INTO digital_asset_uploads(id,asset_id,r2_key,r2_upload_id,status,created_at,updated_at) VALUES ('uploading_poison_0','dga_poison_cleanup','private/digital/dga_poison_cleanup/0','multipart','uploading',1,1),('uploading_poison_1','dga_poison_cleanup','private/digital/dga_poison_cleanup/1','multipart','uploading',1,1);
      DELETE FROM settings WHERE category='maintenance' AND key IN ('orphan-attachments','digital-uploads');
      CREATE TRIGGER budget_poison_attachment BEFORE DELETE ON conversation_attachments WHEN OLD.id='att_poison_0000' BEGIN SELECT RAISE(ABORT,'budget poison'); END;
    `);
    // Reintroduce previously cleaned rows so both the poison and a later
    // healthy row compete for the same bounded page.
    store.sqlite.prepare("INSERT INTO conversation_attachments(id,conversation_id,uploader_type,uploader_ref,r2_key,size_bytes,sha256,created_at) VALUES ('att_poison_0000','cnv_poison_orphans','staff','budget_owner','private/conversations/cnv_poison_orphans/att_poison_0000',1,?,1)").run("b".repeat(64));
    store.sqlite.exec("UPDATE digital_asset_uploads SET status='uploading',created_at=1 WHERE id IN ('uploading_poison_0','uploading_poison_1')");
    store.sqlite.exec("CREATE TRIGGER budget_poison_upload BEFORE UPDATE ON digital_asset_uploads WHEN OLD.id='uploading_poison_0' BEGIN SELECT RAISE(ABORT,'budget poison'); END");
    for (const name of ["conversation_attachment_sweep", "digital_upload_sweep"]) {
      for (let tick = 0; tick < 2; tick += 1)
        await runSweep(name);
    }
    expect(store.sqlite.prepare("SELECT status FROM digital_asset_uploads WHERE id='uploading_poison_1'").get()).toEqual({ status: "aborted" });
    expect(store.sqlite.prepare("SELECT status FROM digital_asset_uploads WHERE id='uploading_poison_0'").get()).toEqual({ status: "uploading" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM conversation_attachments WHERE id='att_poison_0000'").get()).toEqual({ n: 1 });
    store.sqlite.exec("DROP TRIGGER budget_poison_attachment; DROP TRIGGER budget_poison_upload");
    for (const name of ["conversation_attachment_sweep", "digital_upload_sweep"])
      for (let tick = 0; tick < 3; tick += 1)
        await runSweep(name);
    expect(store.sqlite.prepare("SELECT status FROM digital_asset_uploads WHERE id='uploading_poison_0'").get()).toEqual({ status: "aborted" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM conversation_attachments WHERE id='att_poison_0000'").get()).toEqual({ n: 0 });
  });

  it("measures complete refund reconciliation with an inert provider, including failure and replay", async () => {
    const fake = createFakeGateway();
    const loader = vi.spyOn(paymentProviders, "appPaymentProvidersLoader").mockReturnValue(async () => fake.providers);
    const samples = [];
    try {
      for (const outcome of ["accepted", "rejected", "unknown", "external"] as const) {
        const orderId = `refund_budget_${outcome}`;
        store.sqlite.prepare("INSERT INTO orders(id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,balance_due_minor,payment_method,status,currency_code,currency_decimal_places) VALUES (?,'Buyer','+8801700000000','Dhaka','dhaka','zone_1',10000,10000,?,'incomplete','BDT',2)").run(orderId, FAKE_GATEWAY_ID);
        await processPaymentConfirmed(store.db, { orderId, provider: FAKE_GATEWAY_ID, amountMinor: 10000, currency: "BDT", paymentType: "full", providerRef: `pay_${outcome}`, secondaryRef: `txn_${outcome}` });
        store.sqlite.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(orderId);
        let name = "refund_attempt_reconciliation";
        if (outcome === "external") {
          name = "external_refund_reconciliation";
          fake.state.providerRefunds = [{ id: "budget_external", succeeded: true, amountMinor: 3000, currency: "BDT", sourceRef: `txn_${outcome}`, status: "succeeded" }];
          store.sqlite.prepare("INSERT INTO webhook_events(id,provider,event_type,order_id,status,result) VALUES (?,?,?,?, 'manual_reconciliation',?)").run("budget_external_event", FAKE_GATEWAY_ID, REFUND_OBSERVED_EVENT_TYPE, orderId, JSON.stringify({ providerRef: `pay_${outcome}`, secondaryRef: `txn_${outcome}` }));
        } else {
          fake.state.refundError = new Error("fixture unknown outcome");
          await expect(processRefund(store.db, { orderId, reason: "Fixture reconciliation" }, undefined, fake.providers)).rejects.toThrow(/unknown/i);
          fake.state.refundStatus = { outcome, providerStatus: outcome === "accepted" ? "refunded" : outcome };
          store.sqlite.prepare("UPDATE refund_attempts SET next_probe_at=0 WHERE order_id=?").run(orderId);
        }
        samples.push({ outcome, ...(await runSweep(name)) });
        const payment = store.sqlite.prepare("SELECT payment_status FROM orders WHERE id=?").get(orderId);
        expect(payment).toEqual({ payment_status: outcome === "accepted" ? "refunded" : outcome === "external" ? "partially_refunded" : "paid" });
      }
      const before = store.sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_type='refund' AND status='succeeded'").get();
      samples.push({ outcome: "replay", ...(await runSweep("external_refund_reconciliation")) });
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_type='refund' AND status='succeeded'").get()).toEqual(before);
      report.refundReconciliation = { samples, scope: "Real core and Worker; inert registered adapter replaces app loading/provider effects. Third-party runtime work is excluded." };
    } finally {
      loader.mockRestore();
    }
  });

  it("walks past poisoned automatic orders a bounded page per tick and fulfils the healthy one once", async () => {
    store.sqlite.exec(`
      INSERT INTO products(id,name,slug,price_minor,is_active) VALUES ('p_auto_budget','File','auto-budget',50000,1);
      INSERT INTO product_variants(id,product_id,sku,price_minor,stock,is_default,track_inventory,fulfillment_kind) VALUES ('v_auto_budget','p_auto_budget','AUTO-BUDGET',50000,0,1,0,'digital');
      INSERT INTO digital_assets(id,product_id,kind,status,display_name,filename,media_type,size_bytes,current_r2_key) VALUES ('dga_auto_budget','p_auto_budget','file','ready','File','file.pdf','application/pdf',1,'private/digital/dga_auto_budget/file');
      CREATE TRIGGER budget_poison_auto BEFORE INSERT ON order_fulfillments WHEN substr(NEW.order_id,1,12)='auto_poison_' BEGIN SELECT RAISE(ABORT,'budget poison'); END;
    `);
    for (const id of [
      ...Array.from(
        { length: 11 },
        (_, index) => `auto_poison_${String(index).padStart(2, "0")}`,
      ),
      "auto_z_good",
    ]) {
      store.sqlite
        .prepare(
          "INSERT INTO orders(id,customer_name,customer_phone,requires_shipping,subtotal_amount_minor,total_amount_minor,status,payment_method,payment_status,paid_amount_minor,balance_due_minor,inventory_action) VALUES (?,'Buyer','+8801700000000',0,50000,50000,'confirmed','stripe','paid',50000,0,'none')",
        )
        .run(id);
      store.sqlite
        .prepare(
          "INSERT INTO order_items(id,order_id,product_id,variant_id,quantity,product_name,inventory_tracked,unit_price_minor,line_subtotal_minor,discount_amount_minor,taxable_amount_minor,tax_amount_minor,fulfillment_type) VALUES (?,?,'p_auto_budget','v_auto_budget',1,'File',0,50000,50000,0,0,0,'digital')",
        )
        .run(`item_${id}`, id);
    }
    store.sqlite.exec("DELETE FROM settings WHERE category='maintenance' AND key='auto-fulfil'");
    // One bounded page per sweep tick: the cursor walks past the poison orders
    // (each fails without stopping the run) to the healthy one, then wraps.
    const samples = [];
    for (let tick = 0; tick < 14; tick += 1) {
      const sample = await runSweep("auto_fulfil_sweep");
      samples.push({ tick, ...sample });
    }
    report.autoFulfil = samples;
    expect(
      store.sqlite
        .prepare(
          "SELECT count(*) AS n FROM order_fulfillments WHERE order_id='auto_z_good'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      store.sqlite
        .prepare(
          "SELECT count(*) AS n FROM digital_entitlements WHERE order_id='auto_z_good'",
        )
        .get(),
    ).toEqual({ n: 1 });
    store.sqlite.exec("DROP TRIGGER budget_poison_auto");
  });

});
