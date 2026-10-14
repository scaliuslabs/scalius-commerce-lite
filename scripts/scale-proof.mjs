#!/usr/bin/env node
// The scale proof: what the platform costs and how fast it answers at 1M orders and ~150k SKUs, on D1 (the
// local SQLite engine of workerd) and on native PostgreSQL, from a seeded store. Local only, never run in CI
// (the CI form is apps/api/src/write-scaling.test.ts and the budgets of apps/api/src/free-plan-budget.test.ts).
//
//   node scripts/scale-proof.mjs --state /ABSOLUTE/dir --seed         build the store once (~30 min, ~6 GB), then measure
//   node scripts/scale-proof.mjs --state /ABSOLUTE/dir                measure D1 and PostgreSQL (~20 min)
//   node scripts/scale-proof.mjs --state /ABSOLUTE/dir --providers d1 --orders 100 --json out.json
//   node scripts/scale-proof.mjs --state /ABSOLUTE/dir --write-doc    also write the table into docs/SCALE.md
//
// The seeded state is never written: D1 runs on an APFS/reflink clone of it, PostgreSQL on a temporary cluster
// (initdb and pg_ctl on PATH) loaded from a clone of the same SQLite file. Both are deleted at the end, and
// every process the run started is stopped. The measuring itself is scripts/scale-proof.test.ts.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const DOC = join(root, "docs", "SCALE.md");
const MARKERS = ["<!-- scale-proof:start -->", "<!-- scale-proof:end -->"];

export function parseArgs(argv) {
  const options = { state: null, seed: false, providers: ["d1", "postgres"], orders: 150, json: null, writeDoc: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state") options.state = argv[(index += 1)] ?? null;
    else if (arg === "--seed") options.seed = true;
    else if (arg === "--providers") options.providers = (argv[(index += 1)] ?? "").split(",").filter(Boolean);
    else if (arg === "--orders") options.orders = Number(argv[(index += 1)]);
    else if (arg === "--json") options.json = argv[(index += 1)] ?? null;
    else if (arg === "--write-doc") options.writeDoc = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.state || !options.state.startsWith("/")) throw new Error("--state needs an absolute directory outside the repository");
  if (options.state.startsWith(`${root}/`)) throw new Error("--state must be outside the repository");
  if (options.providers.some((provider) => !["d1", "postgres"].includes(provider)) || options.providers.length === 0) throw new Error("--providers is d1, postgres or both");
  if (!Number.isInteger(options.orders) || options.orders < 5) throw new Error("--orders must be an integer of at least 5");
  return options;
}

const fmt = (value, digits = 0) => (typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "-");

/** The markdown tables of one run's results (a result per provider, as scripts/scale-proof.test.ts writes it). */
export function renderResults(results) {
  const lines = [];
  const store = results[0]?.store;
  if (store) {
    lines.push(`Store: ${fmt(store.orders)} orders, ${fmt(store.orderItems)} order lines, ${fmt(store.products)} products, ${fmt(store.skus)} SKUs, ${fmt(store.customers)} customers.`, "");
  }
  lines.push("Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):", "");
  lines.push(`| Read | ${results.map((r) => `${r.provider} p50 | ${r.provider} p95 | ${r.provider} rows read`).join(" | ")} |`);
  lines.push(`| --- | ${results.map(() => "---: | ---: | ---:").join(" | ")} |`);
  const names = [...new Set(results.flatMap((r) => (r.reads ?? []).map((read) => read.name)))];
  for (const name of names) {
    const cells = results.map((r) => {
      const read = (r.reads ?? []).find((entry) => entry.name === name);
      return read ? `${fmt(read.p50)}${read.status === 200 ? "" : ` (HTTP ${read.status})`} | ${fmt(read.p95)} | ${fmt(read.rowsRead)}` : "- | - | -";
    });
    lines.push(`| ${name} | ${cells.join(" | ")} |`);
  }
  lines.push("", "Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:", "");
  lines.push("| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of results) {
    for (const row of r.checkout ?? []) {
      const failed = Object.values(row.failures ?? {}).reduce((sum, count) => sum + count, 0);
      const codes = Object.keys(row.failures ?? {}).join("/");
      lines.push(`| ${r.provider} | ${row.scenario} | ${row.clients} | ${fmt(row.orders)} | ${fmt(row.ordersPerSecond, 1)} | ${fmt(row.p50)} | ${fmt(row.p95)} | ${failed ? `${failed} (HTTP ${codes})` : "0"} | ${row.retries ?? "n/a"} |`);
    }
  }
  lines.push("", "Rows one 3-line checkout reads and writes (quote, commit, after-response work):", "");
  lines.push("| Engine | Rows read | Rows written | Counted as |", "| --- | ---: | ---: | --- |");
  for (const r of results) {
    if (r.perOrder) lines.push(`| ${r.provider} | ${fmt(r.perOrder.rowsRead)} | ${fmt(r.perOrder.rowsWritten)} | ${r.provider === "d1" ? "D1 `rows_read`/`rows_written`, index entries included (what D1 bills)" : "heap tuples read, inserted, updated, deleted; index entries not counted"} |`);
  }
  return lines.join("\n");
}

function machine() {
  const model = cpus()[0]?.model ?? "unknown CPU";
  return `${model}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB RAM, ${platform()} ${release()}, Node ${process.version}`;
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").slice(-1500)}`);
  return result.stdout;
};

/** The block docs/SCALE.md carries: the run's tables with the date, machine and commit. */
export function docBlock(results, meta) {
  return [
    MARKERS[0],
    `Measured ${meta.date} at commit \`${meta.commit}\` on ${meta.machine}.`,
    `Engines: ${results.map((r) => r.engine).join("; ")}.`,
    "",
    renderResults(results),
    MARKERS[1],
  ].join("\n");
}

export function replaceDocBlock(doc, block) {
  const start = doc.indexOf(MARKERS[0]);
  const end = doc.indexOf(MARKERS[1]);
  if (start === -1 || end === -1) throw new Error(`${DOC} has no ${MARKERS[0]} ... ${MARKERS[1]} block`);
  return doc.slice(0, start) + block + doc.slice(end + MARKERS[1].length);
}

function d1File(state) {
  const dir = join(state, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite") : [];
  if (files.length !== 1) throw new Error(`Expected one D1 database in ${dir}, found ${files.length}. Seed the state first: --seed.`);
  return join(dir, files[0]);
}

/** A copy-on-write clone where the filesystem has one (APFS, btrfs, xfs), else a copy. */
function clone(from, to) {
  const reflink = spawnSync("cp", platform() === "darwin" ? ["-cR", from, to] : ["-R", "--reflink=auto", from, to]);
  if (reflink.status !== 0) cpSync(from, to, { recursive: true });
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function vitest(file, env) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", file, "--silent=false", "--maxWorkers=1", "--testTimeout=7200000", "--hookTimeout=7200000"], {
    cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${file} failed (${result.status})`);
}

function seed(state) {
  mkdirSync(state, { recursive: true });
  run("node", ["scripts/deploy.mjs", "--migrate-only", "--local"], { env: { ...process.env, SCALIUS_WRANGLER_STATE: state } });
  const child = spawnSync("node", ["scripts/catalog-scale-seed.mjs", "--state", state, "--profile", "huge"], { cwd: root, stdio: "inherit" });
  if (child.status !== 0) throw new Error("The seed failed");
}

function measureD1(options, scratch) {
  const work = join(scratch, "d1-state");
  const out = join(scratch, "d1.json");
  clone(options.state, work);
  try {
    vitest("scripts/scale-proof.test.ts", { SCALE_PROOF_STATE: work, SCALE_PROOF_ORDERS: String(options.orders), SCALE_PROOF_OUT: out });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

async function measurePostgres(options, scratch) {
  const data = join(scratch, "pgdata");
  const port = await freePort();
  const env = { ...process.env, LC_ALL: "en_US.UTF-8" };
  const plain = join(scratch, "plain.sqlite");
  clone(d1File(options.state), plain);
  // The Miniflare file carries its own metadata table (a BLOB column the portable export refuses).
  const sqlite = new DatabaseSync(plain);
  sqlite.exec("DROP TABLE IF EXISTS _cf_METADATA");
  sqlite.close();
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { env });
  let started = false;
  try {
    run("pg_ctl", ["-D", data, "-o", `-p ${port} -k ${scratch} -c listen_addresses=127.0.0.1 -c shared_buffers=1GB -c max_connections=200`, "-l", join(scratch, "pg.log"), "-w", "start"], { env });
    started = true;
    run("psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-c", "CREATE DATABASE scale_proof"], { env });
    const url = `postgres://postgres@127.0.0.1:${port}/scale_proof`;
    run("pnpm", ["--dir", "apps/api", "exec", "tsx", "../../packages/database/scripts/migrate-sqlite-to-postgres.ts", "--sqlite", plain, "--checkpoint", join(scratch, "pg-checkpoint.json"), "--ack-target-host", "127.0.0.1"], { env: { ...env, POSTGRES_DATABASE_URL: url } });
    rmSync(plain, { force: true });
    const out = join(scratch, "pg.json");
    vitest("scripts/scale-proof.test.ts", { SCALE_PROOF_POSTGRES_URL: url, SCALE_PROOF_ORDERS: String(options.orders), SCALE_PROOF_OUT: out });
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    if (started) spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"], { env });
    rmSync(data, { recursive: true, force: true });
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.seed) seed(options.state);
  const scratch = mkdtempSync(join(tmpdir(), "scalius-scale-proof-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cleanup(); process.exit(130); });
  try {
    const results = [];
    if (options.providers.includes("d1")) results.push(measureD1(options, scratch));
    if (options.providers.includes("postgres")) results.push(await measurePostgres(options, scratch));
    const meta = {
      date: new Date().toISOString().slice(0, 10),
      commit: run("git", ["rev-parse", "--short", "HEAD"]).trim(),
      machine: machine(),
    };
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ meta, results }, null, 2)}\n`);
    console.log(`\n${docBlock(results, meta)}\n`);
    if (options.writeDoc) writeFileSync(DOC, replaceDocBlock(readFileSync(DOC, "utf8"), docBlock(results, meta)));
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
