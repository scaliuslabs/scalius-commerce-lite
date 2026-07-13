#!/usr/bin/env node
import { buildDemoStorePlan, formatDemoStorePlan } from "./demo-store/plan.mjs";
import { formatDemoStoreDiff } from "./demo-store/diff.mjs";
import { readAdminCredentials } from "./demo-store/credentials.mjs";
import { runDemoStoreDiff } from "./demo-store/run-diff.mjs";
import { normalizeAdminOrigin } from "./demo-store/session.mjs";

function usage() {
  return `Usage:
  pnpm demo:store --plan [--json]
  pnpm demo:store --diff [--admin-url <origin>] [--evidence-dir <path>] [--timeout-ms <ms>] [--json]

Plan mode is network-free. Diff mode prompts for admin email and a hidden
password, performs bounded authenticated GETs, writes local evidence under
.wrangler by default, signs out, and never enables catalog writes.`;
}

export function parseDemoStoreArgs(argv) {
  const result = { help: false, plan: false, diff: false, json: false };
  const valueOptions = new Map([
    ["--admin-url", "adminUrl"], ["--evidence-dir", "evidenceDir"], ["--timeout-ms", "timeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--plan") result.plan = true;
    else if (argument === "--diff") result.diff = true;
    else if (argument === "--json") result.json = true;
    else if (argument === "--email" || argument === "--password" || argument.startsWith("--email=") || argument.startsWith("--password=")) {
      throw new Error("Admin credentials are accepted only through the interactive terminal prompt.");
    } else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      result[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      const matched = [...valueOptions].find(([flag]) => argument.startsWith(`${flag}=`));
      if (!matched) throw new Error(`Unknown option: ${argument}\n${usage()}`);
      result[matched[1]] = argument.slice(matched[0].length + 1);
    }
  }
  if (result.plan && result.diff) throw new Error("Choose either --plan or --diff, not both.");
  return result;
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export async function main(argv = process.argv.slice(2), {
  log = console.log,
  credentialReader = readAdminCredentials,
  runDiffImpl = runDemoStoreDiff,
} = {}) {
  const args = parseDemoStoreArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }
  if (!args.plan && !args.diff) throw new Error(`Write mode is not implemented. Choose --plan or read-only --diff.\n${usage()}`);
  if (args.plan) {
    const plan = buildDemoStorePlan();
    log(args.json ? JSON.stringify(plan, null, 2) : formatDemoStorePlan(plan));
    return 0;
  }
  const adminOrigin = normalizeAdminOrigin(args.adminUrl ?? "https://dashboard.scalius.com");
  const credentials = await credentialReader();
  const result = await runDiffImpl({
    adminOrigin,
    credentials,
    evidenceDir: args.evidenceDir,
    timeoutMs: positiveInteger(args.timeoutMs, 20_000, "timeout-ms"),
  });
  log(args.json
    ? JSON.stringify(result, null, 2)
    : `${formatDemoStoreDiff(result.diff)}\nEvidence: ${result.evidence.runDir}\nSession cleanup: ${result.sessionCleanup.status}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
