// Extends zod with .openapi() before the route schemas load.
import "@hono/zod-openapi";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS, type WorkersPlan } from "@scalius/shared/plan-limits";
import { storefrontBatchPath } from "@scalius/shared/public-api-cache-routes";
import {
  emptyCounters,
  internalSubrequests,
  median,
  type FreePlanCounters,
} from "./testing/free-plan-meter";
import { rotateRecommendations } from "./background/catalog";
import { DVC_AUDIT_RATE } from "./public-read";
import { STORE, createFreePlanStore, type FreePlanStore } from "./testing/free-plan-store";
import { seedCatalog, seedOrders } from "./testing/free-plan-seed";
import { jsonRequest, placeOrder as checkoutOrder, taxQuote as checkoutQuote } from "./testing/free-plan-checkout";
import { BUDGETS, type Budget } from "./testing/free-plan-budgets";
import { syncBundledPluginsOncePerDeploy } from "./plugins/scheduled";
import { getDb } from "@scalius/database/client";

/**
 * The Workers plan budget of the operations a store depends on, measured through
 * the real Worker entrypoints under BOTH plan profiles (scripts/free-plan-budget.mjs
 * prints the table; docs/FREE-PLAN.md explains the limits). The gate asserts what
 * is deterministic: D1 round trips and statements and external subrequests
 * (after-response work included), against `testing/free-plan-budgets.ts` and
 * Free's absolute ceilings. CPU is recorded for the report (it moves with the
 * machine; the workerd tier, free-plan-workerd.test.ts, measures it where it is
 * real).
 */

export interface Measurement {
  id: string;
  label: string;
  runs: number;
  /** The first run (JIT-cold; vitest also pays its transform here). */
  cold: FreePlanCounters;
  /** The median CPU over the warm runs. */
  warmCpuMs: number;
  /** The worst run of each counter (the runs of one operation are identical but for rotating slices). */
  counters: FreePlanCounters;
  /** The mean of each counter over the warm runs: what a steady-state day pays per run. */
  mean: FreePlanCounters;
}

/**
 * What one invocation may do, per plan (developers.cloudflare.com/workers/platform/limits,
 * developers.cloudflare.com/d1/platform/limits): D1 queries (a batch is one),
 * subrequests to Cloudflare services, and external subrequests. A plan's profile must
 * keep every operation under its own plan's limits.
 */
const INVOCATION_LIMITS = {
  free: { d1Calls: 50, internalSubrequests: 1_000, externalFetches: 50 },
  paid: { d1Calls: 1_000, internalSubrequests: 10_000, externalFetches: 10_000 },
} as const satisfies Record<WorkersPlan, { d1Calls: number; internalSubrequests: number; externalFetches: number }>;
const PLANS = ["free", "paid"] as const satisfies readonly WorkersPlan[];
const report: Record<string, Measurement[]> = { free: [], paid: [] };

function worst(results: FreePlanCounters[]): FreePlanCounters {
  const out = emptyCounters();
  for (const counters of results) {
    for (const key of Object.keys(out) as Array<keyof FreePlanCounters>) {
      (out[key] as number) = Math.max(out[key] as number, counters[key] as number);
    }
  }
  return out;
}

function mean(results: FreePlanCounters[]): FreePlanCounters {
  const out = emptyCounters();
  for (const counters of results) {
    for (const key of Object.keys(out) as Array<keyof FreePlanCounters>) {
      (out[key] as number) += (counters[key] as number) / results.length;
    }
  }
  return out;
}

const PAGES = {
  home: ["/api/v1/storefront/layout", "/api/v1/storefront/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  product: ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  category: ["/api/v1/storefront/layout", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest"],
  search: ["/api/v1/storefront/layout", "/api/v1/products?page=1&limit=20&sort=relevance&search=linen"],
} as const;

describe.each(PLANS)("Workers %s plan budget", (plan) => {
  const limits = PLAN_LIMITS[plan];
  const measurements = report[plan]!;
  let store: FreePlanStore;
  const pendingChallenge = new Map<string, { challengeKey: string; deliveryKey: string }>();

  async function run(
    id: string,
    label: string,
    runs: number,
    operation: (index: number) => Promise<void>,
    /** Unmetered setup before each run. */
    prepare?: (index: number) => Promise<void>,
    /** Runs before this index are warm-up: the mean (steady state) leaves them out. */
    warmFrom = 1,
  ): Promise<Measurement> {
    const results: FreePlanCounters[] = [];
    for (let index = 0; index < runs; index += 1) {
      await prepare?.(index);
      await store.meter.settle();
      const { counters } = await store.meter.measure(() => operation(index));
      results.push(counters);
    }
    const measurement: Measurement = {
      id,
      label,
      runs,
      cold: results[0]!,
      warmCpuMs: median(results.slice(warmFrom).map((counters) => counters.cpuMs)),
      counters: worst(results),
      mean: mean(results.length > warmFrom ? results.slice(warmFrom) : results),
    };
    measurements.push(measurement);
    return measurement;
  }

  /**
   * Every deterministic counter against this plan's recorded budget, and (for
   * one invocation) Free's absolute ceilings. FREE_PLAN_BUDGET_RECORD=1 only
   * measures: it is how the budgets are regenerated.
   */
  function expectWithin(measurement: Measurement): void {
    const { counters } = measurement;
    if (process.env.FREE_PLAN_BUDGET_RECORD === "1") return;
    const budget: Budget | undefined = BUDGETS[plan][measurement.id];
    expect(budget, `${measurement.id} has a recorded budget on the ${plan} profile (testing/free-plan-budgets.ts)`).toBeDefined();
    const actual: Budget = {
      d1Calls: counters.d1Calls,
      d1Statements: counters.d1Statements,
      externalFetches: counters.externalFetches,
      rowsWritten: counters.d1RowsChanged,
      rowsRead: counters.d1RowsRead,
      fullScans: counters.d1FullScans,
    };
    const steady: Budget = { meanRowsWritten: measurement.mean.d1RowsChanged, meanRowsRead: measurement.mean.d1RowsRead };
    for (const [key, max] of Object.entries(budget ?? {}) as Array<[keyof Budget, number]>) {
      // Means are floating point sums; the budget is their ceiling to 1/100.
      expect({ ...actual, ...steady }[key], `${plan} ${measurement.id} ${key}`).toBeLessThanOrEqual(max + 1e-6);
    }
    const ceiling = INVOCATION_LIMITS[plan];
    expect(counters.d1Calls, `${plan} ${measurement.id} stays under ${ceiling.d1Calls} D1 queries per invocation`).toBeLessThanOrEqual(ceiling.d1Calls);
    expect(internalSubrequests(counters), `${plan} ${measurement.id} stays under ${ceiling.internalSubrequests} service subrequests`).toBeLessThanOrEqual(ceiling.internalSubrequests);
    expect(counters.externalFetches, `${plan} ${measurement.id} stays under ${ceiling.externalFetches} external subrequests`).toBeLessThanOrEqual(ceiling.externalFetches);
  }

  async function renderPage(parts: readonly string[]): Promise<void> {
    const response = await store.worker.fetch(new Request(`https://api.internal${storefrontBatchPath(parts)}`, {
      headers: { "X-Scalius-Cache-Generation": "gen1" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { parts: Array<{ status: number }> } };
    const failed = body.data.parts.map((part, index) => ({ path: parts[index], status: part.status })).filter((part) => part.status >= 500);
    expect(failed).toEqual([]);
  }

  const taxQuote = (lines: number) => checkoutQuote(store, lines);
  const placeOrder = (lines: number, quote: string) => checkoutOrder(store, lines, quote);

  const CRON_TIME = Date.parse("2026-10-03T10:15:00Z");
  const NIGHTLY_TIME = Date.parse("2026-10-03T20:00:00Z");
  const cron = (scheduledTime: number) =>
    store.worker.scheduled({ cron: "* * * * *", scheduledTime, noRetry: () => undefined } as unknown as ScheduledController);
  /** Cron ticks one a minute: an hour holds every Free job at least twice and four Paid sweep ticks. */
  const hour = Math.floor(CRON_TIME / 3_600_000) * 3_600_000;
  const minuteOfHour = (index: number) => cron(hour + index * 60_000);

  let randomSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeAll(async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", plan);
    // One validated hit in DVC_AUDIT_RATE (1 in 1,000) is rendered again after the
    // response to audit its dependencies. That is real and random, and a counter
    // gate must not be: left alone, a hit's D1 count jumps once in ~10 full runs.
    // The draws stay random but never land in the audit's sampled range.
    const draw = Math.random.bind(Math);
    randomSpy = vi.spyOn(Math, "random").mockImplementation(() => DVC_AUDIT_RATE + draw() * (1 - DVC_AUDIT_RATE));
    store = await createFreePlanStore();
    seedCatalog(store.sqlite);
    seedOrders(store.sqlite, 1000);
    // A deployed store: its bundled apps already match this version (the
    // first tick after a deploy does this once, plugins/scheduled.ts), so the
    // idle hour measures steady state, not the one-time catch-up.
    // The first ticks after a deploy sync the bundled apps (one per tick on Free).
    while ((await syncBundledPluginsOncePerDeploy(store.db, store.env))?.pending);
    await store.ownerCookie();
  }, 120_000);

  afterAll(() => {
    const target = process.env.FREE_PLAN_BUDGET_REPORT;
    if (target && plan === PLANS[PLANS.length - 1]) writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    store?.close();
    randomSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("staff password sign-in", async () => {
    const m = await run("staff-sign-in", "Staff password sign-in", 4, async () => {
      const response = await store.worker.fetch(jsonRequest(`${STORE.dashboard}/api/auth/sign-in/email`, {
        email: STORE.ownerEmail, password: STORE.ownerPassword,
      }, { Origin: STORE.dashboard }));
      expect(response.status).toBe(200);
    });
    expectWithin(m);
  });

  it("staff password sign-up (administrator creation)", async () => {
    const { createAuth } = await import("@scalius/core/auth");
    const composed = await store.composed();
    const m = await run("staff-sign-up", "Staff sign-up (Better Auth, password hash)", 3, async (index) => {
      await createAuth(composed).api.signUpEmail({ body: { email: `staff${index}@shop.test`, password: STORE.ownerPassword, name: "Staff" } });
    });
    expectWithin(m);
  });

  it("customer OTP request and verify", async () => {
    const { deriveCustomerAuthOtpDeliveryCode } = await import("@scalius/core/modules/customers");
    const composed = await store.composed();
    const send = await run("customer-otp-request", "Customer OTP request", 4, async (index) => {
      const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/customer-auth/send-otp`, { method: "email", identifier: `buyer${index}@shop.test` }, {
        "CF-Connecting-IP": `203.0.113.${index + 1}`,
      }));
      expect(response.status, await response.clone().text()).toBe(200);
    });
    expectWithin(send);
    const verify = await run("customer-otp-verify", "Customer OTP verify (new buyer)", 4, async (index) => {
      const email = `verify${index}@shop.test`;
      const challenge = pendingChallenge.get(email)!;
      const code = await deriveCustomerAuthOtpDeliveryCode({
        otpKey: challenge.challengeKey,
        deliveryKey: challenge.deliveryKey,
        encryptionKey: (composed as unknown as Record<string, string>).CREDENTIAL_ENCRYPTION_KEY,
      });
      const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/customer-auth/verify-otp`, {
        method: "email", identifier: email, code, account: { name: "Verify Buyer", phone: `+88018${String(20000000 + index)}` },
      }, { "CF-Connecting-IP": `198.51.100.${index + 1}` }));
      expect(response.status, await response.clone().text()).toBe(200);
    }, async (index) => {
      const email = `verify${index}@shop.test`;
      const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/customer-auth/send-otp`, { method: "email", identifier: email }, {
        "CF-Connecting-IP": `198.51.100.${index + 1}`,
      }));
      expect(response.status).toBe(200);
      const challenge = store.sqlite.prepare("SELECT otp_key AS challengeKey, delivery_key AS deliveryKey FROM customer_auth_otp_challenges ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get() as { challengeKey: string; deliveryKey: string };
      pendingChallenge.set(email, { ...challenge });
    });
    expectWithin(verify);
  });

  for (const [page, parts] of Object.entries(PAGES)) {
    it(`storefront ${page} page: one batch, cache miss then hit`, async () => {
      const miss = await run(`page-${page}-miss`, `Storefront ${page} page (cache miss, all parts render)`, 4, () => renderPage(parts), async () => {
        store.meter.cache.entries.clear();
      });
      const hit = await run(`page-${page}-hit`, `Storefront ${page} page (cache hit, parts validated)`, 4, () => renderPage(parts));
      expectWithin(miss);
      expectWithin(hit);
    });
  }

  for (const lines of [20, 99]) {
    it(`checkout with ${lines} lines: tax quote and commit`, async () => {
      const quote = await run(`checkout-${lines}-quote`, `Checkout quote (${lines} lines)`, 3, async () => {
        await taxQuote(lines);
      });
      expectWithin(quote);
      const { quoteFingerprint } = await taxQuote(lines);
      const commit = await run(`checkout-${lines}-commit`, `Checkout commit (${lines} lines)`, 3, async () => {
        await placeOrder(lines, quoteFingerprint);
      });
      expectWithin(commit);
    });
  }

  it("admin order list, 50 rows", async () => {
    const first = await run("admin-order-list", "Admin order list (50 rows, page 1)", 4, async () => {
      const response = await store.admin("/api/v1/admin/orders?limit=50&page=1");
      expect(response.status).toBe(200);
      await response.text();
    });
    const deep = await run("admin-order-list-deep", "Admin order list (50 rows, page 15)", 4, async () => {
      const response = await store.admin("/api/v1/admin/orders?limit=50&page=15");
      expect(response.status).toBe(200);
      await response.text();
    });
    expectWithin(first);
    expectWithin(deep);
  });

  it("admin product save", async () => {
    const m = await run("admin-product-save", "Admin product save (update)", 4, async (index) => {
      const revision = Number((store.sqlite.prepare("SELECT aggregate_revision AS r FROM products WHERE id = 'p_cotton'").get() as { r: number }).r);
      const response = await store.admin("/api/v1/admin/products/p_cotton", {
        method: "PUT",
        body: JSON.stringify({
          id: "p_cotton",
          name: "Cotton Panjabi",
          description: "<p>Soft cotton.</p>",
          price: 1800 + index + 1,
          categoryId: "cat_panjabi",
          isActive: true,
          freeDelivery: false,
          metaTitle: null,
          metaDescription: null,
          slug: "cotton-panjabi",
          productCondition: "new",
          media: [],
          attributes: [],
          additionalInfo: [],
          expectedAggregateRevision: revision,
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
    });
    expectWithin(m);
  });

  // ── Order and stock operations: the writes a merchant makes every day ───────────

  it("order status change (pending to confirmed)", async () => {
    const { quoteFingerprint } = await taxQuote(3);
    let orderId = "";
    const m = await run("order-status-change", "Admin order status change (pending to confirmed)", 3, async () => {
      const response = await store.admin(`/api/v1/admin/orders/${orderId}/status`, { method: "PUT", body: JSON.stringify({ status: "confirmed" }) });
      expect(response.status, await response.clone().text()).toBe(200);
    }, async () => {
      orderId = await placeOrder(3, quoteFingerprint);
    });
    expectWithin(m);
  });

  it("order refund (cash collected, part refunded)", async () => {
    const { quoteFingerprint } = await taxQuote(3);
    const { recordOrderFulfilment, processCodAction } = await import("@scalius/core/modules/fulfilment");
    const { updateOrderStatus } = await import("@scalius/core/modules/orders");
    let orderId = "";
    const m = await run("order-refund", "Admin order refund (a collected cash order, partly refunded)", 3, async () => {
      const response = await store.admin(`/api/v1/admin/orders/${orderId}/refund`, {
        method: "POST",
        body: JSON.stringify({ amount: 50, reason: "Customer asked", manualSettlementConfirmed: true, requestKey: `refund_${crypto.randomUUID()}` }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }, async () => {
      orderId = await placeOrder(3, quoteFingerprint);
      await updateOrderStatus(store.db, orderId, "confirmed");
      await recordOrderFulfilment(store.db, orderId, {
        requestKey: crypto.randomUUID(), kind: "ship", lines: undefined, parcel: { courierName: "Courier", trackingId: `T${orderId}` },
      } as never, { type: "admin", id: null });
      await processCodAction(store.db, orderId, { action: "collected", collectedBy: "Rider", collectedAmount: 366 });
    });
    expectWithin(m);
  });

  it("SKU stock change (received stock)", async () => {
    const m = await run("sku-stock-change", "Admin SKU stock change (+1 received)", 4, async () => {
      const response = await store.admin("/api/v1/admin/inventory/v_cotton/adjust", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ delta: 1, reason: "received" }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
    });
    expectWithin(m);
  });

  // ── Background work: the cron's ticks ─────────────────────────────────────────

  it("cron ticks: an idle hour", async () => {
    // Steady state: today's recommendation lap is done (the first lap is a
    // one-off fill), so the rotation rests until tomorrow's lap.
    while (await rotateRecommendations(store.db) > 0);
    // The first half hour (a whole Free rotation, two Paid sweep ticks) warms the
    // cursors and first-run writes; the next hour is the steady state.
    const idle = await run("cron-idle", "Cron tick (idle store, worst minute of an hour)", 90, (index) => minuteOfHour(index), undefined, 30);
    expectWithin(idle);
  });

  it("cron ticks: the nightly pass", async () => {
    const nightly = await run("cron-nightly", "Cron tick (the nightly pass)", 1, () => cron(NIGHTLY_TIME));
    expectWithin(nightly);
  });

  it("drain ticks with due notifications and a requested projection rebuild", async () => {
    const busy = await run("drain-busy", "Cron tick (due notifications, a projection rebuild chunk)", 2, (index) => minuteOfHour(118 + index), async () => {
      store.sqlite.exec("UPDATE notification_outbox SET status = 'pending', next_attempt_at = 0, claim_id = NULL WHERE status <> 'sent'");
      store.sqlite.exec("INSERT INTO system_kv (key, value) VALUES ('catalog:projections:rebuild-cursor', '') ON CONFLICT(key) DO UPDATE SET value = ''");
    });
    expectWithin(busy);
  });

  it("an order's lifecycle: a 3-line checkout commit and everything it starts after the response (the cron is a fixed daily cost)", async () => {
    const { quoteFingerprint } = await taxQuote(3);
    const commit = await run("order-3-line-commit", "Checkout commit (3 lines), its notification and events after the response", 2, async () => {
      await placeOrder(3, quoteFingerprint);
    });
    expectWithin(commit);
    // One invocation now: the commit and its after-response work.
    measurements.push({ ...commit, id: "order-lifecycle", label: "One 3-line order: checkout commit + its after-response work" });
    expectWithin({ ...commit, id: "order-lifecycle" });
  });
  // ── Bulk runs, server tracking and hosted payments ─────────────────────────────

  it("bulk run chunk: 90 products drafted, then made active again", async () => {
    const { advanceBulkRun, createBulkRun } = await import("./bulk-runs/engine");
    // The engine called directly on the metered binding (the cron drain's chunk).
    const metered = getDb(store.env);
    const products = Array.from({ length: 90 }, (_, index) => ({ id: `p_bulk_${index + 1}` }));
    const runs: string[] = [];
    const m = await run("bulk-run-chunk", "Bulk run chunk (90 products' status, coarse cache clock)", 2, async () => {
      const row = await advanceBulkRun(metered, runs.at(-1)!, 1);
      expect(row).toMatchObject({ processed: 90, changed: 90 });
    }, async (index) => {
      const { row } = await createBulkRun(store.db, {
        kind: "products.set_status",
        input: { products, status: index === 0 ? "draft" : "active" },
      }, { operationKey: `budget-bulk-${plan}-${index}`, createdBy: null, lease: false });
      runs.push(row.id);
    });
    // Each run's empty last page, unmetered: both runs finish.
    for (const id of runs) await advanceBulkRun(store.db, id, 1);
    expectWithin(m);
  });

  it("an order with Meta, GA4 and TikTok server tracking on, then its hosted payment confirmed", async () => {
    const { metaConversionsDocument } = await import("@scalius/core/modules/settings");
    const { ga4MeasurementDocument, tiktokEventsDocument } = await import("@scalius/core/integrations/tracking/settings");
    const { claimAndApplyPaymentEvent } = await import("./routes/payment/payment-events");
    const encryptionKey = store.env.CREDENTIAL_ENCRYPTION_KEY as string;
    const enable = async (isEnabled: boolean) => {
      await metaConversionsDocument.write(store.db, { pixelId: "1234567890123", accessToken: "EAAB-live-token-value", isEnabled }, { encryptionKey });
      await ga4MeasurementDocument.write(store.db, { isEnabled, measurementId: "G-BUDGET1234", apiSecret: "mp-secret-value-01", debugMode: false }, { encryptionKey });
      await tiktokEventsDocument.write(store.db, { isEnabled, pixelCode: "C4ABCDEF0123456789", accessToken: "tiktok-live-token-01", testEventCode: "" }, { encryptionKey });
    };
    await enable(true);
    try {
      const { quoteFingerprint } = await taxQuote(3);
      const orders: string[] = [];
      const commit = await run("order-3-line-commit-tracking", "Checkout commit (3 lines) with Meta, GA4 and TikTok deliveries after the response", 2, async () => {
        orders.push(await placeOrder(3, quoteFingerprint));
      });
      expectWithin(commit);

      // A hosted payment's confirmation: the order is a card order whose
      // purchase deliveries were held for the payment (as a hosted checkout
      // leaves them), and they go out now.
      const metered = getDb(store.env);
      let orderId = "";
      let event = 0;
      const confirmed = await run("payment-webhook-confirmed", "Hosted payment confirmed (webhook claim, payment, notification, Meta/GA4/TikTok purchases)", 2, async () => {
        const { total } = store.sqlite.prepare("SELECT total_amount_minor AS total FROM orders WHERE id = ?").get(orderId) as { total: number };
        event += 1;
        const result = await claimAndApplyPaymentEvent({
          db: metered,
          caller: { env: store.env, executionCtx: store.meter.ctx },
          provider: "stripe",
          event: {
            kind: "confirmed", orderId, providerRef: `pi_budget_${plan}_${event}`, amountMinor: total, currency: "BDT",
            eventType: "payment_intent.succeeded", eventId: `evt_budget_${plan}_${event}`,
          },
          source: "webhook",
        });
        expect(result).toEqual({ status: "accepted" });
      }, async (index) => {
        orderId = orders[index]!;
        store.sqlite.prepare("UPDATE orders SET payment_method = 'stripe' WHERE id = ?").run(orderId);
        store.sqlite.prepare("UPDATE meta_capi_purchase_outbox SET status = 'pending', sent_at = NULL, next_attempt_at = unixepoch() + 3600 WHERE order_id = ?").run(orderId);
        store.sqlite.prepare("UPDATE tracking_deliveries SET status = 'pending', sent_at = NULL, next_attempt_at = unixepoch() + 3600 WHERE order_id = ?").run(orderId);
      });
      expectWithin(confirmed);
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE payment_method = 'stripe' AND status = 'succeeded'").get()).toEqual({ n: 2 });
    } finally {
      await enable(false);
    }
  });
});
