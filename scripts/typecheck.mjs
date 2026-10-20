#!/usr/bin/env node
// Workspace typecheck: one TypeScript 7 build over every TypeScript project
// (project references, so shared, database, core, plugin-sdk and api-client
// are checked once and their dependants read declarations), then the
// storefront's `astro check` (Volar, TypeScript 6) for the .astro files.
//
//   node scripts/typecheck.mjs            # everything
//   node scripts/typecheck.mjs --no-astro # TypeScript projects only
//   node scripts/typecheck.mjs --force    # ignore the incremental build info
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipAstro = args.includes("--no-astro");
const tscArgs = args.filter((arg) => arg !== "--no-astro");

// Every workspace project with a tsconfig, except the storefront (astro check)
// and the shared tsconfig package. New plugins join automatically.
const projects = ["apps", "packages", "plugins"]
  .flatMap((group) => readdirSync(join(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${group}/${entry.name}`))
  .filter((project) => project !== "apps/storefront" && project !== "packages/tsconfig")
  .filter((project) => existsSync(join(root, project, "tsconfig.json")))
  .sort();

function run(command, commandArgs, cwd = root) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  console.log(`[typecheck] ${[command, ...commandArgs].join(" ").replace(root + "/", "")}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result.status ?? 1;
}

// Two builders × two checkers stays well inside a 16 GB machine.
const tsc = join(root, "node_modules/typescript7/bin/tsc");
let status = run(process.execPath, [tsc, "--build", "--builders", "2", "--checkers", "2", ...tscArgs, ...projects]);
if (status === 0 && !skipAstro) {
  status = run(resolvePnpmExecutable(), ["--filter", "@scalius/storefront", "typecheck"]);
}
process.exit(status);
