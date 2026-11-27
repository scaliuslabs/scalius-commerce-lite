// The one way a seal test checks a snapshot against its break ledger and the
// contract lock (lock.ts). Test-only: it reads files and git, through runtime
// specifiers that keep Node types out of this Workers package (as
// plugins/abi.snapshot.test.ts does).
import { expect } from "vitest";
import { SUPPORTED_PLUGIN_API_VERSIONS } from "../plugins/api-version";
import { contractOpenBreaks, type ContractLock, type LedgerEntry, type OpenBreak } from "./lock";

interface NodeIo {
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
  execFileSync(file: string, args: string[], options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"]; maxBuffer: number }): string;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  fileURLToPath(url: URL): string;
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
  /** The snapshot file, absolute. */
  file: string;
  /** The ledger's name for it (each ledger keeps the names its entries already use). */
  snapshot: string;
  /** The break ledger, absolute. */
  ledgerFile: string;
  ledger: readonly LedgerEntry[];
  current: string;
  breakingChanges: (before: string, after: string) => readonly string[];
}

/** A file's text (a test reads its snapshots and fixtures through this, without Node types). */
export async function readText(file: string | URL): Promise<string> {
  const { readFileSync, fileURLToPath } = await node();
  return readFileSync(typeof file === "string" ? file : fileURLToPath(file), "utf8");
}

/** The committed text of a snapshot, or null before the first one. */
export async function committedSnapshot(file: string): Promise<string | null> {
  const { readFileSync, existsSync } = await node();
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** What the ledger and the lock refuse in moving from the committed snapshot to the current one (empty: it may be sealed). */
export async function openContractBreaks(seal: SealedSnapshot, committed?: string | null): Promise<OpenBreak[]> {
  const { relative } = await node();
  const root = await repositoryRoot();
  return contractOpenBreaks({
    snapshot: seal.snapshot,
    path: relative(root, seal.file),
    ledgerPath: relative(root, seal.ledgerFile),
    committed: committed === undefined ? await committedSnapshot(seal.file) : committed,
    current: seal.current,
    breakingChanges: seal.breakingChanges,
    ledger: seal.ledger,
    lock: await readContractLock(root),
    lockedText: (blob) => lockedGitText(blob, root),
    supportedVersions: SUPPORTED_PLUGIN_API_VERSIONS,
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
  if (lock || seal.beforeLock !== "review") {
    const { relative } = await node();
    const name = relative(await repositoryRoot(), seal.ledgerFile);
    expect(await openContractBreaks(seal), seal.message ?? `Breaking changes in ${seal.snapshot}. Keep the old shape, or add these entries with a reason${lock ? " and a type (growth, security with its advisory, or new-version)" : ""} to ${name}.`).toEqual([]);
  }
  await expect(seal.current).toMatchFileSnapshot(seal.file);
}
