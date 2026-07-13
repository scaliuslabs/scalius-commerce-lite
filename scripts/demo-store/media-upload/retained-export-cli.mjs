#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createAdminReadClient } from "../api-read.mjs";
import { readAdminCredentials } from "../credentials.mjs";
import { demoStoreManifest } from "../manifest.mjs";
import { closeAdminSession, normalizeAdminOrigin, openAdminSession } from "../session.mjs";
import { runRetainedMediaExport, validatePrivateSourceDirectoryPath, validateRetainedExportAuthorityShape } from "./retained-export.mjs";

function usage() {
  return `Usage:
  pnpm exec node scripts/demo-store/media-upload/retained-export-cli.mjs \\
    --export-retained --authority <retained-media-authority.json> \\
    --source-dir <workspace/.wrangler/private-source-dir> \\
    [--admin-url <origin>] [--timeout-ms <milliseconds>]

The command performs authenticated reads and sequential Media downloads only.
Credentials are requested through an interactive terminal and are never accepted
through arguments or environment variables.`;
}

export function parseRetainedExportArgs(argv) {
  const options = { exportRetained: false, help: false, authority: null, sourceDir: null, adminUrl: "https://dashboard.scalius.com", timeoutMs: 30_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--export-retained") { options.exportRetained = true; continue; }
    if (/^--(?:email|username|password|cookie|token|secret|authorization|api[-_]key|session)(?:=|$)/iu.test(arg)) throw new Error("Credentials and session material are accepted only through the interactive prompt.");
    if (["--authority", "--source-dir", "--admin-url", "--timeout-ms"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      if (arg === "--authority") options.authority = path.resolve(value);
      else if (arg === "--source-dir") options.sourceDir = path.resolve(value);
      else if (arg === "--admin-url") options.adminUrl = value;
      else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) throw new Error("timeout-ms must be between 1000 and 120000.");
        options.timeoutMs = parsed;
      }
      continue;
    }
    throw new Error(`Unknown argument.\n${usage()}`);
  }
  if (!options.help && (!options.exportRetained || !options.authority || !options.sourceDir)) throw new Error(`Export requires --export-retained, --authority, and --source-dir.\n${usage()}`);
  return options;
}

async function boundedJson(filePath) {
  const text = await readFile(filePath, "utf8");
  if (text.length > 256 * 1024) throw new Error("Retained Media authority exceeds its safe size limit.");
  try { return JSON.parse(text); } catch { throw new Error("Retained Media authority is not valid JSON."); }
}

export async function main(argv = process.argv.slice(2), {
  credentialReader = readAdminCredentials,
  sessionOpener = openAdminSession,
  sessionCloser = closeAdminSession,
  runExport = runRetainedMediaExport,
  fetchImpl = fetch,
  log = console.log,
  workspaceDir = process.cwd(),
} = {}) {
  const options = parseRetainedExportArgs(argv);
  if (options.help) { log(usage()); return 0; }
  validatePrivateSourceDirectoryPath(options.sourceDir, workspaceDir);
  const authority = await boundedJson(options.authority);
  validateRetainedExportAuthorityShape(authority);
  const adminOrigin = normalizeAdminOrigin(options.adminUrl);
  const credentials = await credentialReader();
  let session;
  let cleanup = { status: "not_started" };
  let result;
  try {
    session = await sessionOpener({ adminOrigin, ...credentials, fetchImpl, timeoutMs: options.timeoutMs });
    const readClient = createAdminReadClient({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs: options.timeoutMs });
    result = await runExport({ authority, manifest: demoStoreManifest, sourceDir: options.sourceDir, workspaceDir, readClient, fetchImpl, timeoutMs: options.timeoutMs });
  } finally {
    if (session?.cookieHeader) cleanup = await sessionCloser({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs: options.timeoutMs });
    if (cleanup.status === "warning") log("Session cleanup requires attention; no credential or cookie material was retained.");
  }
  log(JSON.stringify({ status: "complete", summary: result.summary, sourceDir: result.sourceDir, candidate: result.candidatePath, sessionCleanup: cleanup.status }, null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
