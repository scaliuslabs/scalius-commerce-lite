// The one way a seal test checks a snapshot against its break ledger and the
// contract lock (lock.ts). Test-only: it reads files and git, through runtime
// specifiers that keep Node types out of this Workers package (as
// plugins/abi.snapshot.test.ts does).
import { expect } from "vitest";
import { SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "../plugins/api-version";
import { comparePluginVersions } from "../plugins/versions";
import { CONTRACT_ADVISORIES_DIR, CONTRACT_FREEZE_RELEASE, contractOpenBreaks, sha256Hex, type ContractLock, type LedgerEntry, type OpenBreak } from "./lock";

interface NodeIo {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, text: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  existsSync(path: string): boolean;
  execFileSync(file: string, args: string[], options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"]; maxBuffer: number }): string;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  fileURLToPath(url: string | URL): string;
}

let io: Promise<NodeIo> | null = null;

function node(): Promise<NodeIo> {
  io ??= Promise.all(["node:fs", "node:child_process", "node:path", "node:url"].map((specifier) => import(/* @vite-ignore */ specifier)))
    .then(([fs, child, path, url]) => ({ ...url, ...child, ...fs, ...path }) as NodeIo);
  return io;
}

/** The repository root (this file is packages/shared/src/contract/seal.testing.ts). */
export async function repositoryRoot(): Promise<string> {
  const { fileURLToPath } = await node();
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

/** The repository's contract lock, or null before the freeze. */
export async function readContractLock(root?: string): Promise<ContractLock | null> {
  const { readFileSync, existsSync, resolve } = await node();
  const path = resolve(root ?? await repositoryRoot(), "contract.lock.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ContractLock : null;
}

/** A locked snapshot's text by its git blob id, or null when this clone does not hold it. */
export async function lockedGitText(blob: string, root?: string): Promise<string | null> {
  const { execFileSync } = await node();
  if (!/^[0-9a-f]{40}$/.test(blob)) return null;
  try {
    return execFileSync("git", ["cat-file", "blob", blob], { cwd: root ?? await repositoryRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export interface SealedSnapshot {
  /** The snapshot file: a file URL (`new URL("./x.json", import.meta.url)`) or an absolute path. */
  file: string | URL;
  /** The ledger's name for it (each ledger keeps the names its entries already use). */
  snapshot: string;
  /** The break ledger: a file URL or an absolute path. */
  ledgerFile: string | URL;
  ledger: readonly LedgerEntry[];
  current: string;
  breakingChanges: (before: string, after: string) => readonly string[];
}

/** A file's text (a test reads its snapshots and fixtures through this, without Node types). */
export async function readText(file: string | URL): Promise<string> {
  const { readFileSync, fileURLToPath } = await node();
  return readFileSync(typeof file === "string" ? file : fileURLToPath(file), "utf8");
}

/** A file URL or path as an absolute path (a URL's `%20` decoded: the lock keys are plain paths). */
export async function filePath(file: string | URL): Promise<string> {
  const { fileURLToPath } = await node();
  return typeof file === "string" ? (file.startsWith("file:") ? fileURLToPath(file) : file) : fileURLToPath(file);
}

/** The committed text of a snapshot, or null before the first one. */
export async function committedSnapshot(file: string | URL): Promise<string | null> {
  const { readFileSync, existsSync } = await node();
  const path = await filePath(file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Whether the tree pins the freeze tag (contract.anchor.json, committed right after tagging). */
export async function anchorPinned(root?: string): Promise<boolean> {
  const { existsSync, resolve } = await node();
  return existsSync(resolve(root ?? await repositoryRoot(), "contract.anchor.json"));
}

/**
 * From the freeze on, a missing lock is itself a refusal: the seals never fall back to the rules
 * before it. The freeze is known by the version the tree states, or by the committed anchor pin,
 * whatever version the tree claims.
 */
export function missingLockProblem(lock: ContractLock | null, platform: string = SCALIUS_PLATFORM_VERSION, pinned = false): string | null {
  if (lock !== null) return null;
  if (pinned) return `contract.anchor.json pins the ${CONTRACT_FREEZE_RELEASE} freeze and contract.lock.json is missing: restore it (git show v${CONTRACT_FREEZE_RELEASE}:contract.lock.json).`;
  return comparePluginVersions(platform, CONTRACT_FREEZE_RELEASE) >= 0
    ? `This is ${platform}, at or past the ${CONTRACT_FREEZE_RELEASE} freeze, and contract.lock.json is missing: restore it (git show v${CONTRACT_FREEZE_RELEASE}:contract.lock.json).`
    : null;
}

/**
 * Records what a seal test generated for a snapshot in this run
 * (`SCALIUS_CONTRACT_RUN`): the contract judge's `--run` then requires one
 * record per registered seal, equal to the committed file, so a seal test that
 * was skipped, never reached the helper, or sealed a file it read back from
 * disk is caught. A no-op outside such a run.
 */
async function recordGenerated(path: string, current: string): Promise<void> {
  const run = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SCALIUS_CONTRACT_RUN;
  if (!run || !/^[\w-]{1,64}$/.test(run)) return;
  const { mkdirSync, writeFileSync, resolve } = await node();
  const dir = resolve(await repositoryRoot(), "node_modules/.cache/contract-runs", run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${(await sha256Hex(path)).slice(0, 16)}.json`), JSON.stringify({ path, sha256: await sha256Hex(current) }));
}

/** What the ledger and the lock refuse in moving from the committed snapshot to the current one (empty: it may be sealed). */
export async function openContractBreaks(seal: SealedSnapshot, committed?: string | null): Promise<OpenBreak[]> {
  const { relative, readFileSync, existsSync, resolve } = await node();
  const root = await repositoryRoot();
  await recordGenerated(relative(root, await filePath(seal.file)), seal.current);
  const lock = await readContractLock(root);
  const path = relative(root, await filePath(seal.file));
  const missing = missingLockProblem(lock, SCALIUS_PLATFORM_VERSION, await anchorPinned(root));
  if (missing) return [{ snapshot: seal.snapshot, from: "", change: `${path}: no contract lock.`, reason: "", refused: missing }];
  return contractOpenBreaks({
    snapshot: seal.snapshot,
    path,
    ledgerPath: relative(root, await filePath(seal.ledgerFile)),
    committed: committed === undefined ? await committedSnapshot(seal.file) : committed,
    current: seal.current,
    breakingChanges: seal.breakingChanges,
    ledger: seal.ledger,
    lock,
    lockedText: (blob) => lockedGitText(blob, root),
    supportedVersions: SUPPORTED_PLUGIN_API_VERSIONS,
    advisory: (id) => {
      const file = resolve(root, CONTRACT_ADVISORIES_DIR, `${id}.md`);
      return /^[\w-]+$/.test(id) && existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    today: new Date().toISOString().slice(0, 10),
  });
}

/**
 * Refuses what the ledger and the lock do not accept, then seals the current
 * snapshot, in one test so `vitest -u` cannot write past a refusal.
 * `beforeLock: "review"` keeps a snapshot that `-u` accepted after review
 * (the theme document, the private anatomy, the save reasons, the refusal
 * census) exactly that until the lock exists; from the lock on, it follows
 * its ledger like every other seal.
 */
export async function sealCompatibly(seal: SealedSnapshot & { beforeLock?: "ledger" | "review"; message?: string }): Promise<void> {
  const lock = await readContractLock();
  const { relative: relativePath } = await node();
  await recordGenerated(relativePath(await repositoryRoot(), await filePath(seal.file)), seal.current);
  if (lock || missingLockProblem(lock, SCALIUS_PLATFORM_VERSION, await anchorPinned()) || seal.beforeLock !== "review") {
    const { relative } = await node();
    const name = relative(await repositoryRoot(), await filePath(seal.ledgerFile));
    expect(await openContractBreaks(seal), seal.message ?? `Breaking changes in ${seal.snapshot}. Keep the old shape, or add these entries with a reason${lock ? " and a type (after the lock: security with its advisory, or wording for a reworded error meaning)" : ""} to ${name}.`).toEqual([]);
  }
  await expect(seal.current).toMatchFileSnapshot(await filePath(seal.file));
}
