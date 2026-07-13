#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assessAndStageAssets, writeReadinessReport } from "./stage-assets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  manifest: path.join(here, "asset-sources.json"),
  sourceDir: path.join(here, "source"),
  outputDir: path.resolve(".wrangler/demo-store-assets/staged"),
  report: path.resolve(".wrangler/demo-store-assets/readiness.json"),
};

function parseArgs(argv) {
  const options = { ...defaults, stage: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report-only") continue;
    if (arg === "--stage") { options.stage = true; continue; }
    if (["--manifest", "--source-dir", "--output-dir", "--report"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a path`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const sourceManifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const report = await assessAndStageAssets({ sourceManifest, ...options });
  await writeReadinessReport(options.report, report);
  process.stdout.write(`${JSON.stringify({
    ready: report.ready,
    summary: report.summary,
    progress: {
      assets: report.progress.assets,
      products: report.progress.products,
      categories: report.progress.categories,
      heroes: report.progress.heroes,
      remainingOwners: report.progress.remainingByOwner.length,
    },
    report: options.report,
  }, null, 2)}\n`);
  if (!report.ready) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
