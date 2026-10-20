#!/usr/bin/env node
// Agent release acceptance (audit AGENT-TOOLING-SPEC §4.6): the 30 merchant tasks.
//
//   node scripts/agent-eval.mjs                 deterministic layer (no model, CI-able)
//   node scripts/agent-eval.mjs --live          one real Claude session per task
//   options: --tasks 1,5,9   --report <path>   --model <id>   --max-turns <n>
//
// Both layers seed the same demo store (real migrations on the test D1) and
// serve it through the real MCP server and Hono app in-process; the live
// layer exposes that server on a loopback HTTP endpoint and gives the model
// only the scalius skills (packages/cli/skills) and that MCP server. Each task
// is scored by the same database postconditions, wrong-write table diff,
// dry-run-then-confirm check, tool-call count and bytes.
//
// The live layer needs ANTHROPIC_API_KEY in the shell environment (never read
// from a file) and @anthropic-ai/claude-agent-sdk installed in the workspace
// (pnpm add -D -w @anthropic-ai/claude-agent-sdk). It spends model tokens.
// Heavy: run it through scalius-lock on the shared development host.

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/agent-eval.mjs [--live] [--tasks 1,5] [--report path] [--model id] [--max-turns n]`);
  process.exit(0);
}

const live = args.includes("--live");
const env = { ...process.env };
const tasks = option("tasks");
if (tasks) {
  if (!/^\d+(,\d+)*$/.test(tasks)) {
    console.error("--tasks takes task numbers, for example --tasks 1,5,9");
    process.exit(2);
  }
  env.AGENT_EVAL_ONLY = tasks;
}
env.AGENT_EVAL_REPORT = resolve(option("report") ?? join(tmpdir(), `scalius-agent-eval-${live ? "live" : "deterministic"}.json`));
if (live) {
  if (!env.ANTHROPIC_API_KEY) {
    console.error("--live needs ANTHROPIC_API_KEY in the environment.");
    process.exit(2);
  }
  env.AGENT_EVAL_LIVE = "1";
  if (option("model")) env.AGENT_EVAL_MODEL = option("model");
  if (option("max-turns")) env.AGENT_EVAL_MAX_TURNS = option("max-turns");
}

const testFile = live
  ? "apps/api/src/agent-access/eval/merchant-tasks.live.test.ts"
  : "apps/api/src/agent-access/eval/merchant-tasks.d1.test.ts";
const result = spawnSync("pnpm", ["exec", "vitest", "run", testFile, "--maxWorkers=1"], { cwd: root, env, stdio: "inherit" });
console.log(`\nReport: ${env.AGENT_EVAL_REPORT}`);
process.exit(result.status ?? 1);
