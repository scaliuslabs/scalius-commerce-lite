// Live layer of the agent release acceptance: a real Claude session per
// merchant task, with only the scalius skills and the scalius MCP server,
// against the same seeded store and scored by the same postconditions as
// the deterministic layer. Opt-in and costs model tokens: run it through
// `node scripts/agent-eval.mjs` (it sets AGENT_EVAL_LIVE=1); skipped otherwise.
import "@hono/zod-openapi";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("agents/mcp/server", async () => {
  const { evalAuth } = await import("./auth-state");
  return { createMcpHandler: vi.fn(), getMcpAuthContext: () => ({ props: evalAuth.props }) };
});

import { ScriptedAgent } from "./agent";
import { startMcpHttpBridge } from "./http-bridge";
import { AMBIENT_TABLES, MAX_MEDIAN_TOOL_CALLS, MAX_TASK_TOKENS, matchesTable, tableDigests } from "./run";
import { seedEvalStore } from "./seed";
import { BYTES_PER_TOKEN, McpEvalSession } from "./session";
import { createEvalStore } from "./store";
import { MERCHANT_TASKS } from "./tasks";

const live = process.env.AGENT_EVAL_LIVE === "1";
const only = process.env.AGENT_EVAL_ONLY?.split(",").map(Number).filter(Number.isFinite);
const skillsRoot = join(import.meta.dirname, "../../../../../packages/cli/skills");

const EVAL_POLICY = [
  "You are operating a Scalius store for its merchant through the scalius MCP tools only.",
  "The merchant has already approved every change this task asks for: when a change returns a confirmation summary and approval link, state it once and repeat the same change with its approvalId.",
  "Do not invent ids; read them from the store. Finish with a one-paragraph answer for the merchant that states the facts you read.",
].join(" ");

interface LiveResult {
  n: number;
  passed: boolean;
  failures: string[];
  toolCalls: number;
  estimatedTokens: number;
  modelUsage?: unknown;
  finalText: string;
  wrongWrites: string[];
  error?: string;
}

function factValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(factValues);
  if (typeof value === "object") return [];
  return [String(value)];
}

describe.skipIf(!live)("merchant tasks with a live model", () => {
  it("runs each task in a real Claude session and scores the postconditions", async () => {
    // Not a workspace dependency: resolved only when the live layer runs.
    const sdkModule = "@anthropic-ai/claude-agent-sdk";
    let sdk: { query(input: { prompt: string; options: unknown }): AsyncIterable<unknown> };
    try {
      sdk = await import(/* @vite-ignore */ sdkModule) as typeof sdk;
    } catch {
      throw new Error("The live layer needs @anthropic-ai/claude-agent-sdk: pnpm add -D -w @anthropic-ai/claude-agent-sdk (not a default dependency).");
    }
    const store = createEvalStore();
    const fx = await seedEvalStore(store);
    const bridge = await startMcpHttpBridge({ env: store.env, ctx: store.ctx });
    const workspace = mkdtempSync(join(tmpdir(), "scalius-agent-eval-"));
    for (const skill of readdirSync(skillsRoot)) cpSync(join(skillsRoot, skill), join(workspace, ".claude/skills", skill), { recursive: true });
    const results: LiveResult[] = [];
    try {
      for (const task of MERCHANT_TASKS) {
        if (only?.length && !only.includes(task.n)) continue;
        store.useGrant(task.grant ?? "operator");
        const firstCall = bridge.calls.length;
        const before = tableDigests(store.sqlite);
        let finalText = "";
        let modelUsage: unknown;
        let error: string | undefined;
        try {
          for await (const message of sdk.query({
            prompt: task.prompt(fx),
            options: {
              cwd: workspace,
              model: process.env.AGENT_EVAL_MODEL || undefined,
              settingSources: ["project"],
              mcpServers: { scalius: { type: "http", url: bridge.url } },
              allowedTools: ["Skill", "mcp__scalius__*"],
              disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit"],
              permissionMode: "bypassPermissions",
              appendSystemPrompt: EVAL_POLICY,
              maxTurns: Number(process.env.AGENT_EVAL_MAX_TURNS ?? 24),
            },
          })) {
            const value = message as { type?: string; result?: string; usage?: unknown; subtype?: string };
            if (value.type === "result") {
              finalText = value.result ?? "";
              modelUsage = value.usage;
              if (value.subtype && value.subtype !== "success") error = `session ended: ${value.subtype}`;
            }
          }
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        await store.settle();
        await store.drainBulkRuns();
        const calls = bridge.calls.slice(firstCall);
        const after = tableDigests(store.sqlite);
        const changed = [...after.keys()].filter((table) => before.get(table) !== after.get(table));
        const wrongWrites = changed.filter((table) => !matchesTable(table, [...AMBIENT_TABLES, ...task.writes]));
        let failures: string[];
        if (task.writes.length === 0) {
          // A question: the truth comes from the scripted reads; the answer must state it.
          const truthSession = await McpEvalSession.open({ surface: "dashboard", env: store.env, ctx: store.ctx });
          const ctx = { agent: new ScriptedAgent(truthSession), fx, sqlite: store.sqlite, store, facts: {} as Record<string, unknown> };
          try {
            await task.run(ctx);
            failures = task.verify(ctx);
          } finally {
            await truthSession.close();
          }
          for (const value of Object.values(ctx.facts).flatMap(factValues)) {
            if (!finalText.includes(value)) failures.push(`answer does not state ${value}`);
          }
        } else {
          failures = task.verify({ agent: null as never, fx, sqlite: store.sqlite, store, facts: {} });
        }
        const bytes = calls.reduce((sum, call) => sum + call.argBytes + call.resultBytes, 0);
        results.push({
          n: task.n,
          passed: !error && failures.length === 0 && wrongWrites.length === 0,
          failures,
          toolCalls: calls.length,
          estimatedTokens: Math.ceil(bytes / BYTES_PER_TOKEN),
          modelUsage,
          finalText: finalText.slice(0, 2000),
          wrongWrites,
          ...(error ? { error } : {}),
        });
      }
    } finally {
      await bridge.close();
      rmSync(workspace, { recursive: true, force: true });
      store.close();
    }
    const sorted = results.map((result) => result.toolCalls).sort((a, b) => a - b);
    const summary = {
      passed: results.filter((result) => result.passed).length,
      total: results.length,
      medianToolCalls: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
      maxTokens: Math.max(0, ...results.map((result) => result.estimatedTokens)),
      wrongWrites: results.reduce((sum, result) => sum + result.wrongWrites.length, 0),
    };
    if (process.env.AGENT_EVAL_REPORT) writeFileSync(process.env.AGENT_EVAL_REPORT, `${JSON.stringify({ summary, results }, null, 2)}\n`);
    expect(summary.wrongWrites).toBe(0);
    expect(summary.medianToolCalls).toBeLessThanOrEqual(MAX_MEDIAN_TOOL_CALLS);
    expect(results.filter((result) => result.estimatedTokens > MAX_TASK_TOKENS).map((result) => result.n)).toEqual([]);
    expect(results.filter((result) => !result.passed).map(({ n, error, failures }) => ({ n, error, failures }))).toEqual([]);
  }, 3_600_000);
});
