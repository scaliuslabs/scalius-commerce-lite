#!/usr/bin/env node
// The contract lock: what every gated snapshot of the theme and app contract
// was at the freeze (`contract.lock.json`), the typing of the break ledgers it
// relies on, and the judge that holds a tree to it. The entry rule is
// packages/shared/src/contract/lock.ts; the seals and their ledgers are
// contract/seals.ts; their rules are contract/comparators.ts.
//
//   node scripts/contract-lock.mjs classify
//       give every untyped ledger entry its type (growth when its change or
//       reason says it only adds, else pre-lock); a typed entry is left as it
//       is. Re-runnable: run it again after a merge brings untyped entries.
//       After the lock it refuses: an entry written then is typed by hand.
//   node scripts/contract-lock.mjs --write [--allow-no-replay]
//       write contract.lock.json once, on the freeze release's commit (every
//       sealed file committed, every ledger entry typed, replay bundles frozen
//       at this release). Refuses at any other release and over a lock.
//   node scripts/contract-lock.mjs --relock "<reason>"
//       rewrite the lock for a new contract version only (PLUGIN_API_VERSION
//       differs from the lock's). The new lock records the digest of the one it
//       replaces and which seals moved, so a release tag's lock stays provable.
//   node scripts/contract-lock.mjs verify   (also: status)
//       judge this tree: the lock is the one the latest locked release tag
//       carries (or holds its digest in its chain); every seal of the lock and
//       of contract/seals.ts is there; each snapshot differs from the locked one
//       only as HEAD's ledgers allow, by the rules (comparators.ts and lock.ts)
//       loaded from that tag, so a branch cannot weaken the judge it is judged
//       by; frozen files are unchanged. Exits 1 on any refusal. Before any locked
//       tag exists it judges with this tree's rules and says so; before the
//       freeze release, with no lock, it reports that and passes.
//   node scripts/contract-lock.mjs notes <release notes file>
//       refuse release notes that do not name the advisory of every security
//       entry added since the last release tag.
//
// Every command takes `--root <dir>` (default: this checkout).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTRACT_ADVISORIES_DIR, CONTRACT_FREEZE_RELEASE, classifyLedgerEntry, ledgerDigest, lockedFile, sha256Hex } from "../packages/shared/src/contract/lock.ts";
import { CONTRACT_JUDGE, CONTRACT_LEDGERS, CONTRACT_SEALS } from "../packages/shared/src/contract/seals.ts";
import { PLUGIN_API_VERSION, SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "../packages/shared/src/plugins/api-version.ts";
import { comparePluginVersions } from "../packages/shared/src/plugins/versions.ts";

export const LOCK_FILE = "contract.lock.json";
/** The break ledgers (contract/seals.ts). */
export const LEDGERS = CONTRACT_LEDGERS;
/** The compatibility-ruled snapshots (contract/seals.ts): after the lock each may change only as its ledger allows. */
export const SEALS = CONTRACT_SEALS.map((seal) => seal.path);
/** Where the theme document's goldens live (`v<n>/*.json`) and their upgraded outputs (`upgraded/v<n>/*.json`): never edited once committed. */
export const GOLDENS_DIR = "packages/shared/src/storefront-theme/compat";
/** The replay sets (tests/replay/bundles.test.ts `SETS`). */
export const REPLAY_SETS = ["internal/replay", "apps/api/src/plugins/testing/replay"];
/** The release the contract freezes at (lock.ts; tests/replay/bundles.test.ts `FREEZE` equals it). */
export const FREEZE = CONTRACT_FREEZE_RELEASE;
/** The lock's modules the judge loads with the rules (lock.ts holds the entry rule). */
const JUDGE_ENTRIES = [CONTRACT_JUDGE, "packages/shared/src/contract/lock.ts"];

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

/** Every `.json` file under a folder's `v<n>` folders. */
function versionedJson(root, dir) {
  const at = join(root, dir);
  if (!existsSync(at)) return [];
  return readdirSync(at).filter((name) => /^v\d+$/.test(name)).sort()
    .flatMap((version) => readdirSync(join(at, version)).filter((name) => name.endsWith(".json")).sort().map((file) => `${dir}/${version}/${file}`));
}

/** Every frozen file at this tree: the theme goldens and their upgraded outputs, and each replay bundle built against FREEZE or later with its expectation. */
export function frozenFiles(root = DEFAULT_ROOT) {
  const files = [...versionedJson(root, GOLDENS_DIR), ...versionedJson(root, `${GOLDENS_DIR}/upgraded`)];
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

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function gitText(root, ref, path) {
  try {
    return git(root, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
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

/** The lock for this tree (refuses an untyped ledger entry, a sealed file missing or not committed as it is). */
export async function buildLock(root = DEFAULT_ROOT, { allowNoReplay = false, platform = SCALIUS_PLATFORM_VERSION, contractVersion = PLUGIN_API_VERSION } = {}) {
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
  return { problems, lock: { lock: 1, platform, contractVersion, relocks: [], seals, frozen, ledgers } };
}

/**
 * Writes the lock: once, at the freeze release; again only for a new
 * contract version, with a reason, recording the digest of the lock it
 * replaces and the seals that moved.
 */
export async function writeLock(root = DEFAULT_ROOT, { relock = null, allowNoReplay = false, platform = SCALIUS_PLATFORM_VERSION, contractVersion = PLUGIN_API_VERSION } = {}) {
  const existingText = existsSync(join(root, LOCK_FILE)) ? readFileSync(join(root, LOCK_FILE), "utf8") : null;
  const existing = existingText === null ? null : JSON.parse(existingText);
  if (existing && relock === null) return { problems: [`${LOCK_FILE} exists: the contract is locked. Rewrite it only for a new contract version, with --relock "<reason>".`] };
  if (!existing && relock !== null) return { problems: [`There is no ${LOCK_FILE} to relock: write the first one with --write at ${FREEZE}.`] };
  if (relock !== null && !relock.trim()) return { problems: ["--relock needs a reason."] };
  if (!existing && platform !== FREEZE) return { problems: [`The first lock is written at the freeze release ${FREEZE}; this is ${platform}.`] };
  if (existing && contractVersion === existing.contractVersion) {
    return { problems: [`A relock is for a new contract version: PLUGIN_API_VERSION is still ${contractVersion}, the locked one. A seal change at the same version is a ledger entry.`] };
  }
  const built = await buildLock(root, { allowNoReplay, platform, contractVersion });
  if (!built.lock) return built;
  const moved = existing ? Object.keys(existing.seals).filter((path) => built.lock.seals[path]?.sha256 !== existing.seals[path].sha256) : [];
  const lock = {
    ...built.lock,
    relocks: existing ? [...existing.relocks, { platform, contractVersion, reason: relock.trim(), replaced: await sha256Hex(existingText), moved }] : [],
  };
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 1)}\n`);
  return { problems: [], lock };
}

/** The newest release tag reachable from HEAD that carries a lock, or null. */
export function latestLockedTag(root = DEFAULT_ROOT) {
  let tags = [];
  try {
    tags = git(root, ["for-each-ref", "--merged", "HEAD", "--sort=-creatordate", "--format=%(refname:short)", "refs/tags"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  for (const tag of tags) {
    const text = gitText(root, tag, LOCK_FILE);
    if (text !== null) return { tag, text };
  }
  return null;
}

/** Whether the lock is the one the latest locked release tag carries, byte for byte, or names its digest in its chain of relocks. */
export async function anchorProblems(root = DEFAULT_ROOT) {
  const anchor = latestLockedTag(root);
  if (!anchor) return { anchor: null, problems: [] };
  const file = join(root, LOCK_FILE);
  if (!existsSync(file)) return { anchor, problems: [`${anchor.tag} carries ${LOCK_FILE}, and this tree has none.`] };
  const text = readFileSync(file, "utf8");
  if (text === anchor.text) return { anchor, problems: [] };
  const digest = await sha256Hex(anchor.text);
  const chain = (JSON.parse(text).relocks ?? []).map((relock) => relock.replaced);
  return { anchor, problems: chain.includes(digest) ? [] : [`${LOCK_FILE} is not the lock ${anchor.tag} carries, and its relocks do not name that lock's digest (${digest.slice(0, 16)}).`] };
}

/** Relative imports of a module (static `import` / `export … from`), and its bare ones. */
function importsOf(text) {
  return [...text.matchAll(/\b(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

/**
 * The judge's modules from a git ref (a release tag) or the working tree,
 * written to a temporary folder Node can run: relative imports get their
 * `.ts`, and `typescript` resolves to this checkout's copy.
 */
export async function loadJudge(root, ref) {
  const read = (path) => (ref ? gitText(root, ref, path) : existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null);
  // This checkout's TypeScript (the SDK seal parses declarations with it), wherever the judged tree is.
  const typescript = pathToFileURL(createRequire(join(DEFAULT_ROOT, "packages/shared/package.json")).resolve("typescript")).href;
  const dir = mkdtempSync(join(tmpdir(), "scalius-contract-judge-"));
  const queue = [...JUDGE_ENTRIES];
  const seen = new Set();
  try {
    while (queue.length > 0) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      const text = read(path);
      if (text === null) throw new Error(`The judge's module ${path} is not in ${ref ?? "this tree"}.`);
      let rewritten = text;
      for (const specifier of new Set(importsOf(text))) {
        if (specifier === "typescript") {
          rewritten = rewritten.replaceAll(`"typescript"`, JSON.stringify(typescript));
          continue;
        }
        if (!specifier.startsWith(".")) throw new Error(`${path} imports ${specifier}: the judge's modules import only each other and typescript.`);
        const base = posix.normalize(posix.join(posix.dirname(path), specifier));
        const target = [`${base}.ts`, base, `${base}/index.ts`].find((candidate) => read(candidate) !== null);
        if (!target) throw new Error(`${path} imports ${specifier}, which is not in ${ref ?? "this tree"}.`);
        queue.push(target);
        const relative = posix.relative(posix.dirname(path), target);
        rewritten = rewritten.replaceAll(`"${specifier}"`, JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`));
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), rewritten);
    }
    const [comparators, lock] = await Promise.all(JUDGE_ENTRIES.map((path) => import(pathToFileURL(join(dir, path)).href)));
    return { comparators, lock, modules: [...seen].sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Judges this tree against its lock (see the header). `lines` say what was
 * judged; `problems` are refusals.
 */
export async function verifyLock(root = DEFAULT_ROOT, { platform = SCALIUS_PLATFORM_VERSION, today = new Date().toISOString().slice(0, 10) } = {}) {
  const lock = readLock(root);
  const { anchor, problems } = await anchorProblems(root);
  const lines = [];
  if (!lock) {
    if (comparePluginVersions(platform, FREEZE) >= 0) problems.push(`This is ${platform}, at or past the ${FREEZE} freeze, and ${LOCK_FILE} is missing.`);
    else lines.push(`No ${LOCK_FILE}: ${platform} is before the ${FREEZE} freeze; every seal follows its ledger as before.`);
    return { lock, lines, problems };
  }
  lines.push(`Locked at ${lock.platform}, contract ${lock.contractVersion}${lock.relocks.length ? `, relocked ${lock.relocks.length}×` : ""}.`);
  lines.push(anchor ? `Anchored to ${anchor.tag}; judged by ${anchor.tag}'s rules.` : "No release tag carries a lock yet: judged by this tree's rules.");
  let judge;
  try {
    judge = await loadJudge(root, anchor?.tag ?? null);
  } catch (error) {
    problems.push(String(error?.message ?? error));
    return { lock, lines, problems };
  }
  const advisory = (id) => {
    const file = join(root, CONTRACT_ADVISORIES_DIR, `${id}.md`);
    return /^[\w-]+$/.test(id) && existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const sealed = new Map(CONTRACT_SEALS.map((seal) => [seal.path, seal]));
  for (const path of SEALS) if (!(path in lock.seals)) problems.push(`${path}: a seal not in the lock (a seal joins only with the next lock, for a new contract version).`);
  for (const [path, locked] of Object.entries(lock.seals)) {
    const seal = sealed.get(path);
    if (!seal) {
      problems.push(`${path}: locked, but no longer a seal (contract/seals.ts).`);
      continue;
    }
    if (!existsSync(join(root, path))) {
      problems.push(`${path}: a sealed snapshot is missing.`);
      continue;
    }
    const current = readFileSync(join(root, path), "utf8");
    if (await sha256Hex(current) === locked.sha256) {
      lines.push(`  seal    ${path}: unchanged`);
      continue;
    }
    const compare = judge.comparators.CONTRACT_COMPARATORS[path];
    if (!compare) {
      problems.push(`${path}: the locked judge has no rule for it.`);
      continue;
    }
    const open = await judge.lock.contractOpenBreaks({
      snapshot: seal.snapshot, path, ledgerPath: seal.ledger, committed: current, current,
      breakingChanges: compare, ledger: readLedger(root, seal.ledger) ?? [], lock,
      lockedText: async (blob) => (/^[0-9a-f]{40}$/.test(blob) ? (() => { try { return git(root, ["cat-file", "blob", blob]); } catch { return null; } })() : null),
      supportedVersions: SUPPORTED_PLUGIN_API_VERSIONS, advisory, today,
    });
    if (open.length === 0) lines.push(`  seal    ${path}: moved since the lock; every change is covered by a ledger entry`);
    for (const entry of open) problems.push(`${path}: ${entry.change}${entry.refused ? ` (${entry.refused})` : " (no entry accepts it)"}`);
  }
  const present = new Map();
  for (const path of frozenFiles(root)) present.set(await lockKey(path), path);
  let frozenChanged = 0;
  for (const [key, locked] of Object.entries(lock.frozen)) {
    const path = present.get(key) ?? (key.includes("#") ? null : key);
    if (path === null || !existsSync(join(root, path))) {
      if (key.startsWith("internal/") || key.startsWith("tests/")) lines.push(`  frozen  ${key}: not in this copy`);
      else problems.push(`${key}: a frozen file was removed.`);
      continue;
    }
    if (await sha256Hex(readFileSync(join(root, path))) !== locked.sha256) {
      frozenChanged += 1;
      problems.push(`${key}: a frozen file changed.`);
    }
  }
  lines.push(`  frozen  ${Object.keys(lock.frozen).length} files${frozenChanged ? `, ${frozenChanged} changed` : ", none changed"}`);
  for (const [path, atLock] of Object.entries(lock.ledgers)) {
    const entries = readLedger(root, path);
    if (!entries) {
      problems.push(`${path}: a locked ledger is missing.`);
      continue;
    }
    if (await ledgerDigest(entries.slice(0, atLock.entries)) !== atLock.sha256) problems.push(`${path}: the ${atLock.entries} entries recorded at the lock changed.`);
    const since = entries.slice(atLock.entries);
    const byType = Object.entries(since.reduce((counts, entry) => ({ ...counts, [entry.type ?? "untyped"]: (counts[entry.type ?? "untyped"] ?? 0) + 1 }), {}));
    lines.push(`  ledger  ${path}: ${since.length} entries since the lock${byType.length ? ` (${byType.map(([type, count]) => `${count} ${type}`).join(", ")})` : ""}`);
  }
  return { lock, lines, problems };
}

/** The newest release tag reachable from HEAD, or null. */
function latestTag(root) {
  try {
    return git(root, ["describe", "--tags", "--abbrev=0", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

/** The security entries added to the ledgers since the last release tag. */
export function securityEntriesSince(root = DEFAULT_ROOT) {
  const tag = latestTag(root);
  return LEDGERS.flatMap((path) => {
    const before = new Set((JSON.parse((tag && gitText(root, tag, path)) || "[]")).map((entry) => JSON.stringify(entry)));
    return (readLedger(root, path) ?? []).filter((entry) => entry.type === "security" && !before.has(JSON.stringify(entry)));
  });
}

/** Release notes refuse to stand unless they name the advisory of each security entry since the last release tag. */
export function notesProblems(notes, entries) {
  return [...new Set(entries.map((entry) => entry.advisory?.id ?? "(no advisory)"))]
    .filter((id) => !notes.includes(id))
    .map((id) => `The release notes do not name ${id}, a security change to the contract since the last release (${CONTRACT_ADVISORIES_DIR}/${id}.md).`);
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
      for (const entry of result.refused) console.error(`  untyped after the lock (type it by hand: growth for a changed pattern with accepts, or security with its advisory): ${entry.snapshot} ${entry.change}`);
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
  if (args.includes("verify") || args.includes("status")) {
    const { lines, problems } = await verifyLock(root);
    for (const line of lines) console.log(line);
    for (const problem of problems) console.error(`refused: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (args.includes("notes")) {
    const file = args[args.indexOf("notes") + 1];
    if (!file || !existsSync(file)) {
      console.error("Usage: node scripts/contract-lock.mjs notes <release notes file>");
      return 2;
    }
    const entries = securityEntriesSince(root);
    const problems = notesProblems(readFileSync(file, "utf8"), entries);
    for (const problem of problems) console.error(problem);
    if (problems.length === 0) console.log(`The release notes name every advisory since the last release tag (${entries.length} security entries).`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error("Usage: node scripts/contract-lock.mjs classify | --write [--allow-no-replay] | --relock \"<reason>\" | verify | notes <file>   [--root <dir>]");
  return 2;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
