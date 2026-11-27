// The one way a seal test checks a snapshot against its break ledger and the
// contract lock (lock.ts). Test-only: it reads files and git, through runtime
// specifiers that keep Node types out of this Workers package (as
// plugins/abi.snapshot.test.ts does).
import { expect } from "vitest";
import { SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "../plugins/api-version";
import { comparePluginVersions } from "../plugins/versions";
import { CONTRACT_ADVISORIES_DIR, CONTRACT_FREEZE_RELEASE, contractOpenBreaks, type ContractLock, type LedgerEntry, type OpenBreak } from "./lock";

interface NodeIo {
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
  execFileSync(file: string, args: string[], options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"]; maxBuffer: number }): string;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  fileURLToPath(url: string | URL): string;
}

let io: Promise<NodeIo> | null = null;

function node(): Promise<NodeIo> {
  io ??= Promise.all(["node:fs", "node:child_process", "node:path", "node:url"].map((specifier) => import(/* @vite-ignore */ specifier)))
    .then(([fs, child, path, url]) => ({ ...fs, ...child, ...path, ...url }) as NodeIo);
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

/** From the freeze release on, a missing lock is itself a refusal: the seals never fall back to the rules before it. */
export function missingLockProblem(lock: ContractLock | null, platform: string = SCALIUS_PLATFORM_VERSION): string | null {
  return lock === null && comparePluginVersions(platform, CONTRACT_FREEZE_RELEASE) >= 0
    ? `This is ${platform}, at or past the ${CONTRACT_FREEZE_RELEASE} freeze, and contract.lock.json is missing: restore it (git show <release tag>:contract.lock.json).`
    : null;
}

/** What the ledger and the lock refuse in moving from the committed snapshot to the current one (empty: it may be sealed). */
export async function openContractBreaks(seal: SealedSnapshot, committed?: string | null): Promise<OpenBreak[]> {
  const { relative, readFileSync, existsSync, resolve } = await node();
  const root = await repositoryRoot();
  const lock = await readContractLock(root);
  const path = relative(root, await filePath(seal.file));
  const missing = missingLockProblem(lock);
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
  if (lock || missingLockProblem(lock) || seal.beforeLock !== "review") {
    const { relative } = await node();
    const name = relative(await repositoryRoot(), await filePath(seal.ledgerFile));
    expect(await openContractBreaks(seal), seal.message ?? `Breaking changes in ${seal.snapshot}. Keep the old shape, or add these entries with a reason${lock ? " and a type (growth, security with its advisory, or new-version)" : ""} to ${name}.`).toEqual([]);
  }
  await expect(seal.current).toMatchFileSnapshot(await filePath(seal.file));
}
