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
  queueOperations,
  type FreePlanCounters,
} from "./testing/free-plan-meter";
import { DVC_AUDIT_RATE } from "./public-read";
import { STORE, createFreePlanStore, type FreePlanStore } from "./testing/free-plan-store";
import { cartItems, seedCatalog, seedMediaBacklog, seedOrders } from "./testing/free-plan-seed";
import { BUDGETS, type Budget } from "./testing/free-plan-budgets";

/**
 * The Workers plan budget of the operations a store depends on, measured through
 * the real Worker entrypoints under BOTH plan profiles (scripts/free-plan-budget.mjs
 * prints the table; docs/FREE-PLAN.md explains the limits). The gate asserts what
 * is deterministic: D1 round trips and statements, KV reads and writes, queue
 * messages and external subrequests, against `testing/free-plan-budgets.ts` and
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
      if (key === "queueTypes") continue;
      (out[key] as number) = Math.max(out[key] as number, counters[key] as number);
    }
    out.queueTypes = counters.queueTypes;
  }
  return out;
}

function mean(results: FreePlanCounters[]): FreePlanCounters {
  const out = emptyCounters();
  for (const counters of results) {
    for (const key of Object.keys(out) as Array<keyof FreePlanCounters>) {
      if (key === "queueTypes") continue;
      (out[key] as number) += (counters[key] as number) / results.length;
    }
  }
  return out;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const PAGES = {
  home: ["/api/v1/storefront/layout", "/api/v1/storefront/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  product: ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi", "/api/v1/shipping-methods", "/api/v1/checkout/config", "/api/v1/storefront/product-apps/linen-panjabi"],
  category: ["/api/v1/storefront/layout", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest"],
  search: ["/api/v1/storefront/layout", "/api/v1/products?page=1&limit=20&sort=relevance&search=linen"],
} as const;

describe.each(PLANS)("Workers %s plan budget", (plan) => {
  const limits = PLAN_LIMITS[plan];
  const measurements = report[plan]!;
  let store: FreePlanStore;
  let orderCounter = 0;
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
  function expectWithin(measurement: Measurement, { invocation = true } = {}): void {
    const { counters } = measurement;
    if (process.env.FREE_PLAN_BUDGET_RECORD === "1") return;
    const budget: Budget | undefined = BUDGETS[plan][measurement.id];
    expect(budget, `${measurement.id} has a recorded budget on the ${plan} profile (testing/free-plan-budgets.ts)`).toBeDefined();
    const actual: Budget = {
      d1Calls: counters.d1Calls,
      d1Statements: counters.d1Statements,
      queueMessages: counters.queueMessages,
      externalFetches: counters.externalFetches,
    };
    for (const [key, max] of Object.entries(budget ?? {}) as Array<[keyof Budget, number]>) {
      expect(actual[key], `${plan} ${measurement.id} ${key}`).toBeLessThanOrEqual(max);
    }
    if (!invocation) return;
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

  async function taxQuote(lines: number): Promise<{ quoteFingerprint: string }> {
    const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/orders/tax-quote`, {
      items: cartItems(lines).map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
      city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [],
    }));
    const body = await response.json() as { data: { quoteFingerprint: string } };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.data;
  }

  async function placeOrder(lines: number, quote: string): Promise<string> {
    orderCounter += 1;
    const response = await store.worker.fetch(jsonRequest(`${STORE.api}/api/v1/orders`, {
      checkoutRequestId: `budget_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: quote,
      customerName: "Budget Buyer",
      customerPhone: `+88017${String(10000000 + orderCounter)}`,
      customerEmail: "buyer@shop.test",
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1",
      zone: "zone_1",
      notes: null,
      items: cartItems(lines),
      discountCodes: [],
      shippingCharge: 60,
      shippingMethodId: "m_std",
      paymentMethod: "cod",
    }));
    const body = await response.json() as { data: { orderId: string } };
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body.data.orderId;
  }

  const CRON_TIME = Date.parse("2026-10-03T10:15:00Z");
  const NIGHTLY_TIME = Date.parse("2026-10-03T20:00:00Z");
  /** Tick `n` of an hour that starts on a slice boundary: the four ticks together run every Free slice. */
  const cron = (scheduledTime: number) =>
    store.worker.scheduled({ cron: "*/15 * * * *", scheduledTime, noRetry: () => undefined } as unknown as ScheduledController);
  const hour = Math.floor(CRON_TIME / (4 * 900_000)) * 4 * 900_000;

  function withImages<T>(work: () => Promise<T>): Promise<T> {
    const previous = store.worker.env;
    store.worker.env = { ...previous, IMAGES: store.meter.service({ info: async () => ({}), input: () => ({}) }) } as unknown as Env;
    return work().finally(() => { store.worker.env = previous; });
  }

  function queueBatch(bodies: unknown[], queue = "jobs") {
    const outcome = { acked: 0, retried: 0 };
    const messages = bodies.map((body, index) => ({
      id: `msg_${index}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => { outcome.acked += 1; },
      retry: () => { outcome.retried += 1; },
    }));
    return { batch: { queue, messages, ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<Record<string, unknown>>, outcome };
  }

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
      pendingChallenge.set(email, store.meter.queue.sent[store.meter.queue.sent.length - 1]!.body as { challengeKey: string; deliveryKey: string });
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

  // ── Background work: the cron, then every queue job type ────────────────────

  it("cron maintenance: every slice of the rotation idle, a busy store with a 1,200-image rendition backlog, and the nightly tick", async () => {
    // Four consecutive ticks: on Free each runs another slice, on Paid each runs everything.
    const idle = await run("cron-idle", "Cron maintenance run (idle store, worst tick of the rotation)", 8, (index) => cron(hour + index * 900_000), undefined, 4);
    expectWithin(idle);
    seedMediaBacklog(store.sqlite, 1200);
    const busy = await run("cron-busy", "Cron maintenance run (1,200 images missing renditions, worst tick)", 4, (index) => withImages(() => cron(hour + 4 * 900_000 + index * 900_000)));
    expectWithin(busy);
    const nightly = await run("cron-nightly", "Cron maintenance run (nightly catalogue tick)", 2, () => cron(NIGHTLY_TIME));
    expectWithin(nightly);
  });

  it("queue consumer: one batch per job type, at this plan's batch size", async () => {
    const byType = new Map<string, unknown[]>();
    for (const { body } of store.meter.queue.sent) {
      const type = String((body as { type?: unknown }).type);
      byType.set(type, [...(byType.get(type) ?? []), body]);
    }
    const produced = Object.fromEntries([...byType].map(([type, bodies]) => [type, bodies.length]));
    console.log(`[budget:${plan}] produced queue messages by type:`, JSON.stringify(produced));
    expect(byType.has("auth.send_otp")).toBe(true);
    for (const [type, bodies] of byType) {
      const size = Math.min(limits.queue.consumerBatchSize, bodies.length);
      let outcome = { acked: 0, retried: 0 };
      const m = await run(`queue-${type}`, `Queue batch: ${type} (${size} message${size === 1 ? "" : "s"})`, 2, async (index) => {
        const sample = bodies.slice((index * size) % bodies.length).concat(bodies).slice(0, size);
        const { batch, outcome: result } = queueBatch(sample);
        outcome = result;
        await store.worker.queue(batch);
      });
      expect(outcome.acked + outcome.retried, `${type} messages are all settled`).toBe(size);
      expectWithin(m);
    }
  });

  it("an order's lifecycle: a 3-line checkout commit and every message it produced (the cron is a fixed daily cost)", async () => {
    store.meter.queue.sent.length = 0;
    const { quoteFingerprint } = await taxQuote(3);
    const total = emptyCounters();
    const add = (counters: FreePlanCounters) => {
      for (const key of Object.keys(total) as Array<keyof FreePlanCounters>) {
        if (key === "queueTypes") continue;
        (total[key] as number) += counters[key] as number;
      }
    };
    const commit = await run("order-3-line-commit", "Checkout commit (3 lines)", 2, async () => {
      store.meter.queue.sent.length = 0;
      await placeOrder(3, quoteFingerprint);
    });
    expectWithin(commit);
    add(commit.counters);
    // Every message the commit queued is consumed, one batch at a time at this plan's batch size.
    let consumed = 0;
    for (let round = 0; round < 6; round += 1) {
      const pending = store.meter.queue.sent.slice(consumed).map(({ body }) => body);
      if (pending.length === 0) break;
      consumed = store.meter.queue.sent.length;
      for (let start = 0; start < pending.length; start += limits.queue.consumerBatchSize) {
        const { batch } = queueBatch(pending.slice(start, start + limits.queue.consumerBatchSize));
        add((await store.meter.measure(() => store.worker.queue(batch))).counters);
      }
    }
    const measurement: Measurement = {
      id: "order-lifecycle",
      label: "One 3-line order: checkout commit + consuming every message it queued",
      runs: 1,
      cold: total,
      warmCpuMs: total.cpuMs,
      mean: total,
      counters: {
        ...total,
        queueMessages: store.meter.queue.sent.length,
        queueTypes: store.meter.queue.sent.reduce<Record<string, number>>((types, { body }) => {
          const type = String((body as { type?: unknown }).type);
          types[type] = (types[type] ?? 0) + 1;
          return types;
        }, {}),
      },
    };
    measurements.push(measurement);
    expect(queueOperations(measurement.counters), "queue operations of one order").toBe(store.meter.queue.sent.length * 3);
    // Summed over several invocations: the per-invocation ceilings do not apply.
    expectWithin(measurement, { invocation: false });
  });
});
