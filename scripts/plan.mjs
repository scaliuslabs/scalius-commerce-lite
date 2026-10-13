// The Workers plan a deploy targets, and the Wrangler config it implies.
//
// The plan is decided once, at deploy time: `--plan paid` (or SCALIUS_PLAN=paid;
// `--plugin-sandbox` and a lockfile with the sandbox on imply it, because the
// Worker Loader is Workers Paid). Nothing selects Paid by itself, and the
// default is Free: the committed Wrangler configs are Free-ready (no `limits`,
// no `define`; `pnpm check:env` enforces it) and a Paid deploy generates a
// config beside them that adds exactly what the plan's profile
// (packages/shared/src/plan-limits.ts) says: `limits.cpu_ms` and the build
// constant `__SCALIUS_PLAN__` the Worker reads through `planLimits()`. No environment variable or secret is involved.
import { PLAN_LIMITS } from "../packages/shared/src/plan-limits.ts";

export const PLANS = Object.freeze(["free", "paid"]);

/** Parses `--plan <free|paid>` / `--plan=paid` out of argv; null when absent. Throws on a bad value. */
export function planFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value;
    if (arg === "--plan") value = args[index + 1];
    else if (arg.startsWith("--plan=")) value = arg.slice("--plan=".length);
    else continue;
    return parsePlan(value, "--plan");
  }
  return null;
}

export function parsePlan(value, label) {
  const plan = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PLANS.includes(plan)) {
    throw new Error(`${label} must be one of ${PLANS.join(", ")}, got ${JSON.stringify(value ?? "")}.`);
  }
  return plan;
}

/**
 * The plan of this run: the flag, else SCALIUS_PLAN, else Paid when the plugin
 * sandbox is on (it needs Workers Paid), else Free. An explicit Free with the
 * sandbox on is a contradiction and fails.
 */
export function resolvePlan({ args = [], env = process.env, sandbox = false } = {}) {
  const flag = planFromArgs(args);
  const fromEnv = env.SCALIUS_PLAN === undefined || env.SCALIUS_PLAN === "" ? null : parsePlan(env.SCALIUS_PLAN, "SCALIUS_PLAN");
  const explicit = flag ?? fromEnv;
  if (explicit === "free" && sandbox) {
    throw new Error("The plugin sandbox (Worker Loader) needs Workers Paid: deploy with --plan paid, or turn the sandbox off (pnpm plugin sandbox off).");
  }
  return explicit ?? (sandbox ? "paid" : "free");
}

/**
 * `config` with the plan's profile applied. Free returns it unchanged (the
 * committed config is the Free config); Paid adds the build constant and the
 * CPU limit.
 */
export function withPlanProfile(config, plan) {
  if (plan === "free") return config;
  const limits = PLAN_LIMITS[plan];
  const next = {
    ...config,
    define: { ...config.define, __SCALIUS_PLAN__: JSON.stringify(plan) },
  };
  if (limits.cpuMs !== null) next.limits = { ...config.limits, cpu_ms: limits.cpuMs };
  return next;
}

/** The Storefront build's generated config (dist/server/wrangler.json) with the plan's CPU limit. */
export function withStorefrontPlanProfile(config, plan) {
  const limits = PLAN_LIMITS[plan];
  if (plan === "free" || limits.cpuMs === null) return config;
  return { ...config, limits: { ...config.limits, cpu_ms: limits.cpuMs } };
}

/** What the committed (Free) Wrangler config must say, so a Free deploy needs no flag. Returns problems. */
export function collectCommittedPlanViolations(configPath, config) {
  const problems = [];
  if (config?.limits !== undefined) {
    problems.push(
      `${configPath} declares limits. The committed config is the Free config (Workers Free has a fixed 10 ms CPU limit and does not accept limits.cpu_ms): `
      + "a Paid deploy adds limits.cpu_ms from the plan profile (--plan paid).",
    );
  }
  if (config?.define?.__SCALIUS_PLAN__ !== undefined) {
    problems.push(`${configPath} defines __SCALIUS_PLAN__. The plan is decided at deploy time (--plan), never committed.`);
  }
  return problems;
}
