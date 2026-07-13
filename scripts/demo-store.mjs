#!/usr/bin/env node
import path from "node:path";

import { buildDemoStorePlan, formatDemoStorePlan } from "./demo-store/plan.mjs";
import { compileDemoStoreAdminCommands, formatDemoStoreCompile } from "./demo-store/compile.mjs";
import { demoStoreManifest } from "./demo-store/manifest.mjs";
import { formatDemoStoreDiff } from "./demo-store/diff.mjs";
import { readAdminCredentials } from "./demo-store/credentials.mjs";
import { runDemoStoreDiff } from "./demo-store/run-diff.mjs";
import { normalizeAdminOrigin } from "./demo-store/session.mjs";
import { runDemoStoreApply } from "./demo-store/run-apply.mjs";
import { readDemoApplyConfirmation } from "./demo-store/apply/confirmation.mjs";
import { demoApplyIntentFingerprint } from "./demo-store/apply/authorization.mjs";
import { preparePrivateApplyPaths, readPrivateApplyJson } from "./demo-store/apply/private-state.mjs";

function usage() {
  return `Usage:
  pnpm demo:store --plan [--json]
  pnpm demo:store --compile [--json]
  pnpm demo:store --diff [--admin-url <origin>] [--evidence-dir <path>] [--timeout-ms <ms>] [--json]
  pnpm demo:store --apply --media-readiness <private-report.json> [--admin-url <origin>]
    [--evidence-dir <workspace/.wrangler/path>] [--resume-file <workspace/.wrangler/path>]
    [--timeout-ms <ms>] [--json]

Plan and compile modes are network-free and write-disabled. Diff mode prompts for admin email and a hidden
password, performs bounded authenticated GETs, writes local evidence under
.wrangler by default, signs out, and never enables catalog writes.

Apply requires a complete remote Media readiness report, hidden interactive credentials, an explicit
demo-reset phrase, and the full displayed intent fingerprint. Header/footer and standalone promotion
writes remain excluded because their current authorities are not safe for this executor.`;
}

export function parseDemoStoreArgs(argv) {
  const result = { help: false, plan: false, compile: false, diff: false, apply: false, json: false };
  const valueOptions = new Map([
    ["--admin-url", "adminUrl"], ["--evidence-dir", "evidenceDir"], ["--timeout-ms", "timeoutMs"],
    ["--media-readiness", "mediaReadiness"], ["--resume-file", "resumeFile"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--plan") result.plan = true;
    else if (argument === "--compile") result.compile = true;
    else if (argument === "--diff") result.diff = true;
    else if (argument === "--apply") result.apply = true;
    else if (argument === "--json") result.json = true;
    else if (/^--(?:email|password|cookie|token|secret)(?:=|$)/iu.test(argument)) {
      throw new Error("Admin credentials and session material are accepted only through the interactive terminal prompt.");
    } else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      result[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      const matched = [...valueOptions].find(([flag]) => argument.startsWith(`${flag}=`));
      if (!matched) throw new Error(`Unknown option: ${argument}\n${usage()}`);
      const value = argument.slice(matched[0].length + 1);
      if (!value) throw new Error(`Option ${matched[0]} requires a value.`);
      result[matched[1]] = value;
    }
  }
  if ([result.plan, result.compile, result.diff, result.apply].filter(Boolean).length > 1) {
    throw new Error("Choose exactly one of --plan, --compile, --diff, or --apply.");
  }
  if (!result.apply && (result.mediaReadiness || result.resumeFile)) throw new Error("Media readiness and resume options are valid only with --apply.");
  if (result.apply && !result.mediaReadiness) throw new Error("--apply requires an explicit --media-readiness private report path.");
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
  runApplyImpl = runDemoStoreApply,
  confirmationReader = readDemoApplyConfirmation,
  prepareApplyPaths = preparePrivateApplyPaths,
  readApplyJson = readPrivateApplyJson,
} = {}) {
  const args = parseDemoStoreArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }
  if (!args.plan && !args.compile && !args.diff && !args.apply) throw new Error(`Choose --plan, --compile, read-only --diff, or guarded --apply.\n${usage()}`);
  if (args.plan) {
    const plan = buildDemoStorePlan();
    log(args.json ? JSON.stringify(plan, null, 2) : formatDemoStorePlan(plan));
    return 0;
  }
  if (args.compile) {
    const compiled = compileDemoStoreAdminCommands(demoStoreManifest);
    log(args.json ? JSON.stringify(compiled, null, 2) : formatDemoStoreCompile(compiled));
    return 0;
  }
  const adminOrigin = normalizeAdminOrigin(args.adminUrl ?? "https://dashboard.scalius.com");
  if (args.apply) {
    const publicationIntent = {};
    const intentFingerprint = demoApplyIntentFingerprint(demoStoreManifest, publicationIntent);
    const paths = await prepareApplyPaths({
      evidenceDir: args.evidenceDir ? path.resolve(args.evidenceDir) : undefined,
      resumeFile: args.resumeFile ? path.resolve(args.resumeFile) : undefined,
      intentFingerprint,
    });
    const readinessReport = await readApplyJson(path.resolve(args.mediaReadiness), {
      label: "Remote Media readiness report",
    });
    const credentials = await credentialReader();
    const result = await runApplyImpl({
      adminOrigin,
      credentials,
      readinessReport,
      evidenceDir: paths.evidenceDir,
      resumeFile: paths.resumeFile,
      manifest: demoStoreManifest,
      publicationIntent,
      timeoutMs: positiveInteger(args.timeoutMs, 20_000, "timeout-ms"),
      confirmApply: async ({ intentFingerprint: fingerprint, diff, lifecycle, permissions }) => {
        log([
          formatDemoStoreDiff(diff),
          `Ready phases: ${lifecycle.phases.filter((phase) => phase.state === "ready").map((phase) => phase.name).join(", ")}`,
          `Write permissions: ${permissions.required.join(", ")}`,
          "Excluded writes: header, footer, standalone promotions",
          `Intent fingerprint: ${fingerprint}`,
        ].join("\n"));
        return confirmationReader({ intentFingerprint: fingerprint });
      },
    });
    const summary = {
      status: result.status,
      intentFingerprint: result.intentFingerprint,
      verifiedCommands: result.verification.verifiedCommands,
      evidence: result.evidence,
      resumeFile: result.resumeFile,
      sessionCleanup: result.sessionCleanup.status,
    };
    log(args.json
      ? JSON.stringify(summary, null, 2)
      : `Demo apply verified ${summary.verifiedCommands} terminal commands.\nEvidence: ${summary.evidence.runDir}\nResume: ${summary.resumeFile}\nSession cleanup: ${summary.sessionCleanup}`);
    return 0;
  }
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
