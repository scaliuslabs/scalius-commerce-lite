#!/usr/bin/env node
// The API Worker must deploy on Workers Free, whose compressed upload limit
// is 3 MiB. Bundled plugins compile into this Worker (apps/api/src/plugins/
// bundled.gen.ts), so every deploy measures the built Worker's gzip size and
// fails with a 10% margin to spare. `pnpm check:api-bundle` builds into a
// temporary directory; the deploy passes `--dist apps/api/dist` (just built).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");

export const FREE_PLAN_COMPRESSED_LIMIT_BYTES = 3 * 1024 * 1024;
export const API_BUNDLE_MARGIN = 0.1;
export const API_BUNDLE_BUDGET_BYTES = Math.floor(FREE_PLAN_COMPRESSED_LIMIT_BYTES * (1 - API_BUNDLE_MARGIN));

/** Every uploaded module of a Wrangler `--outdir` build (source maps and notes are not uploaded). */
export function measureWorkerOutput(directory) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .filter((path) => /\.(?:m?js|cjs|wasm|bin|txt)$/.test(path) && !/\.map$/.test(path) && !/README\.md$/.test(path));
  let raw = 0;
  let gzip = 0;
  for (const path of files) {
    const bytes = readFileSync(path);
    raw += bytes.byteLength;
    gzip += gzipSync(bytes, { level: 9 }).byteLength;
  }
  return { files: files.map((path) => relative(directory, path)), raw, gzip };
}

export function judgeApiBundle(gzip, budget = API_BUNDLE_BUDGET_BYTES) {
  return { ok: gzip <= budget, headroom: budget - gzip };
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function build(outdir) {
  execFileSync(process.env.SCALIUS_PNPM_BIN ?? "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir], {
    cwd: join(root, "apps/api"),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function main(args) {
  const distIndex = args.indexOf("--dist");
  let directory = distIndex === -1 ? null : resolve(root, args[distIndex + 1] ?? "");
  let temporary = null;
  if (!directory) {
    temporary = mkdtempSync(join(tmpdir(), "scalius-api-bundle-"));
    directory = temporary;
    build(directory);
  } else if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`✗ ${relative(root, directory)} does not exist; build the API first.`);
    process.exit(1);
  }
  try {
    const { files, raw, gzip } = measureWorkerOutput(directory);
    if (files.length === 0) {
      console.error("✗ The API build produced no Worker modules.");
      process.exit(1);
    }
    const verdict = judgeApiBundle(gzip);
    const summary = `API Worker: ${mib(raw)} raw, ${mib(gzip)} gzip (budget ${mib(API_BUNDLE_BUDGET_BYTES)} = Free limit ${mib(FREE_PLAN_COMPRESSED_LIMIT_BYTES)} less ${API_BUNDLE_MARGIN * 100}%)`;
    if (!verdict.ok) {
      console.error(`✗ ${summary}: ${mib(-verdict.headroom)} over. Remove a bundled plugin (pnpm plugin remove) or sandbox it.`);
      process.exit(1);
    }
    console.log(`✓ ${summary}: ${mib(verdict.headroom)} headroom.`);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
