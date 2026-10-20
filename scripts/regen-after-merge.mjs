#!/usr/bin/env node
// Generated files merge themselves (.gitattributes, `merge=scalius-generated`).
// The merge driver only keeps our side and exits 0, so a merge, rebase or
// cherry-pick never stops on a generated file; it never runs a generator,
// because a driver runs per file while other files are still half-merged.
// After the merge, this script rebuilds every generated file from the merged
// sources, in dependency order.
//
//   node scripts/regen-after-merge.mjs            regenerate, list what changed
//   node scripts/regen-after-merge.mjs --check    same, exit 1 when anything changed
//   node scripts/regen-after-merge.mjs --install  define the merge driver in .git/config (once per clone)
//   node scripts/regen-after-merge.mjs --list     print the files the driver covers
//
// After a rebase, run it once at the end and commit the result: replayed
// commits keep the upstream side of every generated file.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

const root = resolve(import.meta.dirname, "..");
export const MERGE_DRIVER = "scalius-generated";

/** The generators, in order: the agent contract feeds the SDK contract and the recipes. */
export const GENERATORS = [
  { name: "API contract and SDK", pnpm: ["generate:sdk"] },
  { name: "Plugin SDK stable contract", node: ["scripts/plugin-contract.mjs"] },
  { name: "CLI recipes", pnpm: ["--filter", "scalius", "generate:recipes"] },
  { name: "Bundled plugins", node: ["scripts/plugins.mjs", "build"] },
  { name: "Dashboard route tree", run: generateRouteTree },
  {
    name: "Plugin SDK ABI declarations",
    pnpm: ["exec", "vitest", "run", "packages/shared/src/plugins/abi.snapshot.test.ts", "--project", "pure", "-u", "-t", "seals the SDK export map"],
  },
];

function git(args, input) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Tracked files whose merge attribute names the generated-file driver. */
export function generatedFiles() {
  const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const out = git(["check-attr", "-z", "--stdin", "merge"], files.join("\0")).split("\0");
  const covered = [];
  for (let index = 0; index + 2 < out.length; index += 3) {
    if (out[index + 2] === MERGE_DRIVER) covered.push(out[index]);
  }
  return covered;
}

function changedGenerated() {
  return new Set(
    git(["status", "--porcelain", "-z", "--", ...generatedFiles()])
      .split("\0")
      .filter(Boolean)
      .map((line) => line.slice(3)),
  );
}

/** TanStack Router's own generator, with the dashboard's Vite plugin options. */
async function generateRouteTree() {
  const appRoot = join(root, "apps/admin-v2");
  const fromPlugin = createRequire(createRequire(join(appRoot, "package.json")).resolve("@tanstack/router-plugin/package.json"));
  const { Generator, getConfig } = await import(pathToFileURL(fromPlugin.resolve("@tanstack/router-generator")).href);
  const config = getConfig({ target: "react", autoCodeSplitting: true }, appRoot);
  await new Generator({ config, root: appRoot }).run();
}

async function runGenerator(generator) {
  console.log(`\n> ${generator.name}`);
  if (generator.run) return generator.run();
  const [command, args] = generator.pnpm ? [resolvePnpmExecutable(), generator.pnpm] : [process.execPath, generator.node];
  const env = { ...process.env };
  delete env.SCALIUS_TEST_PASS; // the ABI test lives in the `pure` project, which both passes would drop
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${generator.name} failed (exit ${result.status ?? result.signal}).`);
}

function install() {
  git(["config", `merge.${MERGE_DRIVER}.name`, "Scalius generated file: keep one side, regenerate after the merge"]);
  // `true` leaves %A (our side) in place and exits 0.
  git(["config", `merge.${MERGE_DRIVER}.driver`, "true"]);
  console.log(`Merge driver ${MERGE_DRIVER} installed. After a merge or rebase run: node scripts/regen-after-merge.mjs`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--install")) return install();
  if (args.includes("--list")) return console.log(generatedFiles().join("\n"));
  const before = changedGenerated();
  for (const generator of GENERATORS) await runGenerator(generator);
  const changed = [...changedGenerated()].filter((file) => !before.has(file));
  if (changed.length === 0) {
    console.log("\nGenerated files are current.");
    return;
  }
  console.log(`\nRegenerated ${changed.length} file(s):\n${changed.map((file) => `  ${file}`).join("\n")}`);
  if (args.includes("--check")) {
    console.error("Generated files were stale; review and commit them.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
