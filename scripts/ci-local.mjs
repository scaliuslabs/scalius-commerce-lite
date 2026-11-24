#!/usr/bin/env node
/**
 * `pnpm ci:local`: every job of `.github/workflows/ci.yml` on this machine, one
 * step at a time, in the workflow's order. GitHub Actions does not run for this
 * repository's account, so this is the CI.
 *
 *   pnpm ci:local                 the broad run: gates, full suite, every rule's proof, builds
 *   pnpm ci:local --quick         the gates only (no full suite, no rulebook proof, no builds)
 *   pnpm ci:local --only lint,typecheck
 *   pnpm ci:local --skip rulebook
 *   pnpm ci:local --from suite    resume at a step
 *   pnpm ci:local --base <ref>    change base for the rulebook checks (default origin/mono-repo)
 *   pnpm ci:local --stop          stop at the first failing step (default: run them all)
 *   pnpm ci:local --list
 *
 * Each step's output goes to `node_modules/.cache/ci-local/<run>/<step>.log`; the
 * summary prints every step's real exit code and the run exits 1 if any failed.
 * PostgreSQL 15 for the suites that need it is a throwaway local cluster, started
 * here and removed afterwards, unless `SCALIUS_TEST_POSTGRES_URL` already names one.
 * One run at a time: this is the heavy gate runner (16 GB host).
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The five-seed collecting cache gate AGENTS.md requires; inert for every other proof.
const DVC = { DVC_SEEDS: "5", DVC_COLLECT: "1", DVC_TIMEOUT_MS: "900000" };

/** The workflow's steps in its order. `broad`: left out of `--quick`. `postgres`: needs the server. */
export function ciSteps({ base, scripts }) {
  const steps = [
    { id: "hygiene", name: "Repository hygiene", cmd: "node scripts/repository-hygiene.mjs" },
    { id: "whitespace", name: "Whitespace guard", cmd: "git show --check --format= --no-renames HEAD" },
    { id: "install", name: "Install dependencies", cmd: "pnpm install --frozen-lockfile" },
    { id: "audit", name: "Dependency audit", cmd: "pnpm audit --audit-level moderate" },
    { id: "env", name: "Worker env binding guard", cmd: "pnpm check:env" },
    { id: "migrations", name: "Migration metadata guard", cmd: "pnpm --filter @scalius/database check:migrations" },
    { id: "regen", name: "Generated file freshness", cmd: "pnpm regen:check" },
    { id: "lint", name: "Lint", cmd: "pnpm lint" },
    { id: "typecheck", name: "Typecheck", cmd: "pnpm typecheck" },
    {
      id: "rules",
      name: "Rulebook check",
      cmd: `node rules/cli.mjs check --base ${base} && node rules/cli.mjs coverage --enforce --base ${base}`,
    },
    { id: "impact", name: "Rule impact", cmd: `node rules/cli.mjs impact --base ${base} --enforce` },
    { id: "suite", name: "Full test suite", cmd: "pnpm test:ci", broad: true, postgres: true },
    {
      id: "rulebook",
      name: "Rulebook proof",
      cmd: "node rules/cli.mjs verify --strict --require postgres --max-workers 3",
      env: DVC,
      broad: true,
      postgres: true,
    },
  ];
  if (scripts["test:private-pages"]) {
    steps.push({ id: "private-pages", name: "Private pages, rendered", cmd: "pnpm test:private-pages", broad: true });
  }
  steps.push(
    { id: "build", name: "Build", cmd: "pnpm build", broad: true },
    { id: "dry-run", name: "API deploy dry-run", cmd: "pnpm run deploy:api -- --dry-run --skip-verified", broad: true },
    { id: "dist-secrets", name: "Dist secret guard", cmd: "pnpm check:dist-secrets", broad: true },
    { id: "canaries", name: "Build canary guard", cmd: "pnpm check:build-canaries", broad: true },
    // Both measure the build on disk, so they follow the build step.
    { id: "storefront-budgets", name: "Storefront size budgets", cmd: "pnpm check:storefront-budgets", broad: true },
    { id: "admin-budgets", name: "Dashboard bundle budgets", cmd: "pnpm check:admin-perf", broad: true },
    // Not a CI job: the public repository is this one filtered (no tests, no rulebook), and a
    // gate that passes here can fail there (a policy that names a stripped file did, on beta 7).
    { id: "public-build", name: "Public copy builds", cmd: "node internal/export/export.mjs --check --build", broad: true },
    { id: "clean", name: "Working tree cleanliness", cmd: "git diff --exit-code" },
  );
  return steps;
}

/** Which steps a run takes, from its flags. Throws on a step id that does not exist. */
export function selectSteps(steps, { quick, only, skip, from }) {
  const ids = new Set(steps.map((step) => step.id));
  for (const id of [...(only ?? []), ...(skip ?? []), ...(from ? [from] : [])]) {
    if (!ids.has(id)) throw new Error(`No step "${id}". Steps: ${[...ids].join(", ")}`);
  }
  let chosen = steps;
  if (from) chosen = chosen.slice(chosen.findIndex((step) => step.id === from));
  if (only) return chosen.filter((step) => only.includes(step.id));
  if (quick) chosen = chosen.filter((step) => !step.broad);
  if (skip) chosen = chosen.filter((step) => !skip.includes(step.id));
  return chosen;
}

export function parseArgs(argv) {
  const options = { base: "origin/mono-repo", quick: false, stop: false, list: false };
  const list = (value) => value.split(",").map((id) => id.trim()).filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[(index += 1)];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--quick") options.quick = true;
    else if (arg === "--stop") options.stop = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--only") options.only = list(value());
    else if (arg === "--skip") options.skip = list(value());
    else if (arg === "--from") options.from = value();
    else if (arg === "--base") options.base = value();
    else throw new Error(`Unknown option ${arg}. See the header of scripts/ci-local.mjs.`);
  }
  return options;
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function postgresBin() {
  const candidates = ["/opt/homebrew/opt/postgresql@15/bin", "/usr/local/opt/postgresql@15/bin", "/usr/lib/postgresql/15/bin"];
  const found = candidates.find((dir) => existsSync(join(dir, "initdb")));
  if (found) return found;
  const onPath = spawnSync("sh", ["-c", "command -v initdb"], { encoding: "utf8" }).stdout.trim();
  return onPath ? dirname(onPath) : null;
}

/** A throwaway PostgreSQL 15 cluster; `stop()` ends it and deletes its files. */
async function startPostgres(logDir) {
  const bin = postgresBin();
  if (!bin) throw new Error("PostgreSQL 15 not found (brew install postgresql@15), and SCALIUS_TEST_POSTGRES_URL is not set.");
  const data = mkdtempSync(join(tmpdir(), "scalius-ci-pg-"));
  const port = await freePort();
  // LC_ALL=C on both: without it the server refuses to start on macOS, and without -E UTF8 the suites fail.
  const env = { ...process.env, LC_ALL: "C" };
  const run = (file, args) => spawnSync(join(bin, file), args, { env, encoding: "utf8" });
  const init = run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--locale=C", "-E", "UTF8"]);
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  const start = run("pg_ctl", ["-D", data, "-l", join(logDir, "postgres.log"), "-w", "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "start"]);
  if (start.status !== 0) throw new Error(`PostgreSQL did not start: ${start.stderr || start.stdout}`);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      rmSync(data, { recursive: true, force: true });
    },
  };
}

function runStep(step, env, logFile) {
  return new Promise((done) => {
    const log = createWriteStream(logFile);
    const child = spawn("sh", ["-c", step.cmd], { cwd: root, env: { ...env, ...step.env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("close", (code, signal) => log.end(() => done(code ?? (signal ? 128 : 1))));
  });
}

const minutes = (ms) => `${(ms / 60000).toFixed(1)} min`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const steps = selectSteps(ciSteps({ base: options.base, scripts }), options);
  if (options.list) {
    for (const step of steps) console.log(`${step.id.padEnd(20)} ${step.name}${step.broad ? "  (broad)" : ""}`);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(root, "node_modules", ".cache", "ci-local", stamp);
  mkdirSync(logDir, { recursive: true });
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  console.log(`ci:local on ${head}, ${steps.length} steps, logs in ${logDir}`);

  const env = { ...process.env, CI: "true" };
  let postgres = null;
  const cleanup = () => {
    if (postgres) postgres.stop();
    postgres = null;
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  const results = [];
  try {
    for (const step of steps) {
      if (step.postgres && !env.SCALIUS_TEST_POSTGRES_URL) {
        postgres = await startPostgres(logDir);
        env.SCALIUS_TEST_POSTGRES_URL = postgres.url;
      }
      const started = Date.now();
      process.stdout.write(`▶ ${step.name} ... `);
      const exit = await runStep(step, env, join(logDir, `${step.id}.log`));
      const took = Date.now() - started;
      results.push({ id: step.id, name: step.name, exit, ms: took });
      console.log(`${exit === 0 ? "ok" : `FAILED (exit ${exit})`} in ${minutes(took)}`);
      if (exit !== 0 && options.stop) break;
    }
  } finally {
    cleanup();
  }

  const failed = results.filter((result) => result.exit !== 0);
  const notRun = steps.length - results.length;
  writeFileSync(join(logDir, "summary.json"), `${JSON.stringify({ head, base: options.base, results, notRun }, null, 2)}\n`);
  console.log("");
  for (const result of results) {
    console.log(`${result.exit === 0 ? "✓" : "✗"} ${result.name.padEnd(28)} exit ${String(result.exit).padEnd(3)} ${minutes(result.ms)}`);
  }
  if (notRun > 0) console.log(`${notRun} step(s) not run.`);
  if (failed.length > 0) {
    console.log(`\n${failed.length} failed. Read: ${failed.map((result) => join(logDir, `${result.id}.log`)).join("  ")}`);
    return 1;
  }
  console.log(notRun > 0 ? "\nStopped early." : `\nAll ${results.length} steps passed on ${head}.`);
  return notRun > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
