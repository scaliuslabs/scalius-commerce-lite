#!/usr/bin/env node
// The contract lock: what every gated snapshot of the theme and app contract
// was at the freeze (`contract.lock.json`), and the typing of the break
// ledgers it relies on. The rule each seal follows before and after the lock
// is packages/shared/src/contract/lock.ts; this script writes the lock and
// types the ledgers.
//
//   node scripts/contract-lock.mjs classify
//       give every untyped ledger entry its type (growth when its change or
//       reason says it only adds, else pre-lock); a typed entry is left as it
//       is. Re-runnable: run it again after a merge brings untyped entries.
//       After the lock it refuses: an entry written then is typed by hand.
//   node scripts/contract-lock.mjs --write [--allow-no-replay]
//       write contract.lock.json once, on the release commit (every sealed
//       file committed, every ledger entry typed, replay bundles frozen at
//       this release). Refuses to replace an existing lock.
//   node scripts/contract-lock.mjs --relock "<reason>"
//       rewrite an existing lock (a new contract version): the reason is kept.
//   node scripts/contract-lock.mjs status
//       each locked file: unchanged, moved since the lock (a seal) or changed
//       (a frozen file: refused), or not in this copy; each ledger's entries
//       since the lock by type. Read-only; it also runs in the public copy,
//       which carries the lock, the snapshots and the ledgers but not the
//       tests that enforce them.
//
// Every command takes `--root <dir>` (default: this checkout).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLedgerEntry, ledgerDigest, lockedFile, sha256Hex } from "../packages/shared/src/contract/lock.ts";
import { PLUGIN_API_VERSION, SCALIUS_PLATFORM_VERSION } from "../packages/shared/src/plugins/api-version.ts";
import { comparePluginVersions } from "../packages/shared/src/plugins/versions.ts";

export const LOCK_FILE = "contract.lock.json";

/** The break ledgers, one per seal family. */
export const LEDGERS = [
  "packages/shared/src/plugins/abi.breaks.json",
  "apps/api/src/openapi/stable-operations.breaks.json",
  "packages/shared/src/events.representations.breaks.json",
  "packages/shared/src/contract/contract.breaks.json",
];

/**
 * The compatibility-ruled snapshots: after the lock each may change only as
 * its seal test and ledger allow. The protocol seal holds the host CSS
 * variables, host hooks, skin HTML allow-list, app limits, store words and
 * delivery scheme (plugins/contract-tables.ts); the stable operations seal
 * holds the component names.
 */
export const SEALS = [
  "packages/shared/src/plugins/abi.manifest.snapshot.json",
  "packages/shared/src/plugins/abi.protocol.snapshot.json",
  "packages/shared/src/plugins/abi.sdk.snapshot.txt",
  "apps/api/src/openapi/stable-operations.snapshot.json",
  "packages/shared/src/events.representations.snapshot.json",
  "packages/shared/src/storefront-theme/compat.snapshot.json",
  "packages/shared/src/storefront-theme/private-anatomy.snapshot.txt",
  "packages/shared/src/storefront-theme/save-reasons.snapshot.json",
  "packages/shared/src/storefront-theme/read-bounds.snapshot.json",
  // Tied to PRIVATE_CHECKER_VERSION / PRIVATE_POLICY_VERSION (private-compile-golden.test.ts): moving it raises one, which save-reasons' rule then refuses without an entry.
  "packages/shared/src/storefront-theme/private-compile.golden.json",
  "packages/shared/src/contract/refusal-census.snapshot.json",
];

/** Where the theme document's goldens live (`v<n>/*.json`, never edited once committed). */
export const GOLDENS_DIR = "packages/shared/src/storefront-theme/compat";
/** The replay sets (tests/replay/bundles.test.ts `SETS`). */
export const REPLAY_SETS = ["internal/replay", "apps/api/src/plugins/testing/replay"];
/** The release the contract freezes at (tests/replay/bundles.test.ts `FREEZE`): bundles built against it or later never change outcome. */
export const FREEZE = "2.0.0-rc.1";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The lock's key for a file. Under `internal/` (stripped from the public
 * export, and it may name a customer) the key is the folder and a digest of
 * the name, so the public lock names no private file.
 */
export async function lockKey(path) {
  if (!path.startsWith("internal/")) return path;
  const [top, set] = path.split("/");
  return `${top}/${set}/#${(await sha256Hex(path)).slice(0, 16)}`;
}

/** Every frozen file at this tree: the theme goldens, and each replay bundle built against FREEZE or later with its expectation. */
export function frozenFiles(root = DEFAULT_ROOT) {
  const files = [];
  const goldens = join(root, GOLDENS_DIR);
  if (existsSync(goldens)) {
    for (const dir of readdirSync(goldens).filter((name) => /^v\d+$/.test(name)).sort()) {
      for (const file of readdirSync(join(goldens, dir)).filter((name) => name.endsWith(".json")).sort()) files.push(`${GOLDENS_DIR}/${dir}/${file}`);
    }
  }
  for (const set of REPLAY_SETS) {
    const listed = join(root, set, "replay.json");
    if (!existsSync(listed)) continue;
    for (const bundle of JSON.parse(readFileSync(listed, "utf8")).bundles ?? []) {
      if (comparePluginVersions(bundle.builtAgainst, FREEZE) < 0) continue;
      files.push(`${set}/${bundle.file}`, `${set}/expected/${bundle.id}-${bundle.version}@${bundle.builtAgainst}.json`);
    }
  }
  return files;
}

function readLedger(root, path) {
  const file = join(root, path);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function readLock(root = DEFAULT_ROOT) {
  const file = join(root, LOCK_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/**
 * Types every untyped entry of every ledger (lock.ts `classifyLedgerEntry`):
 * the type is added after the entry's other keys, so a merge that brings
 * untyped entries is resolved by running this again. After the lock an
 * untyped entry is a reviewer's to type: it is listed and nothing is written.
 */
export function classifyLedgers(root = DEFAULT_ROOT) {
  const lock = readLock(root);
  const results = [];
  for (const path of LEDGERS) {
    const entries = readLedger(root, path);
    if (!entries) continue;
    const before = lock?.ledgers[path]?.entries ?? (lock ? 0 : entries.length);
    const counts = { growth: 0, "pre-lock": 0, already: 0 };
    const refused = [];
    const typed = entries.map((entry, index) => {
      if (entry.type !== undefined) {
        counts.already += 1;
        return entry;
      }
      if (lock && index >= before) {
        refused.push(entry);
        return entry;
      }
      const type = classifyLedgerEntry(entry);
      counts[type] += 1;
      return { ...entry, type };
    });
    if (refused.length === 0 && counts.growth + counts["pre-lock"] > 0) writeFileSync(join(root, path), `${JSON.stringify(typed, null, 1)}\n`);
    results.push({ path, entries: entries.length, ...counts, refused });
  }
  return results;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The lock for this tree (refuses an untyped ledger entry, a sealed file missing or not committed as it is). */
export async function buildLock(root = DEFAULT_ROOT, { allowNoReplay = false } = {}) {
  const problems = [];
  const seals = {};
  const frozen = {};
  const ledgers = {};
  const frozenList = frozenFiles(root);
  if (!allowNoReplay && !frozenList.some((path) => REPLAY_SETS.some((set) => path.startsWith(`${set}/`)))) {
    problems.push(`No replay bundle is built against ${FREEZE} or later: freeze this release's first (node tests/replay/freeze.mjs fixtures, then SCALIUS_REPLAY_WRITE=1 pnpm exec vitest run tests/replay/bundles.test.ts), or pass --allow-no-replay.`);
  }
  const files = [...SEALS, ...frozenList];
  for (const path of files) {
    if (!existsSync(join(root, path))) problems.push(`${path} is missing.`);
  }
  if (problems.length === 0) {
    const dirty = git(root, ["status", "--porcelain", "--", ...files, ...LEDGERS]).trim();
    if (dirty) problems.push(`Commit these first (the lock reads each file back from git by its blob):\n${dirty}`);
  }
  for (const path of LEDGERS) {
    const entries = readLedger(root, path);
    if (!entries) continue;
    const untyped = entries.filter((entry) => entry.type === undefined).length;
    if (untyped > 0) problems.push(`${path}: ${untyped} entries have no type (run node scripts/contract-lock.mjs classify first).`);
    ledgers[path] = { entries: entries.length, sha256: await ledgerDigest(entries) };
  }
  if (problems.length > 0) return { problems };
  for (const path of SEALS) seals[path] = await lockedFile(readFileSync(join(root, path)));
  for (const path of frozenList) frozen[await lockKey(path)] = await lockedFile(readFileSync(join(root, path)));
  return { problems, lock: { lock: 1, platform: SCALIUS_PLATFORM_VERSION, contractVersion: PLUGIN_API_VERSION, relocks: [], seals, frozen, ledgers } };
}

/** Writes the lock: once, or again with a reason. */
export async function writeLock(root = DEFAULT_ROOT, { relock = null, allowNoReplay = false } = {}) {
  const existing = readLock(root);
  if (existing && !relock) return { problems: [`${LOCK_FILE} exists: the contract is locked. Rewrite it only for a new contract version, with --relock "<reason>".`] };
  if (relock !== null && !relock.trim()) return { problems: ["--relock needs a reason."] };
  const built = await buildLock(root, { allowNoReplay });
  if (!built.lock) return built;
  const lock = { ...built.lock, relocks: [...(existing?.relocks ?? []), ...(existing && relock ? [{ platform: SCALIUS_PLATFORM_VERSION, reason: relock.trim() }] : [])] };
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 1)}\n`);
  return { problems: [], lock };
}

/**
 * Each locked file against this tree, and each ledger's entries since the
 * lock. `problems` are what no seal test accepts: a frozen file changed or
 * gone, a sealed file gone, a ledger's locked entries edited.
 */
export async function lockStatus(root = DEFAULT_ROOT) {
  const lock = readLock(root);
  if (!lock) return { lock: null, lines: [`No ${LOCK_FILE}: the contract is not locked yet; every seal follows its ledger as before.`], problems: [] };
  const lines = [`Locked at ${lock.platform}, contract ${lock.contractVersion}${lock.relocks.length ? `, relocked ${lock.relocks.length}×` : ""}.`];
  const problems = [];
  for (const [path, locked] of Object.entries(lock.seals)) {
    const file = join(root, path);
    if (!existsSync(file)) {
      lines.push(`  seal    ${path}: not in this copy`);
      continue;
    }
    lines.push(`  seal    ${path}: ${await sha256Hex(readFileSync(file)) === locked.sha256 ? "unchanged" : "moved since the lock (its ledger covers each change)"}`);
  }
  const present = new Map();
  for (const path of frozenFiles(root)) present.set(await lockKey(path), path);
  for (const [key, locked] of Object.entries(lock.frozen)) {
    const path = present.get(key) ?? (key.includes("#") ? null : key);
    if (path === null || !existsSync(join(root, path))) {
      if (key.startsWith("internal/") || key.startsWith("tests/")) lines.push(`  frozen  ${key}: not in this copy`);
      else problems.push(`${key}: a frozen file was removed.`);
      continue;
    }
    if (await sha256Hex(readFileSync(join(root, path))) !== locked.sha256) problems.push(`${key}: a frozen file changed.`);
  }
  lines.push(`  frozen  ${Object.keys(lock.frozen).length} files${problems.length ? "" : ", none changed"}`);
  for (const [path, atLock] of Object.entries(lock.ledgers)) {
    const entries = readLedger(root, path);
    if (!entries) {
      lines.push(`  ledger  ${path}: not in this copy`);
      continue;
    }
    if (await ledgerDigest(entries.slice(0, atLock.entries)) !== atLock.sha256) problems.push(`${path}: the ${atLock.entries} entries recorded at the lock changed.`);
    const since = entries.slice(atLock.entries);
    const byType = Object.entries(since.reduce((counts, entry) => ({ ...counts, [entry.type ?? "untyped"]: (counts[entry.type ?? "untyped"] ?? 0) + 1 }), {}));
    lines.push(`  ledger  ${path}: ${since.length} entries since the lock${byType.length ? ` (${byType.map(([type, count]) => `${count} ${type}`).join(", ")})` : ""}`);
  }
  for (const path of SEALS) if (!(path in lock.seals)) lines.push(`  seal    ${path}: sealed after the lock (its ledger rules apply from its first snapshot)`);
  for (const path of Object.keys(lock.seals)) if (!SEALS.includes(path)) problems.push(`${path}: locked, but no longer a seal (a seal leaves the lock only with --relock).`);
  return { lock, lines, problems };
}

function flag(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] ?? "" : null;
}

async function main(args) {
  const root = resolve(flag(args, "--root") ?? DEFAULT_ROOT);
  if (args.includes("classify")) {
    let refused = 0;
    for (const result of classifyLedgers(root)) {
      console.log(`${result.path}: ${result.entries} entries; typed now ${result.growth} growth, ${result["pre-lock"]} pre-lock; ${result.already} already typed.`);
      for (const entry of result.refused) console.error(`  untyped after the lock (type it by hand: growth, security with its advisory, or new-version): ${entry.snapshot} ${entry.change}`);
      refused += result.refused.length;
    }
    return refused === 0 ? 0 : 1;
  }
  if (args.includes("--write") || args.includes("--relock")) {
    const { problems, lock } = await writeLock(root, { relock: flag(args, "--relock"), allowNoReplay: args.includes("--allow-no-replay") });
    for (const problem of problems) console.error(problem);
    if (!lock) return 1;
    console.log(`Wrote ${LOCK_FILE} at ${lock.platform} (contract ${lock.contractVersion}): ${Object.keys(lock.seals).length} seals, ${Object.keys(lock.frozen).length} frozen files, ${Object.values(lock.ledgers).reduce((sum, value) => sum + value.entries, 0)} ledger entries in ${Object.keys(lock.ledgers).length} ledgers.`);
    return 0;
  }
  if (args.includes("status")) {
    const { lines, problems } = await lockStatus(root);
    for (const line of lines) console.log(line);
    for (const problem of problems) console.error(`refused: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error("Usage: node scripts/contract-lock.mjs classify | --write [--allow-no-replay] | --relock \"<reason>\" | status   [--root <dir>]");
  return 2;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
