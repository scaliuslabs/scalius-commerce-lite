#!/usr/bin/env node
// The API Worker must stay inside the Workers script size limit. Bundled
// plugins compile into this Worker (apps/api/src/plugins/bundled.gen.ts), so
// every deploy measures the built Worker and fails with a 10% margin to spare.
// `pnpm check:api-bundle` builds into a temporary directory; the deploy passes
// `--dist apps/api/dist` (just built).
//
// The limit (developers.cloudflare.com/workers/platform/limits, checked
// 2026-10-03): 64 MiB of UNCOMPRESSED script on Workers Free and Workers Paid
// alike, with no compressed-size limit. The old 3 MiB (Free) / 10 MiB (Paid)
// compressed limits are gone, so the gate budgets the uncompressed size the
// platform counts and only reports gzip. The Worker's global scope must also
// run within one second at startup (both plans): the size is a coarse proxy
// for it, and the dynamic imports in apps/api/src/worker.ts keep route graphs
// out of that scope.
//
// workerd compiles every JavaScript module of the Worker when an isolate
// starts, whatever runs, so the gate also budgets the JavaScript alone. Large
// data ships as Text modules (generated *.txt, the places dataset), which are
// strings: 14.6 MiB of JavaScript compiled at a cold start became 7.7 MiB
// (2026-10-14), about 80 ms less per new isolate.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");

export const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
/** The superseded Free limit on the compressed size: reported when exceeded, never a failure. */
export const LEGACY_FREE_COMPRESSED_LIMIT_BYTES = 3 * 1024 * 1024;
export const API_BUNDLE_MARGIN = 0.1;
export const API_BUNDLE_BUDGET_BYTES = Math.floor(WORKER_SIZE_LIMIT_BYTES * (1 - API_BUNDLE_MARGIN));
/** JavaScript compiled at every isolate start; data belongs in a Text module. */
export const API_SCRIPT_BUDGET_BYTES = 9 * 1024 * 1024;

/**
 * Every uploaded module of a Wrangler `--outdir` build (source maps, notes and
 * the esbuild metafile are not uploaded); `script` is its JavaScript alone.
 */
export function measureWorkerOutput(directory) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .filter((path) => /\.(?:m?js|cjs|wasm|bin|txt|json)$/.test(path) && !/\.map$/.test(path) && !/(?:^|[\\/])bundle-meta\.json$/.test(path));
  let raw = 0;
  let gzip = 0;
  let script = 0;
  for (const path of files) {
    const bytes = readFileSync(path);
    raw += bytes.byteLength;
    gzip += gzipSync(bytes, { level: 9 }).byteLength;
    if (/\.(?:m?js|cjs)$/.test(path)) script += bytes.byteLength;
  }
  return { files: files.map((path) => relative(directory, path)), raw, gzip, script };
}

/** Judges the uncompressed size, the number the platform limit counts. */
export function judgeApiBundle(raw, budget = API_BUNDLE_BUDGET_BYTES) {
  return { ok: raw <= budget, headroom: budget - raw };
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
    const { files, raw, gzip, script } = measureWorkerOutput(directory);
    if (files.length === 0) {
      console.error("✗ The API build produced no Worker modules.");
      process.exit(1);
    }
    const verdict = judgeApiBundle(raw);
    const summary = `API Worker: ${mib(raw)} uncompressed (${mib(gzip)} gzip), budget ${mib(API_BUNDLE_BUDGET_BYTES)} = the ${mib(WORKER_SIZE_LIMIT_BYTES)} limit of both plans less ${API_BUNDLE_MARGIN * 100}%`;
    if (!verdict.ok) {
      console.error(`✗ ${summary}: ${mib(-verdict.headroom)} over. Remove a bundled plugin (pnpm plugin remove) or sandbox it.`);
      process.exit(1);
    }
    console.log(`✓ ${summary}: ${mib(verdict.headroom)} headroom.`);
    const scriptSummary = `API JavaScript compiled at isolate start: ${mib(script)}, budget ${mib(API_SCRIPT_BUDGET_BYTES)}`;
    if (script > API_SCRIPT_BUDGET_BYTES) {
      console.error(`✗ ${scriptSummary}. Ship large data as a Text module (a generated *.txt import) instead of a JavaScript literal.`);
      process.exit(1);
    }
    console.log(`✓ ${scriptSummary}.`);
    if (gzip > LEGACY_FREE_COMPRESSED_LIMIT_BYTES) {
      console.warn(`! ${mib(gzip)} gzip is above the 3 MiB compressed limit Workers Free used to have; the current limits page has no compressed limit, so this is only a note.`);
    }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
