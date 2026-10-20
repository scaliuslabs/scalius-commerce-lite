// Runs the 30 merchant tasks in order against one seeded store and scores
// each: postconditions, wrong writes (tables changed outside the task's
// declared set), dry-run-then-confirm for gated steps, tool calls and bytes.

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ScriptedAgent, type RoutingNote } from "./agent";
import { seedEvalStore, type EvalFixtures } from "./seed";
import { McpEvalSession, confirmViolations, sessionMetrics, type SessionMetrics, type ToolCallRecord } from "./session";
import { createEvalStore, type EvalGrant, type EvalStore } from "./store";
import { MERCHANT_TASKS, type MerchantTask } from "./tasks";

/** Tables any call may touch: audit, outbox, dependency and idempotency bookkeeping maintained by the platform. */
export const AMBIENT_TABLES = [
  "agent_*", "event_outbox*", "event_*", "cache_*", "system_kv", "idempotency*", "*_idempotency*", "*search*", "*_fts*",
  "dependency_*", "dvc_*", "background_*", "outbox*", "*_outbox", "admin_audit*", "audit_*", "staff_alert*", "work_*",
  "request_*", "rate_limit*", "*_counts", "analytics_*", "dashboard_*", "derived_*", "*_projection*", "*_rollup*",
  // Trigger-maintained read models: checkout readiness facts and order-based recommendations.
  "checkout_authority", "recommendation_order_products",
];

export const MAX_MEDIAN_TOOL_CALLS = 6;
export const MAX_TASK_TOKENS = 40_000;

export interface TaskReport {
  n: number;
  prompt: string;
  grant: EvalGrant;
  needs?: string;
  /** Under Operator, the task's operations really are unavailable (the escalation is not assumed). */
  operatorRefuses?: boolean;
  passed: boolean;
  error?: string;
  failures: string[];
  knownGap?: string;
  routing: RoutingNote[];
  metrics: SessionMetrics;
  confirmViolations: string[];
  wrongWrites: string[];
  /** Up to 3 new or changed rows of each wrongly written table. */
  wrongWriteRows: Record<string, string[]>;
  changedTables: string[];
  calls: Array<{ tool: string; operationIds: string[]; dryRun: boolean; confirmToken: boolean; isError: boolean; resultBytes: number }>;
}

export interface EvalReport {
  tasks: TaskReport[];
  summary: {
    passed: number;
    total: number;
    medianToolCalls: number;
    maxTokens: number;
    wrongWrites: number;
    confirmViolations: number;
    operatorTasks: number;
  };
}

/** Each table's rows, serialized one per row, so a wrong write can be shown, not only counted. */
export function tableRows(sqlite: DatabaseSync): Map<string, string[]> {
  const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`).all() as Array<{ name: string }>;
  const rows = new Map<string, string[]>();
  for (const { name } of tables) {
    try {
      rows.set(name, sqlite.prepare(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(row)));
    } catch {
      // Shadow tables of virtual tables are not directly readable.
    }
  }
  return rows;
}

export function tableDigests(sqlite: DatabaseSync): Map<string, string> {
  const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`).all() as Array<{ name: string }>;
  const digests = new Map<string, string>();
  for (const { name } of tables) {
    try {
      const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all();
      digests.set(name, createHash("sha256").update(JSON.stringify(rows)).digest("hex"));
    } catch {
      // Shadow tables of virtual tables are not directly readable.
    }
  }
  return digests;
}

export function matchesTable(table: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(table));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Under Operator, describe answers operation_not_found for an op the task needed a higher grant for. */
async function operatorRefuses(store: EvalStore, task: MerchantTask): Promise<boolean> {
  store.useGrant("operator");
  const probe = await McpEvalSession.open({ surface: "dashboard", env: store.env, ctx: store.ctx });
  try {
    const result = await probe.call("scalius_describe", { ids: task.ops });
    const operations = (result.structuredContent?.operations ?? []) as Array<{ error?: { code?: string } }>;
    return operations.some((operation) => operation.error?.code === "operation_not_found");
  } finally {
    await probe.close();
  }
}

async function runTask(store: EvalStore, fx: EvalFixtures, task: MerchantTask): Promise<TaskReport> {
  const grant = task.grant ?? "operator";
  const refuses = grant === "operator" ? undefined : await operatorRefuses(store, task);
  store.useGrant(grant);
  const session = await McpEvalSession.open({ surface: "dashboard", env: store.env, ctx: store.ctx });
  const agent = new ScriptedAgent(session);
  const before = tableRows(store.sqlite);
  const ctx = { agent, fx, sqlite: store.sqlite, store, facts: {} as Record<string, unknown> };
  let error: string | undefined;
  let failures: string[] = [];
  try {
    await task.run(ctx);
    await store.settle();
    failures = task.verify(ctx);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    await store.settle();
  } finally {
    await session.close();
  }
  const after = tableRows(store.sqlite);
  const changedTables = [...after.keys()].filter((table) => (before.get(table) ?? []).join("\n") !== (after.get(table) ?? []).join("\n")).sort();
  const wrongWrites = changedTables.filter((table) => !matchesTable(table, [...AMBIENT_TABLES, ...task.writes]));
  const wrongWriteRows = Object.fromEntries(wrongWrites.map((table) => {
    const old = new Set(before.get(table) ?? []);
    return [table, (after.get(table) ?? []).filter((row) => !old.has(row)).slice(0, 3).map((row) => row.slice(0, 400))];
  }));
  const records: ToolCallRecord[] = session.records;
  const violations = confirmViolations(records);
  const metrics = sessionMetrics(records, session.overheadBytes);
  const passed = !error && failures.length === 0 && wrongWrites.length === 0 && violations.length === 0;
  return {
    n: task.n,
    prompt: task.prompt(fx),
    grant,
    ...(task.needs ? { needs: task.needs } : {}),
    ...(refuses === undefined ? {} : { operatorRefuses: refuses }),
    passed,
    ...(error ? { error } : {}),
    failures,
    ...(task.knownGap ? { knownGap: task.knownGap } : {}),
    routing: agent.routing,
    metrics,
    confirmViolations: violations,
    wrongWrites,
    wrongWriteRows,
    changedTables,
    calls: records.map((record) => ({
      tool: record.tool,
      operationIds: record.operationIds,
      dryRun: record.dryRun,
      confirmToken: record.confirmToken,
      isError: record.isError,
      resultBytes: record.resultBytes,
    })),
  };
}

export async function runMerchantTaskEval(options: { only?: number[] } = {}): Promise<EvalReport> {
  const store = createEvalStore();
  try {
    const fx = await seedEvalStore(store);
    const tasks: TaskReport[] = [];
    for (const task of MERCHANT_TASKS) {
      if (options.only && !options.only.includes(task.n)) continue;
      tasks.push(await runTask(store, fx, task));
    }
    return {
      tasks,
      summary: {
        passed: tasks.filter((task) => task.passed).length,
        total: tasks.length,
        medianToolCalls: median(tasks.map((task) => task.metrics.toolCalls)),
        maxTokens: Math.max(0, ...tasks.map((task) => task.metrics.estimatedTokens)),
        wrongWrites: tasks.reduce((sum, task) => sum + task.wrongWrites.length, 0),
        confirmViolations: tasks.reduce((sum, task) => sum + task.confirmViolations.length, 0),
        operatorTasks: tasks.filter((task) => task.grant === "operator").length,
      },
    };
  } finally {
    store.close();
  }
}
