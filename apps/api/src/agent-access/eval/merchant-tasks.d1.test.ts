// Deterministic layer of the agent release acceptance (AGENT-TOOLING-SPEC
// §4.6): the 30 merchant tasks scripted through the real MCP server into the
// real Hono app on the test D1. Only the OAuth context lookup is replaced; the
// grant, principal, authorization, confirmation and every route are real.
//
// AGENT_EVAL_REPORT=<path> writes the full JSON report; AGENT_EVAL_ONLY=1,5
// runs a subset.
import "@hono/zod-openapi";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("agents/mcp/server", async () => {
  const { evalAuth } = await import("./auth-state");
  return { createMcpHandler: vi.fn(), getMcpAuthContext: () => ({ props: evalAuth.props }) };
});

import { MAX_MEDIAN_TOOL_CALLS, MAX_TASK_TOKENS, runMerchantTaskEval, type EvalReport } from "./run";

const only = process.env.AGENT_EVAL_ONLY?.split(",").map(Number).filter(Number.isFinite);

describe("merchant task acceptance through MCP", () => {
  let report: EvalReport;

  it("runs the 30 merchant tasks on a seeded store", async () => {
    report = await runMerchantTaskEval(only?.length ? { only } : {});
    if (process.env.AGENT_EVAL_REPORT) writeFileSync(process.env.AGENT_EVAL_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    expect(report.tasks.length).toBe(only?.length ? only.length : 30);
  }, 600_000);

  it("passes every task without a recorded gap, and every recorded gap is still real", () => {
    const unexpected = report.tasks.filter((task) => !task.knownGap && !task.passed)
      .map(({ n, error, failures, wrongWrites, confirmViolations }) => ({ n, error, failures, wrongWrites, confirmViolations }));
    expect(unexpected).toEqual([]);
    // A gap that closes must be removed from tasks.ts, so the bar only ratchets.
    expect(report.tasks.filter((task) => task.knownGap && task.passed).map((task) => task.n)).toEqual([]);
  });

  it("makes zero wrong writes and runs every destructive or financial step as dry run then confirm", () => {
    expect(report.tasks.flatMap((task) => task.wrongWrites.map((table) => `${task.n}:${table}`))).toEqual([]);
    expect(report.tasks.flatMap((task) => task.confirmViolations.map((violation) => `${task.n}:${violation}`))).toEqual([]);
  });

  it("escalates past Operator only where Operator really cannot reach the operations", () => {
    expect(report.tasks.filter((task) => task.grant !== "operator" && task.operatorRefuses !== true).map((task) => task.n)).toEqual([]);
  });

  it("keeps the median at most 6 tool calls and every task within 40k tokens", () => {
    expect(report.summary.medianToolCalls).toBeLessThanOrEqual(MAX_MEDIAN_TOOL_CALLS);
    expect(report.tasks.filter((task) => task.metrics.estimatedTokens > MAX_TASK_TOKENS).map((task) => task.n)).toEqual([]);
  });
});
