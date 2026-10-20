#!/usr/bin/env node
/**
 * `pnpm test:affected`: only the tests a change can break.
 *
 *   pnpm test:affected                      changes since the upstream (else HEAD), working tree included
 *   pnpm test:affected --base <ref>         changes since <ref> (an agent passes the lead's branch)
 *   pnpm test:affected --list               print the selection, run nothing
 *   pnpm test:affected --base <ref> -- --reporter=dot   extra vitest arguments after --
 *
 * Two sources, unioned:
 * 1. Vitest's own selection (`vitest list --changed <base>`): with
 *    `experimental.recordDependencies` (vitest.config.ts) the modules each
 *    test file actually loaded on its last run, else the static module graph
 *    (a fresh checkout has no records yet, and Vitest would run every file
 *    without one).
 * 2. PATH_RULES below, for inputs the module graph cannot see: migration SQL
 *    (read with fs into the migrated images), the cache-dependency and trigger
 *    generators, the plugin manifest/ABI, and the generated contracts.
 * A change to the test setup itself runs everything. The selection then runs
 * through `scripts/test-runner.mjs`, so the serial files keep their own pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

/** Changes that invalidate every selection: the runner, its config and setup, dependencies. */
export const RUN_EVERYTHING = [
  /^vitest\.config\.ts$/,
  /^scripts\/test-(passes|runner|affected)\.mjs$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^packages\/database\/src\/testing\/migrated-image-setup\.ts$/,
  /^apps\/storefront\/scripts\/test-build-id-setup\.mjs$/,
];

/** Inputs outside the module graph, and the test files they select (path prefixes or exact files). */
export const PATH_RULES = [
  {
    name: "migrations",
    when: [/^packages\/database\/migrations[^/]*\//, /^packages\/database\/src\/migration-artifacts\.ts$/],
    run: ["packages/database/__tests__/", "packages/core/src/modules/", "apps/api/src/cache-dvc."],
    only: /\.d1\.test\.ts$|^packages\/database\/__tests__\/|^apps\/api\/src\/cache-dvc\./,
  },
  {
    name: "cache dependencies and triggers (DVC)",
    when: [
      /^packages\/shared\/src\/cache-deps\.ts$/,
      /^packages\/database\/scripts\/[^/]*triggers?\.ts$/,
      /^packages\/database\/scripts\/cache-dep/,
      /^packages\/core\/src\/cache-deps\//,
    ],
    run: [
      "apps/api/src/cache-dvc.property.test.ts",
      "apps/api/src/cache-dvc.race.test.ts",
      "apps/api/src/cache-deps-",
      "apps/api/src/testing/cache-dvc/",
      "packages/core/src/cache-deps/",
      "packages/database/__tests__/cache-dep",
      "packages/database/__tests__/event-outbox",
      "packages/database/__tests__/trigger-budget.test.ts",
      "packages/database/__tests__/wave-",
    ],
  },
  {
    name: "plugin manifest and ABI",
    when: [
      /^packages\/shared\/src\/plugins\//,
      /^packages\/plugin-sdk\//,
      /^plugins\/[^/]+\/scalius\.plugin\./,
      /^scalius\.plugins\.json$/,
      /^scripts\/plugin[^/]*\.mjs$/,
    ],
    run: ["packages/shared/src/plugins/", "packages/plugin-sdk/", "apps/api/src/plugins/", "plugins/", "scripts/plugin"],
  },
  {
    name: "generated contracts",
    when: [
      /^apps\/api\/src\/generated\//,
      /^apps\/api\/src\/openapi\//,
      /^packages\/api-client\//,
      /^packages\/cli\/src\/generated\//,
      /^packages\/cli\/skills\//,
    ],
    run: ["apps/api/src/openapi/", "packages/cli/test/", "packages/api-client/", "packages/plugin-sdk/src/testing-contract"],
  },
];

const TEST_FILE = /\.test\.(?:c|m)?[jt]sx?$/;

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

export function defaultBase() {
  return process.env.SCALIUS_TEST_BASE || (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) ?? "").trim() || "HEAD";
}

/** Files changed since `base`, the working tree and untracked files included. */
export function changedFiles(base) {
  const diff = git(["diff", "--name-only", base]);
  if (diff === undefined) throw new Error(`git diff ${base} failed; pass --base <ref>.`);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]) ?? "";
  return [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))];
}

/** The rule-selected test files, or "all" when the test setup itself changed. */
export function ruleSelection(changed, testFiles) {
  if (changed.some((file) => RUN_EVERYTHING.some((pattern) => pattern.test(file)))) return { all: true, files: [], rules: ["test setup"] };
  const files = new Set();
  const rules = [];
  for (const rule of PATH_RULES) {
    if (!changed.some((file) => rule.when.some((pattern) => pattern.test(file)))) continue;
    rules.push(rule.name);
    for (const file of testFiles) {
      if (rule.run.some((prefix) => file.startsWith(prefix)) && (!rule.only || rule.only.test(file))) files.add(file);
    }
  }
  // A changed test file always runs.
  for (const file of changed) if (TEST_FILE.test(file) && testFiles.includes(file)) files.add(file);
  return { all: false, files: [...files], rules };
}

function vitestBin() {
  return join(root, "node_modules/.bin/vitest");
}

/** How many test files have a dependency record (Vitest keeps them under node_modules/.vite/vitest/<hash>/). */
export function recordedTestFiles() {
  const directory = join(root, "node_modules/.vite/vitest");
  let recorded = 0;
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const path = join(directory, name, "dependencies.json");
    if (!existsSync(path)) continue;
    try {
      const { projects } = JSON.parse(readFileSync(path, "utf8"));
      recorded = Math.max(recorded, Object.values(projects ?? {}).reduce((sum, project) => sum + Object.keys(project.files ?? {}).length, 0));
    } catch {
      // An unreadable record set counts as none.
    }
  }
  return recorded;
}

/**
 * Vitest's module-graph selection. Vitest runs every file that has no record,
 * so until most files have one (a full `pnpm test` in this checkout), the
 * static graph selects far less.
 */
export function graphSelection(base, testFileCount) {
  const records = recordedTestFiles() >= testFileCount * 0.9;
  const args = ["list", "--changed", base, "--filesOnly", "--json", "--passWithNoTests"];
  if (!records) args.push("--experimental.recordDependencies=false");
  const env = { ...process.env };
  delete env.SCALIUS_TEST_PASS;
  const result = spawnSync(vitestBin(), args, { cwd: root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`vitest list failed:\n${result.stderr || result.stdout}`);
  const start = result.stdout.indexOf("[");
  const listed = start < 0 ? [] : JSON.parse(result.stdout.slice(start));
  return { files: listed.map((entry) => relative(root, entry.file)), recorded: records };
}

async function main() {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const passthrough = separator < 0 ? [] : argv.slice(separator + 1);
  const baseIndex = own.indexOf("--base");
  const base = baseIndex >= 0 ? own[baseIndex + 1] : defaultBase();
  if (!base) throw new Error("--base needs a ref.");
  const listOnly = own.includes("--list");

  const changed = changedFiles(base);
  const testFiles = (git(["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "").split("\n").filter((file) => TEST_FILE.test(file));
  const rules = ruleSelection(changed, testFiles);
  const runner = [join(root, "scripts/test-runner.mjs")];

  if (rules.all) {
    console.log(`test:affected: ${changed.length} changed file(s) since ${base} include the test setup; running everything.`);
    if (listOnly) return;
    process.exitCode = spawnSync(process.execPath, [...runner, ...passthrough], { cwd: root, stdio: "inherit" }).status ?? 1;
    return;
  }
  const graph = changed.length === 0 ? { files: [], recorded: false } : graphSelection(base, testFiles.length);
  const selected = [...new Set([...graph.files, ...rules.files])].sort();
  console.log(
    `test:affected: ${changed.length} changed file(s) since ${base}; ${selected.length} test file(s)`
    + ` (${graph.files.length} from the ${graph.recorded ? "recorded" : "static"} module graph`
    + `${rules.rules.length ? `, rules: ${rules.rules.join(", ")}` : ""}).`,
  );
  if (listOnly) {
    for (const file of selected) console.log(`  ${file}`);
    return;
  }
  if (selected.length === 0) return;
  process.exitCode = spawnSync(process.execPath, [...runner, ...selected, ...passthrough], { cwd: root, stdio: "inherit" }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
