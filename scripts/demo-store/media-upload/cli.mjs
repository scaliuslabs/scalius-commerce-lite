#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createAdminReadClient } from "../api-read.mjs";
import { readAdminCredentials } from "../credentials.mjs";
import { demoStoreManifest } from "../manifest.mjs";
import { closeAdminSession, normalizeAdminOrigin, openAdminSession } from "../session.mjs";
import { createMediaUploadClient } from "./client.mjs";
import { runMediaUploadBridge } from "./run.mjs";
import { validateCompleteStagedInputs } from "./validate.mjs";

const defaults = {
  manifest: path.resolve("scripts/demo-store/assets/asset-sources.json"),
  stagedReport: path.resolve(".wrangler/demo-store-assets/readiness.json"),
  stagedDir: path.resolve(".wrangler/demo-store-assets/staged"),
  journal: path.resolve(".wrangler/demo-store-assets/media-upload.jsonl"),
  output: path.resolve(".wrangler/demo-store-assets/apply-readiness.json"),
  adminUrl: "https://dashboard.scalius.com",
  timeoutMs: 30_000,
};

function usage() {
  return `Usage:
  pnpm exec node scripts/demo-store/media-upload/cli.mjs --upload \\
    --manifest <source-manifest.json> --staged-report <readiness.json> \\
    --staged-dir <directory> [--journal <resume.jsonl>] [--output <apply-readiness.json>] \\
    [--admin-url <origin>] [--timeout-ms <milliseconds>]

Credentials are requested only through an interactive terminal. This command
uploads/reuses Media sequentially and never mutates products or publication.`;
}

export function parseMediaUploadArgs(argv) {
  const options = { ...defaults, upload: false, help: false };
  const paths = new Map([
    ["--manifest", "manifest"], ["--staged-report", "stagedReport"], ["--staged-dir", "stagedDir"],
    ["--journal", "journal"], ["--output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--upload") { options.upload = true; continue; }
    if (/^--(?:email|password|cookie|token|secret)(?:=|$)/iu.test(arg)) throw new Error("Credentials and session material are accepted only through the interactive prompt.");
    if (paths.has(arg) || arg === "--admin-url" || arg === "--timeout-ms") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      if (paths.has(arg)) options[paths.get(arg)] = path.resolve(value);
      else if (arg === "--admin-url") options.adminUrl = value;
      else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) throw new Error("timeout-ms must be between 1000 and 120000.");
        options.timeoutMs = parsed;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
}

async function boundedJson(filePath, label) {
  const text = await readFile(filePath, "utf8");
  if (text.length > 20 * 1024 * 1024) throw new Error(`${label} exceeds its safe size limit.`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON.`); }
}

export async function main(argv = process.argv.slice(2), {
  credentialReader = readAdminCredentials,
  sessionOpener = openAdminSession,
  sessionCloser = closeAdminSession,
  runBridge = runMediaUploadBridge,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const options = parseMediaUploadArgs(argv);
  if (options.help) { log(usage()); return 0; }
  if (!options.upload) throw new Error(`Media writes require explicit --upload authorization.\n${usage()}`);
  const adminOrigin = normalizeAdminOrigin(options.adminUrl);
  const [sourceManifest, stagedReport] = await Promise.all([
    boundedJson(options.manifest, "Source manifest"),
    boundedJson(options.stagedReport, "Staged readiness"),
  ]);
  const validatedLocal = await validateCompleteStagedInputs({
    manifest: demoStoreManifest,
    sourceManifest,
    stagedReport,
    stagedDir: options.stagedDir,
  });
  const credentials = await credentialReader();
  let session;
  let cleanup = { status: "not_started", statusCode: null };
  let result;
  try {
    session = await sessionOpener({ adminOrigin, ...credentials, fetchImpl, timeoutMs: options.timeoutMs });
    const readClient = createAdminReadClient({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs: options.timeoutMs });
    const mediaClient = createMediaUploadClient({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs: options.timeoutMs });
    result = await runBridge({
      manifest: demoStoreManifest,
      sourceManifest,
      stagedReport,
      stagedDir: options.stagedDir,
      journalPath: options.journal,
      outputPath: options.output,
      readClient,
      mediaClient,
      fetchImpl,
      timeoutMs: options.timeoutMs,
      validatedLocal,
    });
  } finally {
    if (session?.cookieHeader) cleanup = await sessionCloser({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs: options.timeoutMs });
    if (cleanup.status === "warning") log("Session cleanup requires attention; no credential or cookie material was retained.");
  }
  log(JSON.stringify({ status: "complete", summary: result.summary, output: options.output, journal: options.journal, sessionCleanup: cleanup.status }, null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
