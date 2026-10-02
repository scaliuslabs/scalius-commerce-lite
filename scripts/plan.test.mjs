import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "../packages/shared/src/plan-limits.ts";
import { stripJsonc } from "./check-worker-env.mjs";
import { apiWranglerConfig } from "./plugins.mjs";
import {
  collectCommittedPlanViolations,
  parsePlan,
  planFromArgs,
  resolvePlan,
  withPlanProfile,
  withStorefrontPlanProfile,
} from "./plan.mjs";

const root = resolve(import.meta.dirname, "..");
const committed = (path) => JSON.parse(stripJsonc(readFileSync(resolve(root, path), "utf8")));

describe("which plan a deploy targets", () => {
  it("is Free unless the deploy says otherwise", () => {
    expect(resolvePlan({ args: [], env: {} })).toBe("free");
    expect(resolvePlan({ args: ["--only", "api"], env: {} })).toBe("free");
  });

  it("takes the flag, then SCALIUS_PLAN", () => {
    expect(resolvePlan({ args: ["--plan", "paid"], env: {} })).toBe("paid");
    expect(resolvePlan({ args: ["--plan=paid"], env: {} })).toBe("paid");
    expect(resolvePlan({ args: [], env: { SCALIUS_PLAN: "paid" } })).toBe("paid");
    expect(resolvePlan({ args: ["--plan", "free"], env: { SCALIUS_PLAN: "paid" } })).toBe("free");
    expect(resolvePlan({ args: [], env: { SCALIUS_PLAN: "" } })).toBe("free");
  });

  it("treats the plugin sandbox, which needs Workers Paid, as Paid, and refuses an explicit Free", () => {
    expect(resolvePlan({ args: [], env: {}, sandbox: true })).toBe("paid");
    expect(() => resolvePlan({ args: ["--plan", "free"], env: {}, sandbox: true })).toThrow(/Workers Paid/);
    expect(() => resolvePlan({ args: [], env: { SCALIUS_PLAN: "free" }, sandbox: true })).toThrow(/Workers Paid/);
  });

  it("rejects anything but free or paid, so a typo never selects a plan", () => {
    expect(() => parsePlan("Paid ", "--plan")).not.toThrow();
    expect(() => resolvePlan({ args: ["--plan", "enterprise"], env: {} })).toThrow(/free, paid/);
    expect(() => resolvePlan({ args: ["--plan"], env: {} })).toThrow(/free, paid/);
    expect(() => resolvePlan({ args: [], env: { SCALIUS_PLAN: "pro" } })).toThrow(/SCALIUS_PLAN/);
    expect(planFromArgs(["--only", "api"])).toBeNull();
  });
});

describe("the committed configs are the Free config", () => {
  const configs = ["apps/api/wrangler.jsonc", "apps/api/wrangler.local.jsonc", "apps/storefront/wrangler.jsonc"];

  it.each(configs)("%s has no limits, no plan constant, and Free queue batch sizes", (path) => {
    expect(collectCommittedPlanViolations(path, committed(path))).toEqual([]);
    expect(committed(path).limits).toBeUndefined();
    expect(committed(path).define).toBeUndefined();
  });

  it("the API queue consumers match the Free profile", () => {
    const [jobs, dlq] = committed("apps/api/wrangler.jsonc").queues.consumers;
    expect(jobs.max_batch_size).toBe(PLAN_LIMITS.free.queue.consumerBatchSize);
    expect(dlq.max_batch_size).toBe(PLAN_LIMITS.free.queue.dlqBatchSize);
  });

  it("flags a committed limits block, plan constant or drifted batch size", () => {
    const problems = collectCommittedPlanViolations("w.jsonc", {
      limits: { cpu_ms: 30000 },
      define: { __SCALIUS_PLAN__: "\"paid\"" },
      queues: { consumers: [{ queue: "jobs", max_batch_size: 10 }, { queue: "jobs-dlq", max_batch_size: 1 }] },
    });
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/limits/);
    expect(problems.join("\n")).toMatch(/__SCALIUS_PLAN__/);
    expect(problems.join("\n")).toMatch(/max_batch_size 10 for jobs/);
  });
});

describe("a Paid deploy's generated config", () => {
  const base = committed("apps/api/wrangler.jsonc");

  it("leaves a Free deploy alone", () => {
    expect(withPlanProfile(base, "free")).toBe(base);
    expect(withStorefrontPlanProfile(committed("apps/storefront/wrangler.jsonc"), "free")).toEqual(committed("apps/storefront/wrangler.jsonc"));
  });

  it("adds exactly the profile: 30 s CPU, the plan constant, the larger consumer batches", () => {
    const paid = withPlanProfile(base, "paid");
    expect(paid.limits).toEqual({ cpu_ms: 30_000 });
    expect(paid.define).toEqual({ __SCALIUS_PLAN__: "\"paid\"" });
    const [jobs, dlq] = paid.queues.consumers;
    expect(jobs).toMatchObject({ queue: "jobs", max_batch_size: PLAN_LIMITS.paid.queue.consumerBatchSize, max_retries: 5, dead_letter_queue: "jobs-dlq" });
    expect(dlq).toMatchObject({ queue: "jobs-dlq", max_batch_size: PLAN_LIMITS.paid.queue.dlqBatchSize });
    // Nothing else moved: bindings, routes, assets, crons.
    const { limits: _limits, define: _define, queues: _queues, ...rest } = paid;
    const { queues: _baseQueues, ...baseRest } = base;
    expect(rest).toEqual(baseRest);
    expect(paid.queues.producers).toEqual(base.queues.producers);
  });

  it("never weakens what the config said before the profile existed", () => {
    // Before the profile: limits.cpu_ms 30000 and consumer batches of 10.
    const paid = withPlanProfile(base, "paid");
    expect(paid.limits.cpu_ms).toBeGreaterThanOrEqual(30_000);
    expect(paid.queues.consumers[0].max_batch_size).toBeGreaterThanOrEqual(10);
    expect(paid.queues.consumers[1].max_batch_size).toBeGreaterThanOrEqual(10);
  });

  it("gives the Storefront build's generated config the same CPU limit", () => {
    const built = { name: "scalius-storefront", main: "entry.mjs" };
    expect(withStorefrontPlanProfile(built, "paid")).toEqual({ ...built, limits: { cpu_ms: 30_000 } });
  });

  it("does not mutate the committed config it started from", () => {
    const before = JSON.stringify(base);
    withPlanProfile(base, "paid");
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("the API config a deploy uses", () => {
  const generated = resolve(root, "apps/api/wrangler.deploy.gen.json");

  beforeEach(() => rmSync(generated, { force: true }));
  afterEach(() => rmSync(generated, { force: true }));

  it("is the committed config on Free: nothing is generated", () => {
    expect(apiWranglerConfig({ plan: "free" })).toBe(resolve(root, "apps/api/wrangler.jsonc"));
    expect(existsSync(generated)).toBe(false);
  });

  it("is a generated Paid config beside it, with the profile, the loader on request, and the committed bindings", () => {
    const path = apiWranglerConfig({ plan: "paid" });
    expect(path).toBe(generated);
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.limits).toEqual({ cpu_ms: 30_000 });
    expect(config.define).toEqual({ __SCALIUS_PLAN__: "\"paid\"" });
    expect(config.worker_loaders).toBeUndefined();
    expect(config.d1_databases).toEqual(committed("apps/api/wrangler.jsonc").d1_databases);
    expect(config.queues.consumers[0].max_batch_size).toBe(PLAN_LIMITS.paid.queue.consumerBatchSize);

    const sandboxed = JSON.parse(readFileSync(apiWranglerConfig({ plan: "paid", sandbox: true }), "utf8"));
    expect(sandboxed.worker_loaders).toEqual([{ binding: "LOADER" }]);
    expect(sandboxed.define).toEqual({ __SCALIUS_PLAN__: "\"paid\"" });
  });
});
