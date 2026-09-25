// Process helpers for the fidelity harness: every long-lived child (wrangler,
// its esbuild service and workerd, headless Chrome) is started as the leader
// of its own process group, tracked, and killed as a whole tree on exit.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const tracked = new Map(); // pid -> label

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a detached process group and records it for cleanup. */
export function startGroup(label, command, args, { cwd, env, logFile } = {}) {
  const out = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", out ? "pipe" : "ignore", out ? "pipe" : "ignore"],
  });
  if (out) {
    child.stdout.pipe(out);
    child.stderr.pipe(out);
  }
  tracked.set(child.pid, label);
  child.on("exit", () => tracked.delete(child.pid));
  return child;
}

/** Every descendant pid of `pid` (depth first), read from `ps`. */
export function descendants(pid) {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!c) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(c);
  }
  const out = [];
  const walk = (id) => {
    for (const c of children.get(id) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(pid);
  return out;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills the process group led by `pid` plus every descendant found by walking
 * the tree (a child that called setsid, such as workerd, leaves the group).
 * SIGTERM first, SIGKILL for whatever is still alive after `graceMs`.
 */
export async function killTree(pid, graceMs = 3000) {
  const all = [pid, ...descendants(pid)];
  const signal = (sig) => {
    try { process.kill(-pid, sig); } catch { /* best effort */ }
    for (const p of all) {
      try { process.kill(p, sig); } catch { /* best effort */ }
    }
  };
  signal("SIGTERM");
  const end = Date.now() + graceMs;
  while (Date.now() < end && all.some(alive)) await sleep(100);
  if (all.some(alive)) signal("SIGKILL");
  await sleep(200);
  tracked.delete(pid);
  return all.filter(alive);
}

export async function killAllTracked() {
  const left = [];
  for (const pid of [...tracked.keys()].reverse()) left.push(...(await killTree(pid)));
  return left;
}

export function trackedPids() {
  return [...tracked.keys()];
}

function harnessPids() {
  const pids = [process.pid, ...descendants(process.pid)];
  for (const pid of tracked.keys()) pids.push(pid, ...descendants(pid));
  return [...new Set(pids)];
}

/** Summed resident set (MB) of this process and every tracked tree (counts shared pages once per process). */
export function rssMb(pids = harnessPids()) {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    return Math.round(out.split("\n").reduce((sum, v) => sum + (Number(v.trim()) || 0), 0) / 1024);
  } catch {
    return 0;
  }
}

const UNIT = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 };
/** Summed physical footprint (MB, what Activity Monitor shows) on macOS via `top`; null elsewhere. */
export function footprintMb(pids = harnessPids()) {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("top", ["-l", "1", "-stats", "pid,mem", ...pids.flatMap((p) => ["-pid", String(p)])], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    let total = 0;
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/.exec(line);
      if (m && pids.includes(Number(m[1]))) total += Number(m[2]) * UNIT[m[3]];
    }
    return Math.round(total);
  } catch {
    return null;
  }
}

/**
 * Samples memory every `everyMs`; `stop()` returns the peaks and, for the
 * footprint peak, the share of each tracked process tree.
 */
export function rssSampler(everyMs = 3000) {
  let peakMb = 0;
  let peakFootprintMb = null;
  let breakdown = null;
  const sample = () => {
    const pids = harnessPids();
    peakMb = Math.max(peakMb, rssMb(pids));
    const fp = footprintMb(pids);
    if (fp !== null && fp > (peakFootprintMb ?? 0)) {
      peakFootprintMb = fp;
      breakdown = {};
      for (const [pid, label] of tracked) breakdown[label] = footprintMb([pid, ...descendants(pid)]);
      breakdown.harness = footprintMb([process.pid]);
    }
  };
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return { peakMb, peakFootprintMb, breakdown };
    },
  };
}

/** Used swap in MB (macOS `sysctl vm.swapusage`), or null elsewhere. */
export function swapUsedMb() {
  try {
    const out = execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" });
    const m = /used = ([\d.]+)M/.exec(out);
    return m ? Math.round(Number(m[1])) : null;
  } catch {
    return null;
  }
}

/** Resolves once `url` answers (any status), or throws after `timeoutMs`. */
export async function waitForUrl(url, { timeoutMs = 120000, child } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`process exited (${child.exitCode}) before ${url} answered`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch { /* best effort */ }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** Pids listening on a TCP port (lsof), for the final "ports free" check. */
export function listeners(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map(Number).filter(Boolean);
  } catch {
    return [];
  }
}
