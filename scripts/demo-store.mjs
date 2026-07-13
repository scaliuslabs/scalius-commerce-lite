#!/usr/bin/env node
import { buildDemoStorePlan, formatDemoStorePlan } from "./demo-store/plan.mjs";

function usage() {
  return "Usage: pnpm demo:store --plan [--json]";
}

export function parseDemoStoreArgs(argv) {
  const allowed = new Set(["--plan", "--json", "--help"]);
  const unknown = argv.filter((argument) => !allowed.has(argument));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}\n${usage()}`);
  return {
    help: argv.includes("--help"),
    plan: argv.includes("--plan"),
    json: argv.includes("--json"),
  };
}

export async function main(argv = process.argv.slice(2), io = console) {
  const args = parseDemoStoreArgs(argv);
  if (args.help) {
    io.log(usage());
    return 0;
  }
  if (!args.plan) throw new Error(`Write mode is not implemented. Run the validated, network-free plan first.\n${usage()}`);
  const plan = buildDemoStorePlan();
  io.log(args.json ? JSON.stringify(plan, null, 2) : formatDemoStorePlan(plan));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

