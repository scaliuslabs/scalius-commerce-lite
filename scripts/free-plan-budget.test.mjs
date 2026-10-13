import { describe, expect, it } from "vitest";
import {
  FREE_DAILY_QUOTAS,
  QUOTA_MODEL,
  budgetsSource,
  dailyQuota,
  parseArgs,
  renderCounterTable,
  renderQuotaTable,
  renderWorkerdTable,
} from "./free-plan-budget.mjs";

const counters = (overrides = {}) => ({
  cpuMs: 1, wallMs: 1, d1Calls: 0, d1Statements: 0, d1RowsChanged: 0,
  r2Ops: 0, cacheOps: 0, serviceCalls: 0, queueCalls: 0, queueMessages: 0, queueTypes: {}, externalFetches: 0, waitUntilTasks: 0,
  ...overrides,
});
const row = (id, overrides = {}, mean = undefined) => ({
  id, label: id, runs: 2, cold: counters(), warmCpuMs: 1, counters: counters(overrides), ...(mean ? { mean: counters(mean) } : {}),
});

function report(order = {}, cron = {}) {
  return [
    row("order-lifecycle", { queueMessages: 1, d1RowsChanged: 100, ...order }),
    row("checkout-20-quote", { d1Calls: 1 }),
    row("customer-otp-request", { queueMessages: 1 }),
    row("queue-auth.send_otp", { d1Calls: 1 }),
    row("customer-otp-verify", { d1RowsChanged: 60 }),
    row("page-product-hit", { d1Calls: 1 }),
    row("page-product-miss", { d1Calls: 2 }),
    // The worst run has a first-run write; the steady state has none.
    row("cron-idle", { queueMessages: 1, d1RowsChanged: 200 }, { queueMessages: 0, d1RowsChanged: 0, ...cron }),
  ];
}

describe("the daily quota model", () => {
  it("adds the measured per-order costs and the fixed cron cost, in Workers Free's units", () => {
    const quota = dailyQuota(report(), { orders: 100 });
    expect(quota.resources.queueOperations.limit).toBe(FREE_DAILY_QUOTAS.queueOperations);
    // Queue: the order's message plus half a sign-in's request, three operations per message.
    expect(quota.resources.queueOperations.perOrder).toBeCloseTo((1 + QUOTA_MODEL.otpShare) * 3);
    // D1 rows written: rows changed (order 100 + half a verify's 60) times the index factor.
    expect(quota.resources.d1RowsWritten.perOrder).toBeCloseTo((100 + 30) * QUOTA_MODEL.indexWriteFactor);
  });

  it("uses the steady-state mean of the cron, not its worst (first) run", () => {
    const quota = dailyQuota(report(), { orders: 10 });
    expect(quota.cron.queueMessages).toBe(0);
    expect(quota.cron.d1RowsChanged).toBe(0);
  });

  it("reports how many orders a day one resource alone supports, with the fixed cost taken off", () => {
    const quota = dailyQuota(report({ queueMessages: 2 }, { queueMessages: 1 }), { orders: 100 });
    const perOrder = (2 + QUOTA_MODEL.otpShare) * 3;
    const fixed = 3 * QUOTA_MODEL.cronRunsPerDay;
    expect(quota.resources.queueOperations.ordersToLimit).toBe(Math.floor((FREE_DAILY_QUOTAS.queueOperations - fixed) / perOrder));
  });

  it("refuses a report that lacks an operation of the model", () => {
    expect(() => dailyQuota(report().filter((candidate) => candidate.id !== "order-lifecycle"))).toThrow(/order-lifecycle/);
  });
});

describe("rendering", () => {
  it("prints every operation and every quota", () => {
    const table = renderCounterTable("free", report());
    expect(table).toContain("Plan profile: free");
    expect(table).toContain("order-lifecycle");
    const quota = renderQuotaTable("free", dailyQuota(report()));
    for (const label of ["Queue operations", "D1 rows written"]) expect(quota).toContain(label);
    expect(quota).toContain("Model: per order");
  });

  it("writes the budgets file source from a report: every deterministic counter of every operation", () => {
    const source = budgetsSource({ free: report(), paid: report({ queueMessages: 2 }) });
    expect(source).toContain("export const BUDGETS: Record<WorkersPlan, Record<string, Budget>>");
    expect(source).toContain('"order-lifecycle": { d1Calls: 0, d1Statements: 0, queueMessages: 1, externalFetches: 0 }');
    expect(source.match(/"cron-idle"/g)).toHaveLength(2);
  });

  it("prints the workerd tier's CPU and password hashing", () => {
    const timing = (cpuMs, d1Calls = 1) => ({ kind: "fetch", cpuMs, wallMs: cpuMs, waitMs: 0, d1Calls });
    const text = renderWorkerdTable({
      rows: [{ id: "workerd-sign-in", label: "x", cold: timing(120), warm: [timing(9), timing(8), timing(10)] }],
      passwords: [{ spec: 'free: {"algorithm":"pbkdf2-sha256","iterations":30000}', hash: { min: 2, median: 3, max: 6 }, verify: { min: 2, median: 3, max: 7 } }],
    });
    expect(text).toContain("workerd-sign-in");
    expect(text).toContain("120");
    expect(text).toContain("pbkdf2-sha256");
    expect(text).toContain("min/median/max 2 / 3 / 6 ms");
  });
});

describe("arguments", () => {
  it("parses the flags and rejects the unknown", () => {
    expect(parseArgs([])).toEqual({ workerd: false, record: false, json: null, orders: 100 });
    expect(parseArgs(["--workerd", "--record", "--json", "out.json", "--orders", "250"])).toEqual({ workerd: true, record: true, json: "out.json", orders: 250 });
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--orders", "0"])).toThrow(/positive/);
  });
});
