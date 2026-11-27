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
//       at this release). Refuses at any other release and over a lock. There
//       is no relock: rewriting a lock arrives with the first new contract
//       version, with its per-version snapshots and host adapter.
//   node scripts/contract-lock.mjs judge [--run <id>] [--freeze-commit]
//       the release and CI command: checks out the anchor (the newest trusted
//       release tag carrying a lock: annotated, named v<semver> at or past the
//       freeze, its commit at that platform version, reachable from HEAD) into
//       a temporary folder and runs THAT tag's script, seal registry, frozen
//       list and rules against this tree (`verify --root <this tree>`). With no
//       anchor at or past the freeze it refuses, except on the freeze commit
//       before its tag when asked (`--freeze-commit`: "not yet anchored").
//   node scripts/contract-lock.mjs verify [--run <id>] [--verify-signatures]
//       judge this tree with this script: the lock is the anchor's byte for
//       byte, every seal of the registry and of the lock is there, each
//       snapshot differs from the locked one only as the ledgers allow, by the
//       rules loaded from the anchor, every frozen file the anchor holds is
//       unchanged, and (with --run) every seal test of that run generated
//       exactly the committed snapshot. Exits 1 on any refusal.
//   node scripts/contract-lock.mjs notes <release notes file>
//       refuse release notes that do not name the advisory of every security
//       entry added since the anchor.
//
// Every command takes `--root <dir>` (default: this checkout).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  return { problems, lock: { lock: 1, platform, contractVersion, seals, frozen, ledgers } };
}

/** Writes the lock, once, at the freeze release. A second lock is refused: relocking arrives with the first new contract version. */
export async function writeLock(root = DEFAULT_ROOT, { allowNoReplay = false, platform = SCALIUS_PLATFORM_VERSION, contractVersion = PLUGIN_API_VERSION } = {}) {
  if (existsSync(join(root, LOCK_FILE))) return { problems: [`${LOCK_FILE} exists: the contract is locked. There is no relock yet: it arrives with the first new contract version (per-version snapshots and the host adapter).`] };
  if (platform !== FREEZE) return { problems: [`The lock is written at the freeze release ${FREEZE}; this is ${platform}.`] };
  const built = await buildLock(root, { allowNoReplay, platform, contractVersion });
  if (!built.lock) return built;
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(built.lock, null, 1)}\n`);
  return { problems: [], lock: built.lock };
}

/** The platform version a tree (or a commit's tree) states (packages/shared/src/plugins/api-version.ts). */
function platformIn(text) {
  return text?.match(/SCALIUS_PLATFORM_VERSION = "([^"]+)"/)?.[1] ?? null;
}

export function platformOf(root) {
  const file = join(root, "packages/shared/src/plugins/api-version.ts");
  return platformIn(existsSync(file) ? readFileSync(file, "utf8") : null) ?? SCALIUS_PLATFORM_VERSION;
}

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Whether release tags must carry a good signature: asked for, or a signing key is configured here. */
function signaturesWanted(root, asked) {
  if (asked !== undefined) return asked;
  try {
    return git(root, ["config", "--get", "user.signingkey"]).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * The release tags this tree trusts, newest version first: annotated tags
 * named `v<semver>` at or past the freeze, reachable from HEAD, whose commit
 * states that very platform version (and, when asked, carry a good signature).
 */
export function trustedReleaseTags(root = DEFAULT_ROOT, { verifySignatures } = {}) {
  let lines = [];
  try {
    lines = git(root, ["for-each-ref", "--merged", "HEAD", "--format=%(refname:short) %(objecttype)", "refs/tags"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const signed = signaturesWanted(root, verifySignatures);
  return lines.map((line) => line.split(" ")).flatMap(([tag, type]) => {
    const version = RELEASE_TAG.exec(tag)?.[1];
    if (type !== "tag" || !version || comparePluginVersions(version, FREEZE) < 0) return [];
    if (platformIn(gitText(root, `${tag}^{commit}`, "packages/shared/src/plugins/api-version.ts")) !== version) return [];
    if (signed) {
      try {
        git(root, ["verify-tag", tag]);
      } catch {
        return [];
      }
    }
    return [{ tag, version }];
  }).sort((left, right) => comparePluginVersions(right.version, left.version));
}

/** The anchor: the newest trusted release tag that carries a lock, with that lock's text. */
export function anchorTag(root = DEFAULT_ROOT, options = {}) {
  for (const { tag, version } of trustedReleaseTags(root, options)) {
    const text = gitText(root, `${tag}^{commit}`, LOCK_FILE);
    if (text !== null) return { tag, version, text };
  }
  return null;
}

function shallow(root) {
  try {
    return git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  } catch {
    return false;
  }
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
  // The TypeScript the SDK seal parses declarations with: the judged tree's, else this script's checkout's
  // (a release tag's script runs from a folder with no node_modules).
  const found = [process.env.SCALIUS_CONTRACT_TYPESCRIPT ?? null, ...[root, DEFAULT_ROOT].map((base) => {
    try {
      return createRequire(join(base, "packages/shared/package.json")).resolve("typescript");
    } catch {
      return null;
    }
  })].find(Boolean);
  if (!found) throw new Error("The judge needs TypeScript: run it from a checkout with its dependencies installed.");
  const typescript = pathToFileURL(found).href;
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

/** Every frozen file a tree at `ref` holds (its theme goldens and their reads, its replay bundles frozen at or after the freeze). */
function frozenFilesAt(root, ref) {
  let listed = [];
  try {
    listed = git(root, ["ls-tree", "-r", "--name-only", ref, "--", GOLDENS_DIR]).split("\n").filter(Boolean);
  } catch {
    listed = [];
  }
  const goldens = listed.filter((path) => new RegExp(`^${GOLDENS_DIR}/(?:upgraded/)?v\\d+/[^/]+\\.json$`).test(path));
  const bundles = REPLAY_SETS.flatMap((set) => {
    const text = gitText(root, ref, `${set}/replay.json`);
    return text === null ? [] : (JSON.parse(text).bundles ?? []).filter((bundle) => comparePluginVersions(bundle.builtAgainst, FREEZE) >= 0)
      .flatMap((bundle) => [`${set}/${bundle.file}`, `${set}/expected/${bundle.id}-${bundle.version}@${bundle.builtAgainst}.json`]);
  });
  return [...goldens, ...bundles];
}

/** Where a seal test run records what each seal generated (seal.testing.ts writes it when SCALIUS_CONTRACT_RUN is set). */
export function runRecordsDir(root, run) {
  return join(root, "node_modules/.cache/contract-runs", run);
}

/** A seal test that did not run, or sealed a file it did not generate, leaves no matching record of the run. */
async function runProblems(root, run, lines) {
  const problems = [];
  const dir = runRecordsDir(root, run);
  for (const path of SEALS) {
    const record = join(dir, `${(await sha256Hex(path)).slice(0, 16)}.json`);
    if (!existsSync(record)) {
      problems.push(`${path}: no seal test of run ${run} generated it.`);
      continue;
    }
    const generated = JSON.parse(readFileSync(record, "utf8"));
    const committed = existsSync(join(root, path)) ? await sha256Hex(readFileSync(join(root, path), "utf8")) : null;
    if (generated.path !== path || generated.sha256 !== committed) problems.push(`${path}: what the seal test generated in run ${run} is not the committed snapshot.`);
  }
  if (problems.length === 0) lines.push(`  run     every seal test of run ${run} generated its committed snapshot`);
  return problems;
}

/**
 * Judges this tree against its lock (see the header). `lines` say what was
 * judged; `problems` are refusals.
 */
export async function verifyLock(root = DEFAULT_ROOT, { platform = platformOf(root), today = new Date().toISOString().slice(0, 10), run = null, verifySignatures } = {}) {
  const lock = readLock(root);
  const lines = [];
  const problems = [];
  const atOrPastFreeze = comparePluginVersions(platform, FREEZE) >= 0;
  if (!atOrPastFreeze) {
    if (!lock) {
      lines.push(`No ${LOCK_FILE}: ${platform} is before the ${FREEZE} freeze; every seal follows its ledger as before.`);
      if (run !== null) problems.push(...await runProblems(root, run, lines));
      return { lock, lines, problems };
    }
  }
  if (atOrPastFreeze && shallow(root)) {
    problems.push("This is a shallow clone: the anchor tag and the locked snapshots need full history (git fetch --tags --unshallow).");
    return { lock, lines, problems };
  }
  const anchor = anchorTag(root, { verifySignatures });
  if (!lock) {
    problems.push(`This is ${platform}, at or past the ${FREEZE} freeze, and ${LOCK_FILE} is missing${anchor ? ` (${anchor.tag} carries it)` : ""}.`);
    return { lock, lines, problems };
  }
  if (anchor) {
    lines.push(`Locked at ${lock.platform}, contract ${lock.contractVersion}. Anchored to ${anchor.tag}; judged by ${anchor.tag}'s rules.`);
    if (readFileSync(join(root, LOCK_FILE), "utf8") !== anchor.text) problems.push(`${LOCK_FILE} is not the lock ${anchor.tag} carries, byte for byte.`);
  } else if (platform === FREEZE) {
    lines.push(`Locked at ${lock.platform}, contract ${lock.contractVersion}. Not yet anchored: no trusted ${FREEZE} tag yet, so judged by this tree's own lock and rules (tag this commit as an annotated v${FREEZE}).`);
  } else {
    problems.push(`No trusted release tag is reachable (an annotated v<version> at or past ${FREEZE}, its commit at that platform version, carrying ${LOCK_FILE}): fetch tags and full history (git fetch --tags --unshallow) and judge again.`);
    return { lock, lines, problems };
  }
  let judge;
  try {
    judge = await loadJudge(root, anchor ? `${anchor.tag}^{commit}` : null);
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
  // Frozen: every file the lock names, and every frozen file the anchor's tree holds (the set grows release by release).
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
  if (anchor) {
    for (const path of frozenFilesAt(root, `${anchor.tag}^{commit}`)) {
      if (!existsSync(join(root, path))) {
        if (!path.startsWith("internal/")) problems.push(`${path}: a file frozen at ${anchor.tag} was removed.`);
        continue;
      }
      const blob = git(root, ["rev-parse", `${anchor.tag}^{commit}:${path}`]).trim();
      if (git(root, ["hash-object", "--", path]).trim() !== blob) {
        frozenChanged += 1;
        problems.push(`${path}: a file frozen at ${anchor.tag} changed.`);
      }
    }
  }
  lines.push(`  frozen  ${Object.keys(lock.frozen).length} files in the lock${anchor ? ` and the anchor's own` : ""}${frozenChanged ? `, ${frozenChanged} changed` : ", none changed"}`);
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
  if (run !== null) problems.push(...await runProblems(root, run, lines));
  else lines.push("  run     no --run: not checked that every seal test generated its committed snapshot");
  return { lock, lines, problems };
}

/**
 * The release and CI judge: the anchor tag's own script, seal registry,
 * frozen list and rules, run from a temporary checkout of the tag against
 * `root`. Without an anchor, this tree's verify (which refuses past the
 * freeze, and says "not yet anchored" on the freeze commit).
 */
export async function judgeWithAnchor(root = DEFAULT_ROOT, { run = null, verifySignatures, freezeCommit = false } = {}) {
  const platform = platformOf(root);
  const atOrPastFreeze = comparePluginVersions(platform, FREEZE) >= 0;
  const anchor = atOrPastFreeze && !shallow(root) ? anchorTag(root, { verifySignatures }) : null;
  if (!anchor) {
    const verdict = await verifyLock(root, { run, verifySignatures });
    // A lock with no trusted tag behind it is trusted as written only on the freeze commit, when the release
    // command says so (`--freeze-commit`): anywhere else it could be a rewritten lock with its tag deleted.
    if (atOrPastFreeze && verdict.lock && !freezeCommit) {
      verdict.problems.push(`No trusted release tag anchors this lock. On the ${FREEZE} commit before its tag, judge with --freeze-commit; anywhere else fetch tags and full history (git fetch --tags --unshallow).`);
    }
    return { ...verdict, anchored: false, code: verdict.problems.length === 0 ? 0 : 1 };
  }
  // The real path (a temporary folder behind a symlink would not run as the main module).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scalius-contract-anchor-")));
  try {
    const archive = execFileSync("git", ["archive", `${anchor.tag}^{commit}`, "scripts", "packages/shared/src"], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
    const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive });
    if (untar.status !== 0) return { lock: null, lines: [], problems: [`Could not check out ${anchor.tag}'s judge.`], anchored: true, code: 1 };
    const args = [join(dir, "scripts/contract-lock.mjs"), "verify", "--root", root, ...(run ? ["--run", run] : []), ...(verifySignatures ? ["--verify-signatures"] : [])];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lines = [`Judged by ${anchor.tag}'s own script and rules, checked out from the tag.`, ...result.stdout.split("\n").filter(Boolean)];
    const problems = result.stderr.split("\n").filter((line) => line.startsWith("refused: ")).map((line) => line.slice(9));
    if (result.status !== 0 && problems.length === 0) problems.push(`${anchor.tag}'s judge failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    // Silence is never a pass: the tag's judge says what it judged.
    if (result.status === 0 && !result.stdout.includes(`Anchored to ${anchor.tag}`)) problems.push(`${anchor.tag}'s judge gave no verdict: ${result.stderr.trim() || "no output"}`);
    return { lock: readLock(root), lines, problems, anchored: true, code: result.status ?? 1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The security entries added to the ledgers since the newest trusted release tag. */
export function securityEntriesSince(root = DEFAULT_ROOT) {
  const tag = trustedReleaseTags(root)[0]?.tag ?? null;
  return LEDGERS.flatMap((path) => {
    const before = new Set((JSON.parse((tag && gitText(root, `${tag}^{commit}`, path)) || "[]")).map((entry) => JSON.stringify(entry)));
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
  if (args.includes("--relock")) {
    console.error("There is no relock yet: it arrives with the first new contract version, with its per-version snapshots and host adapter.");
    return 1;
  }
  if (args.includes("--write")) {
    const { problems, lock } = await writeLock(root, { allowNoReplay: args.includes("--allow-no-replay") });
    for (const problem of problems) console.error(problem);
    if (!lock) return 1;
    console.log(`Wrote ${LOCK_FILE} at ${lock.platform} (contract ${lock.contractVersion}): ${Object.keys(lock.seals).length} seals, ${Object.keys(lock.frozen).length} frozen files, ${Object.values(lock.ledgers).reduce((sum, value) => sum + value.entries, 0)} ledger entries in ${Object.keys(lock.ledgers).length} ledgers.`);
    return 0;
  }
  const run = flag(args, "--run");
  const verifySignatures = args.includes("--verify-signatures") ? true : undefined;
  if (args.includes("judge") || args.includes("verify") || args.includes("status")) {
    const { lines, problems } = args.includes("judge")
      ? await judgeWithAnchor(root, { run, verifySignatures, freezeCommit: args.includes("--freeze-commit") })
      : await verifyLock(root, { run, verifySignatures });
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
  console.error("Usage: node scripts/contract-lock.mjs classify | --write [--allow-no-replay] | judge [--run <id>] | verify [--run <id>] [--verify-signatures] | notes <file>   [--root <dir>]");
  return 2;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
