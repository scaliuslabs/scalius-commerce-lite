// Real Worker/D1 integration budget for bounded scheduled maintenance jobs.
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
  seedMediaBacklog,
} from "./testing/free-plan-seed";
import { readMaintenanceCursor } from "./scheduled/cursor";
import { runQueuedMaintenance } from "./scheduled-maintenance";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";
import { processPaymentConfirmed, processRefund, REFUND_OBSERVED_EVENT_TYPE } from "@scalius/core/modules/payments";
import { createFakeGateway, FAKE_GATEWAY_ID } from "../../../packages/core/src/modules/payments/gateways/testing";
import * as paymentProviders from "./plugins/providers/payment";

const report: Record<string, unknown> = {};
const pluginId = "test.maintenance";
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
  store.sqlite.exec(
    "DELETE FROM conversation_search_terms; UPDATE conversation_search_state SET complete=0,last_message_id=NULL",
  );
  const conversation = `cnv_${prefix}_search`;
  store.sqlite
    .prepare(
      "INSERT INTO conversations(id,subject_type,order_id) VALUES (?,'order',?)",
    )
    .run(conversation, `ord_seed_${serial}`);
  for (let seq = 1; seq <= 110; seq += 1) {
    store.sqlite
      .prepare("UPDATE conversations SET last_seq=? WHERE id=?")
      .run(seq, conversation);
    store.sqlite
      .prepare(
        "INSERT INTO conversation_messages(id,conversation_id,seq,kind,visibility,author_type,body) VALUES (?, ?, ?, 'message','public','system','Old searchable message')",
      )
      .run(`msg_${prefix}_${String(seq).padStart(12, "0")}`, conversation, seq);
  }
}

async function measureQueuedMaintenance(from: number) {
  const jobs = [];
  for (let index = from; index < store.meter.queue.sent.length; index += 1) {
    const body = store.meter.queue.sent[index]!.body as Record<string, unknown>;
    if (body.type !== "maintenance.sweep" && body.type !== "order.auto_fulfil")
      continue;
    let acked = 0;
    let retried = 0;
    const result = await store.meter.measure(() =>
      store.worker.queue({
        queue: "jobs",
        metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
        messages: [
          {
            id: `maintenance_${index}`,
            timestamp: new Date(),
            attempts: 1,
            body,
            ack() {
              acked += 1;
            },
            retry() {
              retried += 1;
            },
          },
        ],
        ackAll() {},
        retryAll() {},
      }),
    );
    jobs.push({ name: body.name ?? body.type, ...result.counters });
    expect(acked).toBe(1);
    expect(retried).toBe(0);
    expect.soft(result.counters.d1Calls).toBeLessThanOrEqual(50);
  }
  return jobs;
}

beforeAll(async () => {
  vi.stubGlobal("__SCALIUS_PLAN__", "free");
  vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
  store = await createFreePlanStore();
  store.sqlite.function("unixepoch", () => clock);
  seedCatalog(store.sqlite);
  seedOrders(store.sqlite, 100);
  seedMediaBacklog(store.sqlite, 100);
  store.worker.env.IMAGES = store.meter.service({
    info: async () => ({}),
    input: () => ({}),
  }) as unknown as ImagesBinding;
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
  it("measures cold initialization and all busy maintenance slices through the real Worker", async () => {
    const cron = (time: number) =>
      store.worker.scheduled({
        cron: "*/15 * * * *",
        scheduledTime: time,
        noRetry() {},
      } as ScheduledController);
    const cold = await store.meter.measure(() => cron(hour));
    report.cold = cold.counters;
    report.coldJobs = await measureQueuedMaintenance(0);
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
    const slices = [];
    for (let slice = 0; slice < 4; slice += 1) {
      seedBusyWork();
      const queueStart = store.meter.queue.sent.length;
      const result = await store.meter.measure(() =>
        cron(hour + slice * 900_000),
      );
      const jobs = await measureQueuedMaintenance(queueStart);
      const indexed = Number(
        (
          store.sqlite
            .prepare(
              "SELECT count(distinct message_id) AS n FROM conversation_search_terms",
            )
            .get() as { n: number }
        ).n,
      );
      expect(indexed).toBe(100);
      expect(result.counters.queueTypes.notification).toBeGreaterThanOrEqual(
        40,
      );
      slices.push({
        slice,
        indexedMessages: indexed,
        jobs,
        ...result.counters,
      });
    }
    report.maintenance = slices;
    expect(
      errors.mock.calls.filter((args) =>
        args.some((arg) => String(arg).includes("scheduled_operation_failed")),
      ),
    ).toEqual([]);
    errors.mockRestore();
    console.log(
      "FREE_MAINTENANCE",
      JSON.stringify({ cold: cold.counters, slices }),
    );
    for (const item of [cold.counters, ...slices])
      expect.soft(item.d1Calls).toBeLessThanOrEqual(50);
  }, 120_000);

  it("keeps cursor progress under stale writers and mixed maintenance batches", async () => {
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
    const outcomes = { acked: [] as number[], retried: [] as number[] };
    const result = await store.meter.measure(() =>
      store.worker.queue({
        queue: "jobs",
        metadata: { metrics: { backlogCount: 3, backlogBytes: 0 } },
        messages: [0, 1, 2].map((index) => ({
          id: `mixed_${index}`,
          timestamp: new Date(),
          attempts: 1,
          body: {
            type: "maintenance.sweep",
            name: "digital_upload_sweep",
            scheduledAt: hour,
          },
          ack() {
            outcomes.acked.push(index);
          },
          retry() {
            outcomes.retried.push(index);
          },
        })),
        ackAll() {},
        retryAll() {},
      }),
    );
    expect(outcomes).toEqual({ acked: [0], retried: [1, 2] });
    expect(result.counters.d1Calls).toBeLessThanOrEqual(50);
    expect(PLAN_LIMITS.free.queue.consumerBatchSize).toBe(1);
    expect(PLAN_LIMITS.paid.maintenance).toMatchObject({
      queueSweeps: false,
      staleOrdersPerRun: 25,
      digitalUploadsPerState: 25,
      orphanAttachmentsPerRun: 50,
    });
    for (const invalid of [
      { pluginId: "", scheduledAt: hour },
      { pluginId: " ", scheduledAt: hour },
      { pluginId: 3, scheduledAt: hour },
      { pluginId, scheduledAt: Number.NaN },
    ]) {
      let retried = 0;
      await store.worker.queue({
        queue: "jobs",
        metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
        messages: [{ id: "invalid_app_job", timestamp: new Date(), attempts: 1,
          body: { type: "plugins.cron", ...invalid },
          ack() { throw new Error("Invalid app job must not be acknowledged"); },
          retry() { retried++; } }],
        ackAll() {}, retryAll() {},
      });
      expect(retried).toBe(1);
    }
  });

  it("advances past a poison stale order and wraps without losing it", async () => {
    store.sqlite.exec(`
      DELETE FROM settings WHERE category='maintenance' AND key='stale-orders';
      UPDATE orders SET status='incomplete',payment_method='stripe',payment_status='unpaid',created_at=1 WHERE id IN ('ord_seed_81','ord_seed_82');
      CREATE TRIGGER budget_poison_stale BEFORE UPDATE ON orders WHEN OLD.id='ord_seed_81' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'budget poison'); END;
    `);
    const job = {
      type: "maintenance.sweep" as const,
      name: "stale_incomplete_order_cleanup",
      scheduledAt: hour,
    };
    await runQueuedMaintenance(store.worker.env, store.meter.ctx, job);
    await runQueuedMaintenance(store.worker.env, store.meter.ctx, job);
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
      await runQueuedMaintenance(store.worker.env, store.meter.ctx, job);
    expect(
      store.sqlite
        .prepare(
          "SELECT deleted_at IS NOT NULL AS archived FROM orders WHERE id='ord_seed_81'",
        )
        .get(),
    ).toEqual({ archived: 1 });
  });

  it("preserves five stale candidates per hourly tick through sequential bounded jobs", async () => {
    store.sqlite.exec(`
      DELETE FROM settings WHERE category='maintenance' AND key='stale-orders';
      UPDATE orders SET status='incomplete',payment_method='stripe',payment_status='unpaid',created_at=1,deleted_at=NULL
        WHERE id IN ('ord_seed_71','ord_seed_72','ord_seed_73','ord_seed_74','ord_seed_75','ord_seed_76');
      CREATE TRIGGER budget_poison_chain BEFORE UPDATE ON orders WHEN OLD.id='ord_seed_71' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'budget poison'); END;
    `);
    const start = store.meter.queue.sent.length;
    await store.worker.env.JOBS_QUEUE!.send({ type: "maintenance.sweep", name: "stale_incomplete_order_cleanup", scheduledAt: hour, remaining: 5 });
    const samples = await measureQueuedMaintenance(start);
    expect(samples).toHaveLength(5);
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM orders WHERE id BETWEEN 'ord_seed_72' AND 'ord_seed_75' AND deleted_at IS NOT NULL").get()).toEqual({ n: 4 });
    expect(store.sqlite.prepare("SELECT status FROM orders WHERE id='ord_seed_76'").get()).toEqual({ status: "incomplete" });
    report.staleContinuation = samples;
    store.sqlite.exec("DROP TRIGGER budget_poison_chain");
    const second = store.meter.queue.sent.length;
    await store.worker.env.JOBS_QUEUE!.send({ type: "maintenance.sweep", name: "stale_incomplete_order_cleanup", scheduledAt: hour, remaining: 5 });
    await measureQueuedMaintenance(second);
    expect(store.sqlite.prepare("SELECT deleted_at IS NOT NULL AS archived FROM orders WHERE id='ord_seed_76'").get()).toEqual({ archived: 1 });
    for (const remaining of [0, -1, 6, 1.5, Number.NaN])
      await expect(runQueuedMaintenance(store.worker.env, store.meter.ctx, { type: "maintenance.sweep", name: "stale_incomplete_order_cleanup", scheduledAt: hour, remaining })).rejects.toThrow("Invalid maintenance continuation");
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
        await runQueuedMaintenance(store.worker.env, store.meter.ctx, { type: "maintenance.sweep", name, scheduledAt: hour });
    }
    expect(store.sqlite.prepare("SELECT status FROM digital_asset_uploads WHERE id='uploading_poison_1'").get()).toEqual({ status: "aborted" });
    expect(store.sqlite.prepare("SELECT status FROM digital_asset_uploads WHERE id='uploading_poison_0'").get()).toEqual({ status: "uploading" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM conversation_attachments WHERE id='att_poison_0000'").get()).toEqual({ n: 1 });
    store.sqlite.exec("DROP TRIGGER budget_poison_attachment; DROP TRIGGER budget_poison_upload");
    for (const name of ["conversation_attachment_sweep", "digital_upload_sweep"])
      for (let tick = 0; tick < 3; tick += 1)
        await runQueuedMaintenance(store.worker.env, store.meter.ctx, { type: "maintenance.sweep", name, scheduledAt: hour });
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
        const from = store.meter.queue.sent.length;
        await store.worker.env.JOBS_QUEUE!.send({ type: "maintenance.sweep", name, scheduledAt: hour });
        const [sample] = await measureQueuedMaintenance(from);
        samples.push({ outcome, ...sample });
        const payment = store.sqlite.prepare("SELECT payment_status FROM orders WHERE id=?").get(orderId);
        expect(payment).toEqual({ payment_status: outcome === "accepted" ? "refunded" : outcome === "external" ? "partially_refunded" : "paid" });
      }
      const before = store.sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_type='refund' AND status='succeeded'").get();
      const from = store.meter.queue.sent.length;
      await store.worker.env.JOBS_QUEUE!.send({ type: "maintenance.sweep", name: "external_refund_reconciliation", scheduledAt: hour });
      samples.push({ outcome: "replay", ...(await measureQueuedMaintenance(from))[0] });
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_type='refund' AND status='succeeded'").get()).toEqual(before);
      report.refundReconciliation = { samples, scope: "Real core and Worker; inert registered adapter replaces app loading/provider effects. Third-party runtime work is excluded." };
    } finally {
      loader.mockRestore();
    }
  });

  it("fans out beyond poisoned automatic orders and measures the real consumer and replay", async () => {
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
    const job = {
      type: "maintenance.sweep" as const,
      name: "auto_fulfil_sweep",
      scheduledAt: hour,
    };
    const start = store.meter.queue.sent.length;
    await runQueuedMaintenance(store.worker.env, store.meter.ctx, job);
    await runQueuedMaintenance(store.worker.env, store.meter.ctx, job);
    const selected = store.meter.queue.sent
      .slice(start)
      .map((entry) => entry.body as { type: string; orderId?: string });
    expect(
      selected
        .filter((body) => body.type === "order.auto_fulfil")
        .map((body) => body.orderId),
    ).toContain("auto_z_good");
    const samples = [];
    for (const orderId of ["auto_poison_00", "auto_z_good", "auto_z_good"]) {
      let acked = 0,
        retried = 0;
      const result = await store.meter.measure(() =>
        store.worker.queue({
          queue: "jobs",
          metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
          messages: [
            {
              id: `auto_${orderId}`,
              timestamp: new Date(),
              attempts: 1,
              body: { type: "order.auto_fulfil", orderId },
              ack() {
                acked++;
              },
              retry() {
                retried++;
              },
            },
          ],
          ackAll() {},
          retryAll() {},
        }),
      );
      expect({ acked, retried }).toEqual(
        orderId.includes("poison")
          ? { acked: 0, retried: 1 }
          : { acked: 1, retried: 0 },
      );
      expect(result.counters.d1Calls).toBeLessThanOrEqual(50);
      samples.push({
        outcome: orderId.includes("poison") ? "poison" : "success-or-replay",
        ...result.counters,
      });
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
