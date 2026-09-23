#!/usr/bin/env node

import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticChunkImports } from "./admin-client-import-graph.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "..");

// The dashboard is a static SPA: every route pays for the JavaScript that
// index.html loads plus that JavaScript's static imports. Route components are
// lazy chunks the router fetches on navigation.
export const shellBudget = { label: "Document shell", maxJavaScript: 4, maxBrotliKiB: 145 };

const forbiddenPrincipalChunkNames = [
  /^html2pdf-.*\.js$/,
  /^TiptapEditor-.*\.js$/,
  /^media-theme-.*\.js$/,
  // html5-qrcode currently emits its browser engine under this name. The
  // scanner route loads it dynamically; the shell must not.
  /^esm-.*\.js$/,
];

function parseArguments(argv) {
  const result = { check: false, repoRoot: defaultRepoRoot };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      result.check = true;
      continue;
    }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      result.repoRoot = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return result;
}

/** Root-relative module scripts and modulepreloads that index.html loads. */
export function collectShellEntries(indexHtml) {
  const entries = new Set();
  for (const tag of indexHtml.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const isModuleScript = /^<script\b/.test(tag) && /\btype="module"/.test(tag);
    const isModulePreload = /^<link\b/.test(tag) && /\brel="modulepreload"/.test(tag);
    const url = tag.match(/\b(?:src|href)="(\/[^"]+\.js)"/)?.[1];
    if ((isModuleScript || isModulePreload) && url) entries.add(url);
  }
  return [...entries];
}

/** The entries plus every chunk they reach through static imports. */
export function collectStaticClosure(entryFiles, readSource) {
  const seen = new Set();
  const pending = [...entryFiles];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...staticChunkImports(file, readSource(file)));
  }
  return [...seen].sort();
}

function measureFiles(files) {
  let rawBytes = 0;
  let brotliBytes = 0;

  for (const filePath of files) {
    if (!existsSync(filePath)) throw new Error(`Shell asset does not exist: ${filePath}`);
    rawBytes += statSync(filePath).size;
    brotliBytes += brotliCompressSync(readFileSync(filePath), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  }

  return { rawBytes, brotliBytes };
}

function formatKiB(bytes) {
  return (bytes / 1024).toFixed(1);
}

export function analyzeAdminClientBundle(repoRoot = defaultRepoRoot) {
  const distDirectory = join(repoRoot, "apps/admin-v2/dist");
  const indexHtml = readFileSync(join(distDirectory, "index.html"), "utf8");
  const entries = collectShellEntries(indexHtml).map((url) => join(distDirectory, url));
  const files = collectStaticClosure(entries, (file) => readFileSync(file, "utf8"));

  return [{
    ...shellBudget,
    files: files.map((file) => `/${relative(distDirectory, file)}`),
    ...measureFiles(files),
  }];
}

export function validateAdminClientBundle(measurements) {
  const failures = [];

  for (const measurement of measurements) {
    if (measurement.files.length > measurement.maxJavaScript) {
      failures.push(
        `${measurement.label} has ${measurement.files.length} JavaScript assets (budget ${measurement.maxJavaScript})`,
      );
    }

    const brotliKiB = measurement.brotliBytes / 1024;
    if (brotliKiB > measurement.maxBrotliKiB) {
      failures.push(
        `${measurement.label} is ${brotliKiB.toFixed(1)} KiB Brotli (budget ${measurement.maxBrotliKiB} KiB)`,
      );
    }

    for (const file of measurement.files) {
      const fileName = file.split("/").at(-1) ?? file;
      if (forbiddenPrincipalChunkNames.some((pattern) => pattern.test(fileName))) {
        failures.push(`${measurement.label} eagerly loads heavy lazy chunk ${fileName}`);
      }
    }
  }

  return failures;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const measurements = analyzeAdminClientBundle(options.repoRoot);

  console.log("Admin client initial (static import) closure:");
  console.table(
    measurements.map((measurement) => ({
      route: measurement.label,
      javascript: measurement.files.length,
      "raw KiB": formatKiB(measurement.rawBytes),
      "Brotli KiB": formatKiB(measurement.brotliBytes),
    })),
  );

  if (options.check) {
    const failures = validateAdminClientBundle(measurements);
    if (failures.length > 0) {
      console.error("Admin client bundle budgets failed:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("Admin client bundle budgets: OK");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
