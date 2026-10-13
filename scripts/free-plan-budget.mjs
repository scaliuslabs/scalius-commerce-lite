#!/usr/bin/env node
// The Workers plan budget harness: what each operation costs in D1 queries,
// queue messages and CPU, under the Free and the Paid profile, and
// what a day of orders consumes of Workers Free's quotas.
//
//   pnpm free-plan:budget                 run the Node tier (both profiles), print the tables
//   pnpm free-plan:budget --workerd       also run the workerd tier (real CPU, Miniflare)
//   pnpm free-plan:budget --record        measure only (no budget assertions) and print the
//                                         budgets file source (apps/api/src/testing/free-plan-budgets.ts)
//   pnpm free-plan:budget --json out.json keep the raw report
//   pnpm free-plan:budget --orders 250    orders per day for the quota table (default 100)
//
// The Node tier (apps/api/src/free-plan-budget.test.ts) drives the real Worker
// entrypoints over an in-memory D1 and counts every binding call; it is also a
// test: it fails when an operation exceeds its recorded budget or Free's
// per-invocation limits. The workerd tier (free-plan-workerd.test.ts) runs the
// bundled Worker in workerd and is the only place CPU is real. docs/FREE-PLAN.md
// explains the limits and the measurements.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

/** Workers Free daily quotas (developers.cloudflare.com, checked 2026-10-03). */
export const FREE_DAILY_QUOTAS = Object.freeze({
  queueOperations: 10_000,
  d1RowsWritten: 100_000,
  d1RowsRead: 5_000_000,
  requests: 100_000,
});

/**
 * What a day of orders is made of. Each order is a 3-line checkout commit with
 * every message it queues consumed, two tax quotes, a share of buyers who sign
 * in with a code, and page views; the cron runs 96 times regardless of orders.
 */
export const QUOTA_MODEL = Object.freeze({
  orders: 100,
  quotesPerOrder: 2,
  /** Share of orders whose buyer signs in with an emailed code (request, delivery, verify). */
  otpShare: 0.5,
  pageViewsPerOrder: 20,
  /** Share of page views that miss the storefront's cache and render every part. */
  pageMissShare: 0.05,
  cronRunsPerDay: 96,
  /** D1 "rows written" counts index entries too: rows changed (what SQLite reports) times this is the estimate. */
  indexWriteFactor: 3,
});

export function parseArgs(argv) {
  const options = { workerd: false, record: false, json: null, orders: QUOTA_MODEL.orders };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workerd") options.workerd = true;
    else if (arg === "--record") options.record = true;
    else if (arg === "--json") options.json = argv[(index += 1)] ?? null;
    else if (arg === "--orders") options.orders = Number(argv[(index += 1)]);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isFinite(options.orders) || options.orders <= 0) throw new Error("--orders must be a positive number");
  return options;
}

/** The steady-state counters of an operation (the mean over its warm runs), else its worst run. */
const find = (rows, id) => {
  const row = rows.find((candidate) => candidate.id === id);
  return row?.mean ?? row?.counters;
};

function scale(counters, factor) {
  const out = {};
  for (const [key, value] of Object.entries(counters ?? {})) out[key] = typeof value === "number" ? value * factor : value;
  return out;
}

function sum(...all) {
  const out = {};
  for (const counters of all) {
    for (const [key, value] of Object.entries(counters ?? {})) {
      if (typeof value === "number") out[key] = (out[key] ?? 0) + value;
    }
  }
  return out;
}

/**
 * The daily consumption of `orders` orders on top of the fixed cron cost, from
 * one plan's measured rows, against Workers Free's quotas. Per-order costs are
 * the measured counters; the shares are `QUOTA_MODEL`.
 */
export function dailyQuota(rows, options = {}) {
  const model = { ...QUOTA_MODEL, ...options };
  const need = (id) => {
    const counters = find(rows, id);
    if (!counters) throw new Error(`The report has no ${id}`);
    return counters;
  };
  const order = need("order-lifecycle");
  const quote = need("checkout-20-quote");
  const otp = sum(need("customer-otp-request"), need("queue-auth.send_otp"), need("customer-otp-verify"));
  const hit = need("page-product-hit");
  const miss = need("page-product-miss");
  const views = sum(scale(hit, 1 - model.pageMissShare), scale(miss, model.pageMissShare));
  const perOrder = sum(order, scale(quote, model.quotesPerOrder), scale(otp, model.otpShare), scale(views, model.pageViewsPerOrder));
  const cron = scale(need("cron-idle"), model.cronRunsPerDay);
  const daily = sum(scale(perOrder, model.orders), cron);
  const queueOperations = (daily.queueMessages ?? 0) * 3;
  const resources = {
    queueOperations: { used: queueOperations, perOrder: (perOrder.queueMessages ?? 0) * 3, limit: FREE_DAILY_QUOTAS.queueOperations },
    d1RowsWritten: {
      used: (daily.d1RowsChanged ?? 0) * model.indexWriteFactor,
      perOrder: (perOrder.d1RowsChanged ?? 0) * model.indexWriteFactor,
      limit: FREE_DAILY_QUOTAS.d1RowsWritten,
    },
  };
  for (const entry of Object.values(resources)) {
    entry.percent = (entry.used / entry.limit) * 100;
    // Orders per day at which this resource alone is spent (the fixed cron cost taken off).
    const fixed = entry.used - entry.perOrder * model.orders;
    entry.ordersToLimit = entry.perOrder > 0 ? Math.max(0, Math.floor((entry.limit - Math.max(0, fixed)) / entry.perOrder)) : Infinity;
  }
  return { model, resources, perOrder, cron };
}

const pad = (value, width) => String(value).padStart(width);
const number = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "-");

export function renderCounterTable(plan, rows) {
  const lines = [
    `Plan profile: ${plan}`,
    `${"operation".padEnd(34)} ${pad("cpu cold", 8)} ${pad("cpu warm", 8)} ${pad("D1 calls", 8)} ${pad("D1 stmts", 8)} ${pad("rows chg", 8)} ${pad("queue msgs", 10)} ${pad("fetch", 5)}`,
  ];
  for (const row of rows) {
    const c = row.counters;
    lines.push(
      `${row.id.padEnd(34)} ${pad(number(row.cold.cpuMs, 1), 8)} ${pad(number(row.warmCpuMs, 1), 8)} ${pad(c.d1Calls, 8)} ${pad(c.d1Statements, 8)} ${pad(c.d1RowsChanged, 8)} ${pad(c.queueMessages, 10)} ${pad(c.externalFetches, 5)}`,
    );
  }
  return lines.join("\n");
}

export function renderQuotaTable(plan, quota) {
  const { model, resources } = quota;
  const labels = {
    queueOperations: "Queue operations",
    d1RowsWritten: "D1 rows written (est.)",
  };
  const lines = [
    `Daily quota use, ${model.orders} orders/day, plan profile ${plan} (Workers Free limits)`,
    `${"resource".padEnd(24)} ${pad("per order", 10)} ${pad("per day", 10)} ${pad("Free limit", 11)} ${pad("used", 7)} ${pad("orders/day to limit", 20)}`,
  ];
  for (const [key, entry] of Object.entries(resources)) {
    lines.push(
      `${labels[key].padEnd(24)} ${pad(number(entry.perOrder, 1), 10)} ${pad(number(entry.used), 10)} ${pad(entry.limit, 11)} ${pad(`${number(entry.percent, 1)}%`, 7)} ${pad(Number.isFinite(entry.ordersToLimit) ? entry.ordersToLimit : "no limit", 20)}`,
    );
  }
  lines.push(
    `Model: per order a 3-line checkout and its queued messages, ${model.quotesPerOrder} tax quotes, ${model.otpShare * 100}% sign-ins by code, ${model.pageViewsPerOrder} page views (${model.pageMissShare * 100}% cache misses); ${model.cronRunsPerDay} cron runs a day; D1 rows written = rows changed x ${model.indexWriteFactor} for index entries.`,
  );
  return lines.join("\n");
}

/** Source of apps/api/src/testing/free-plan-budgets.ts from a report: each operation's measured counters. */
export function budgetsSource(report) {
  const keys = ["d1Calls", "d1Statements", "queueMessages", "externalFetches"];
  const block = (rows) => rows
    .map((row) => `    ${JSON.stringify(row.id)}: { ${keys.map((key) => `${key}: ${row.counters[key]}`).join(", ")} },`)
    .join("\n");
  return `export const BUDGETS: Record<WorkersPlan, Record<string, Budget>> = {\n  free: {\n${block(report.free)}\n  },\n  paid: {\n${block(report.paid)}\n  },\n};\n`;
}

export function renderWorkerdTable(report) {
  const median = (timings) => {
    const sorted = timings.map((timing) => timing.cpuMs).sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
  };
  const lines = [
    `Real CPU in workerd (Miniflare), plan profile ${report.plan ?? "free"}, milliseconds: wall time minus time waiting on the D1 proxy`,
    `${"operation".padEnd(34)} ${pad("cold", 7)} ${pad("warm med", 9)} ${pad("warm min", 9)} ${pad("D1 calls", 9)}`,
  ];
  for (const row of report.rows) {
    const calls = row.warm.length > 0 ? row.warm[row.warm.length - 1].d1Calls : row.cold.d1Calls;
    lines.push(`${row.id.padEnd(34)} ${pad(number(row.cold.cpuMs, 0), 7)} ${pad(number(median(row.warm), 0), 9)} ${pad(number(row.warm.length ? Math.min(...row.warm.map((timing) => timing.cpuMs)) : 0, 0), 9)} ${pad(calls, 9)}`);
  }
  lines.push("", "Password hashing in workerd (15 runs after a warm-up):");
  for (const password of report.passwords) {
    lines.push(`  ${password.spec}`);
    lines.push(`    hash   min/median/max ${number(password.hash.min, 0)} / ${number(password.hash.median, 0)} / ${number(password.hash.max, 0)} ms`);
    lines.push(`    verify min/median/max ${number(password.verify.min, 0)} / ${number(password.verify.median, 0)} / ${number(password.verify.max, 0)} ms`);
  }
  return lines.join("\n");
}

function vitest(file, env) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", file, "--testTimeout=300000", "--hookTimeout=300000"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return result.status ?? 1;
}

function main(argv) {
  const options = parseArgs(argv);
  const scratch = mkdtempSync(join(tmpdir(), "scalius-free-plan-"));
  let status;
  try {
    const reportPath = join(scratch, "report.json");
    status = vitest("apps/api/src/free-plan-budget.test.ts", {
      FREE_PLAN_BUDGET_REPORT: reportPath,
      ...(options.record ? { FREE_PLAN_BUDGET_RECORD: "1" } : {}),
    });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    for (const plan of ["free", "paid"]) {
      console.log(`\n${renderCounterTable(plan, report[plan])}`);
      console.log(`\n${renderQuotaTable(plan, dailyQuota(report[plan], { orders: options.orders }))}`);
    }
    if (options.record) console.log(`\n${budgetsSource(report)}`);
    if (options.workerd) {
      for (const plan of ["free", "paid"]) {
        const workerdPath = join(scratch, `workerd-${plan}.json`);
        const workerdStatus = vitest("apps/api/src/free-plan-workerd.test.ts", {
          FREE_PLAN_WORKERD: "1",
          FREE_PLAN_WORKERD_PLAN: plan,
          FREE_PLAN_WORKERD_REPORT: workerdPath,
        });
        status ||= workerdStatus;
        console.log(`\n${renderWorkerdTable(JSON.parse(readFileSync(workerdPath, "utf8")))}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
