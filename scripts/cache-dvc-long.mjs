#!/usr/bin/env node
/**
 * Long mode of the DVC differential property test (CACHE-DESIGN §7 item 1):
 * runs apps/api/src/cache-dvc.property.test.ts in parallel vitest processes,
 * each on its own seeds and its own in-memory store, in collect mode, and
 * aggregates their reports. Local only; it touches no remote database.
 *
 *   node scripts/cache-dvc-long.mjs [--workers 4] [--seeds-per-worker 2] [--steps 20000]
 *     [--provider d1|turso] [--prefix long] [--out <dir>] [--rss-stop-mb 3000] [--swap-stop-mb 7000]
 *
 * Each worker runs through /tmp/scalius-heavy.sh when it exists, so workers
 * beyond the host's heavy slots queue instead of piling up.
 *
 * Memory guard: every 5 s it sums the RSS of every process it started (and
 * their children) and reads `sysctl vm.swapusage`; above --rss-stop-mb or
 * --swap-stop-mb it stops every worker and reports what finished. Workers run
 * one after another inside a process (--maxWorkers=1), so RSS grows with
 * --workers only.
 *
 * Replay a failing seed:  DVC_SEED=<seed> DVC_STEPS=<steps> pnpm vitest run apps/api/src/cache-dvc.property.test.ts -t "never serves"
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const HEAVY_GATE = "/tmp/scalius-heavy.sh";

export function parseArgs(argv) {
  const options = {
    workers: 4, seedsPerWorker: 2, steps: 20_000, provider: "d1", prefix: "long",
    out: join(root, ".wrangler", "cache-dvc-long"), rssStopMb: 3000, swapStopMb: 7000, race: "0.02",
  };
  const names = {
    "--workers": "workers", "--seeds-per-worker": "seedsPerWorker", "--steps": "steps", "--provider": "provider",
    "--prefix": "prefix", "--out": "out", "--rss-stop-mb": "rssStopMb", "--swap-stop-mb": "swapStopMb", "--race": "race",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = names[argv[index]];
    if (!key) throw new Error(`Unknown option ${argv[index]}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${argv[index - 1]} needs a value`);
    options[key] = typeof options[key] === "number" ? Number(value) : value;
  }
  return options;
}

/** Refuse to start while the host is already swapping hard (the host memory rule). */
export function refuseToStart(swapUsed, limit) {
  return swapUsed > limit ? `swap used ${swapUsed} MB is above ${limit} MB; start nothing heavy` : null;
}

/** Used swap in MB (macOS `sysctl vm.swapusage`), or 0 where unavailable. */
export function swapUsedMb(text) {
  const match = /used = ([\d.]+)M/.exec(text ?? "");
  return match ? Number(match[1]) : 0;
}

function readSwap() {
  try {
    return swapUsedMb(execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" }));
  } catch {
    return 0;
  }
}

/** RSS in MB of `pids` and all their descendants. */
function treeRssMb(pids) {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  const rows = table.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  const rss = new Map();
  for (const [pid, ppid, kb] of rows) {
    rss.set(pid, kb);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [...pids];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return total / 1024;
}

function killTree(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  const swapAtStart = readSwap();
  const refusal = refuseToStart(swapAtStart, options.swapStopMb);
  if (refusal) {
    console.error(`[dvc-long] ${refusal}`);
    process.exitCode = 2;
    return;
  }
  console.log(`[dvc-long] ${options.workers} workers x ${options.seedsPerWorker} seeds x ${options.steps} steps, provider ${options.provider}; swap used at start ${swapAtStart} MB`);
  const workers = [];
  for (let index = 0; index < options.workers; index += 1) {
    const report = join(options.out, `worker-${index}.json`);
    // Each worker takes a host-wide heavy slot when the gate exists (at most two heavy commands at once).
    const vitest = ["pnpm", "exec", "vitest", "run", "apps/api/src/cache-dvc.property.test.ts", "-t", "never serves", "--maxWorkers=1"];
    const command = existsSync(HEAVY_GATE) ? [HEAVY_GATE, ...vitest] : vitest;
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DVC_MODE: "long",
        DVC_COLLECT: "1",
        DVC_PROVIDER: options.provider,
        DVC_STEPS: String(options.steps),
        DVC_SEEDS: String(options.seedsPerWorker),
        DVC_SEED_PREFIX: options.prefix,
        DVC_SEED_OFFSET: String(index * options.seedsPerWorker),
        DVC_RACE: String(options.race),
        DVC_REPORT: report,
      },
    });
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.startsWith("[DVC progress]") || line.startsWith("[DVC finding]")) console.log(`[w${index}] ${line}`);
      }
    });
    child.stdout.on("data", () => undefined);
    workers.push({ index, child, report, exit: new Promise((done) => child.on("exit", (code) => done(code))) });
  }

  let stopped = null;
  let peakRss = 0;
  let peakSwap = swapAtStart;
  const monitor = setInterval(() => {
    const rss = treeRssMb(workers.map((worker) => worker.child.pid));
    const swap = readSwap();
    peakRss = Math.max(peakRss, rss);
    peakSwap = Math.max(peakSwap, swap);
    if (!stopped && (rss > options.rssStopMb || swap > options.swapStopMb)) {
      stopped = `memory guard: rss ${Math.round(rss)} MB (limit ${options.rssStopMb}), swap used ${swap} MB (limit ${options.swapStopMb})`;
      console.error(`[dvc-long] ${stopped}; stopping every worker`);
      for (const worker of workers) killTree(worker.child.pid);
    }
  }, 5000);
  const codes = await Promise.all(workers.map((worker) => worker.exit));
  clearInterval(monitor);

  const reports = workers.flatMap((worker) => (existsSync(worker.report) ? JSON.parse(readFileSync(worker.report, "utf8")) : []));
  const sum = (pick) => reports.reduce((total, report) => total + pick(report), 0);
  const writes = sum((report) => report.stats.writes);
  const partChecks = sum((report) => report.stats.partChecks);
  const pageReads = sum((report) => report.stats.pageReads);
  const findings = new Map();
  for (const report of reports) {
    for (const finding of report.findings ?? []) {
      const known = findings.get(finding.signature);
      findings.set(finding.signature, { ...finding, count: (known?.count ?? 0) + finding.count, seed: known?.seed ?? report.seed });
    }
  }
  const summary = {
    stopped,
    exitCodes: codes,
    seeds: reports.map((report) => ({ seed: report.seed, steps: report.steps, wallSeconds: Math.round(report.wallSeconds), error: report.error })),
    steps: sum((report) => report.steps),
    writes,
    validatedPartReads: partChecks,
    pageReads,
    operations: writes + partChecks + pageReads,
    freshComparisons: sum((report) => report.stats.partFreshComparisons),
    invalidations: sum((report) => report.stats.partInvalidations),
    spuriousInvalidations: sum((report) => report.stats.partSpuriousInvalidations),
    raceInjections: sum((report) => report.stats.raceInjections),
    peakRssMb: Math.round(peakRss),
    peakSwapMb: peakSwap,
    findings: [...findings.values()].map(({ signature, count, seed }) => ({ signature, count, seed })),
  };
  writeFileSync(join(options.out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  const failed = stopped !== null || findings.size > 0 || reports.some((report) => report.error) || codes.some((code) => code !== 0);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
