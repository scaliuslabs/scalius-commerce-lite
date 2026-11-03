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
 *    generators, the plugin manifest/ABI, the generated contracts, and the
 *    rulebook's scenario tables and drivers.
 * A change to the test setup itself runs everything. A lockfile or workspace
 * `package.json` change selects the tests of the changed packages and of the
 * packages that link them (`scripts/lockfile-impact.mjs`); only an unreadable
 * lockfile, a change to the root dependencies or the root `package.json` runs
 * everything. The selection then runs
 * through `scripts/test-runner.mjs`, so the serial files keep their own pass.
 * Suites under their own Vitest config (`tests/invariants/`) are not collected
 * here: CI runs the ones a rule cites through `node rules/cli.mjs impact` and
 * `test`, and every cited one in the weekly `verify`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { importerNames, lockImpact, parseLock, testsOfImporters, withDependents } from "./lockfile-impact.mjs";

const root = resolve(import.meta.dirname, "..");

/**
 * Changes that invalidate every selection: the runner, its config and setup, the
 * root manifest. The lockfile and workspace manifests are not here: they select
 * by package (`dependencySelection`), and `forceRerunTriggers` in
 * vitest.config.ts keeps Vitest from running everything for a `package.json`.
 */
export const RUN_EVERYTHING = [
  /^vitest\.config\.ts$/,
  /^scripts\/test-(passes|runner|affected)\.mjs$/,
  /^package\.json$/,
  /^packages\/database\/src\/testing\/migrated-image-setup\.ts$/,
  /^apps\/storefront\/scripts\/test-build-id-setup\.mjs$/,
];

/** Inputs outside the module graph, and the test files they select (path prefixes or exact files). */
export const PATH_RULES = [
  {
    // The clock policy reads code under these roots, including non-test support harnesses.
    name: "SQLite fixture clocks",
    when: [/^(?:apps|packages|tests)\/.*\.[cm]?[jt]sx?$/],
    run: ["packages/database/__tests__/sqlite-clock.test.ts"],
  },
  {
    // The policy discovers native-store consumers with filesystem reads, outside the import graph.
    name: "native PostgreSQL test-store lifetimes",
    when: [/\.test\.(?:c|m)?[jt]sx?$/, /^packages\/database\/src\/testing\/postgres-native\.ts$/],
    run: ["packages/database/__tests__/native-postgres-lifetime-policy.test.ts"],
  },
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
    // The runner reads each scenario table with fs and imports its driver by name.
    name: "rulebook scenarios",
    when: [/^rules\/[a-z]+\/[^/]+\.scenarios\.yaml$/, /^rules\/drivers\//],
    run: ["rules/scenarios.test.ts"],
  },
  {
    // The self-tests spawn the CLI; the domains file shapes coverage.
    name: "rulebook tooling",
    when: [/^rules\/(?:rulebook|cli)\.mjs$/, /^rules\/domains\.yaml$/],
    run: ["rules/rulebook.test.ts", "rules/scenarios.test.ts"],
  },
  {
    // The test reads the budgets file and the generated table in docs/SCALE.md with fs and a
    // dynamic import, outside the module graph.
    name: "Free plan budgets and their table",
    when: [/^apps\/api\/src\/testing\/free-plan-budgets\.ts$/, /^docs\/SCALE\.md$/, /^scripts\/free-plan-budget\.mjs$/],
    run: ["scripts/free-plan-budget.test.mjs"],
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

/**
 * The tests of the packages a lockfile or workspace `package.json` change
 * reaches. `lock` carries the lockfile text at the base (`base`) and now
 * (`head`); without the head the packages are unknown and everything runs.
 * Returns undefined when no dependency file changed.
 */
export function dependencySelection(changed, testFiles, lock = {}) {
  const lockChanged = changed.includes("pnpm-lock.yaml");
  const head = parseLock(lock.head);
  const names = head ? importerNames(head) : [];
  const manifests = names.filter((name) => name !== "." && changed.includes(`${name}/package.json`));
  const stray = changed.some((file) => /^(?:apps|packages|plugins)\/[^/]+\/package\.json$/.test(file) && !names.includes(file.slice(0, -"/package.json".length)));
  if (!lockChanged && manifests.length === 0 && !stray) return undefined;
  const rule = lockChanged ? "pnpm lockfile" : "workspace package.json";
  if (!head) return { all: true, files: [], rule, reason: "the lockfile could not be read" };
  if (stray) return { all: true, files: [], rule, reason: "a workspace package.json is not in the lockfile" };
  const importers = new Set(manifests);
  if (lockChanged) {
    const impact = lockImpact(lock.base, lock.head);
    if (impact.all) return { all: true, files: [], rule, reason: impact.reason };
    if (impact.rootDirect) return { all: true, files: [], rule, reason: "a root dependency changed" };
    for (const name of impact.importers) importers.add(name);
  }
  return { all: false, files: testsOfImporters(withDependents(importers, head), names, testFiles), rule };
}

/** The rule-selected test files, or "all" when the test setup itself changed. */
export function ruleSelection(changed, testFiles, options = {}) {
  if (changed.some((file) => RUN_EVERYTHING.some((pattern) => pattern.test(file)))) return { all: true, files: [], rules: ["test setup"] };
  const files = new Set();
  const rules = [];
  const dependencies = dependencySelection(changed, testFiles, options.lock);
  if (dependencies?.all) return { all: true, files: [], rules: [`dependencies: ${dependencies.reason}`] };
  if (dependencies) {
    rules.push(dependencies.rule);
    for (const file of dependencies.files) files.add(file);
  }
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

/** The lockfile at the base and now, read only when a dependency file changed. */
function lockTexts(base, changed) {
  if (!changed.some((file) => file === "pnpm-lock.yaml" || /(^|\/)package\.json$/.test(file))) return {};
  const path = join(root, "pnpm-lock.yaml");
  return { head: existsSync(path) ? readFileSync(path, "utf8") : undefined, base: git(["show", `${base}:pnpm-lock.yaml`]) };
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
  const rules = ruleSelection(changed, testFiles, { lock: lockTexts(base, changed) });
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
