#!/usr/bin/env node
/**
 * The local mailbox (Mailpit): one shared service for every local stack on
 * this machine, never owned by one of them. The API Worker sends local mail
 * to it (`LOCAL_MAILPIT_URL` in apps/api/wrangler.local.jsonc), so it listens
 * on fixed loopback ports whichever stack runs.
 *
 * `ensure` reuses a mailbox that answers, or starts Mailpit detached: in its
 * own session and process group, with no terminal and no parent waiting on
 * it. A stack that stops (Ctrl+C reaches its whole process group, and
 * scripts/dev.sh stops each process it started) therefore never takes the
 * mailbox from the other stacks. It keeps running until stopped by hand:
 *
 *   node scripts/dev-mailbox.mjs ensure   # scripts/dev.sh runs this
 *   node scripts/dev-mailbox.mjs stop     # when no stack needs it any more
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LOCAL_MAILBOX = Object.freeze({
  url: "http://127.0.0.1:8025",
  listen: "127.0.0.1:8025",
  smtp: "127.0.0.1:1025",
});

/** Mailpit's arguments for the shared mailbox. */
export function mailpitArgs(mailbox = LOCAL_MAILBOX) {
  return ["--listen", mailbox.listen, "--smtp", mailbox.smtp, "--max", "100", "--max-age", "24h", "--quiet"];
}

/** True when a mailbox answers at `url`. */
export async function mailboxReady(url = LOCAL_MAILBOX.url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${url}/api/v1/info`, { signal: AbortSignal.timeout(1000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reuses the mailbox or starts it detached; `{ started: false }` or
 * `{ started: true, pid }`. Throws when Mailpit is missing or does not answer
 * within `timeoutSeconds`.
 */
export async function ensureMailbox({
  mailbox = LOCAL_MAILBOX,
  command = "mailpit",
  timeoutSeconds = 10,
  logFile = join(tmpdir(), "scalius-mailpit.log"),
  fetchImpl = fetch,
} = {}) {
  if (await mailboxReady(mailbox.url, fetchImpl)) return { started: false };

  mkdirSync(join(logFile, ".."), { recursive: true });
  const log = openSync(logFile, "a");
  let child;
  try {
    child = spawn(command, mailpitArgs(mailbox), { detached: true, stdio: ["ignore", log, log] });
  } finally {
    closeSync(log);
  }
  const exited = new Promise((done) => {
    child.once("error", (error) => done(error));
    child.once("exit", (code, signal) => done(new Error(`Mailpit exited before its API was ready (${signal ?? `exit ${code}`}); see ${logFile}.`)));
  });
  // Nothing here waits on it: it outlives this process and every stack.
  child.unref();

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const failure = await Promise.race([exited, new Promise((done) => setTimeout(() => done(null), 250))]);
    if (failure) {
      if (failure.code === "ENOENT") {
        throw new Error("Mailpit is required for local email and OTP testing. Install it with 'brew install mailpit' on macOS or follow https://mailpit.axllent.org/docs/install/.");
      }
      throw failure;
    }
    if (await mailboxReady(mailbox.url, fetchImpl)) return { started: true, pid: child.pid };
  }
  throw new Error(`Mailpit did not answer at ${mailbox.url} within ${timeoutSeconds}s; see ${logFile}.`);
}

/** Stops the Mailpit listening on the mailbox's web port (a manual action; stacks never call it). */
export function stopMailbox(mailbox = LOCAL_MAILBOX) {
  const port = mailbox.listen.split(":").pop();
  const listed = spawnSync("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t", "-c", "mailpit"], { encoding: "utf8" });
  const pids = (listed.stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
  for (const pid of pids) process.kill(pid, "SIGTERM");
  return pids;
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "ensure") {
    const raw = process.env.SCALIUS_DEV_MAILPIT_READY_TIMEOUT_SECONDS ?? "10";
    if (!/^\d+$/.test(raw)) throw new Error(`SCALIUS_DEV_MAILPIT_READY_TIMEOUT_SECONDS must be a non-negative integer, got '${raw}'.`);
    const result = await ensureMailbox({ timeoutSeconds: Number(raw) });
    console.log(result.started
      ? `Local mailbox started at ${LOCAL_MAILBOX.url} (shared by every local stack; stop it with node scripts/dev-mailbox.mjs stop).`
      : "Local mailbox is already ready.");
    return;
  }
  if (command === "stop") {
    const pids = stopMailbox();
    console.log(pids.length ? `Stopped the local mailbox (PID ${pids.join(", ")}).` : "No local mailbox is running.");
    return;
  }
  console.error("Usage: node scripts/dev-mailbox.mjs <ensure | stop>");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
