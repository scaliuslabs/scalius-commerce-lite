#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { discoverCommonsCandidates } from "./discovery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let planPath = path.join(here, "queries.json");
let outputPath = path.resolve(".wrangler/demo-store-assets/commons-review.json");
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  const value = process.argv[++index];
  if (!value || !["--plan", "--output"].includes(arg)) throw new Error("Usage: cli.mjs [--plan path] [--output path]");
  if (arg === "--plan") planPath = path.resolve(value);
  else outputPath = path.resolve(value);
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (plan.schemaVersion !== 1) throw new Error("Commons query plan must use schemaVersion 1");
const queue = await discoverCommonsCandidates({ queries: plan.queries });
await mkdir(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await rename(temporary, outputPath);
process.stdout.write(`${JSON.stringify({ output: outputPath, summary: queue.summary }, null, 2)}\n`);
