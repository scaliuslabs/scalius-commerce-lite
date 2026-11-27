// The contract lock (`contract.lock.json` at the repository root): what the
// theme and app contract was when it froze, and the rule every seal follows
// after it. Import-free on purpose: `scripts/contract-lock.mjs` (which writes
// the lock and types the ledgers) loads this file directly with Node, and the
// seal tests load it through `seal.testing.ts`, so both read one rule.
//
// A break ledger (`abi.breaks.json` and the others) holds entries
// `{ snapshot, from, change, reason, type }`: one acknowledged change line of
// one sealed snapshot, from the snapshot whose fingerprint is `from`. `type`:
//
//   growth       additive (a new optional field, union member, operation,
//                error code): nothing that worked stops working. A seal that
//                cannot tell growth from a break (the SDK's declarations)
//                still asks for an entry.
//   pre-lock     a real break made before the freeze. None is accepted after it.
//   security     a tightening that closes a hole; names its advisory
//                (`advisory: { id, date }`).
//   new-version  belongs to a new contract version (`version`), never the
//                locked one.
//
// Before a lock exists every seal behaves as it always did: a change line
// needs an entry with a reason from the committed snapshot's fingerprint,
// whatever its type. With a lock, each seal also compares the current
// snapshot with the LOCKED one (read from git by its blob id), and every
// difference must be covered by an entry written after the lock (the ledger's
// entries past the count the lock recorded) typed growth, security or
// new-version. The entries before the lock are history: the lock holds their
// digest, so editing or retyping one is refused.

export const LEDGER_ENTRY_TYPES = ["growth", "pre-lock", "security", "new-version"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface LedgerAdvisory {
  /** The advisory's id, as the release notes and SECURITY.md name it. */
  id: string;
  /** Its date, `YYYY-MM-DD`. */
  date: string;
}

/** One acknowledged change line of one sealed snapshot. */
export interface LedgerEntry {
  snapshot: string;
  from: string;
  change: string;
  reason: string;
  type?: LedgerEntryType;
  advisory?: LedgerAdvisory;
  /** For `new-version`: the contract version the change belongs to. */
  version?: string;
}

/** A change line no entry accepts (a template to fill in), or an entry the lock refuses (`refused` says why). */
export type OpenBreak = LedgerEntry & { refused?: string };

/** A file as the lock recorded it: its SHA-256 and its git blob id (how a seal reads the locked text back). */
export interface LockedFile {
  sha256: string;
  blob: string;
}

export interface ContractLock {
  lock: 1;
  /** The platform release the lock was written at (`SCALIUS_PLATFORM_VERSION`). */
  platform: string;
  /** The contract version at the lock (`PLUGIN_API_VERSION`). */
  contractVersion: string;
  /** Every rewrite of the lock after the first, with its reason. */
  relocks: Array<{ platform: string; reason: string }>;
  /** Compatibility-ruled snapshots by repository path: they may change after the lock only as their ledger allows. */
  seals: Record<string, LockedFile>;
  /** Files that never change after the lock (theme goldens, replay bundles frozen at the lock and their expectations). */
  frozen: Record<string, LockedFile>;
  /** Each ledger's entries at the lock: how many, and the digest of exactly those. */
  ledgers: Record<string, { entries: number; sha256: string }>;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesOf = (value: string | Uint8Array) => (typeof value === "string" ? new TextEncoder().encode(value) : value);

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytesOf(value) as Uint8Array<ArrayBuffer>));
}

/** The ledger fingerprint of a snapshot's text (the first 8 bytes of its SHA-256), as `from` names it. */
export async function ledgerFingerprint(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16);
}

/** Git's id for a file's content (`git hash-object`), so a seal can read the locked text with `git cat-file blob`. */
export async function gitBlobId(value: string | Uint8Array): Promise<string> {
  const content = bytesOf(value);
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const whole = new Uint8Array(header.byteLength + content.byteLength);
  whole.set(header);
  whole.set(content, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", whole));
}

export async function lockedFile(value: string | Uint8Array): Promise<LockedFile> {
  return { sha256: await sha256Hex(value), blob: await gitBlobId(value) };
}

/** The digest of a ledger's first entries, as written (key order included). */
export async function ledgerDigest(entries: readonly unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify(entries));
}

/**
 * Change lines that are a removal or a tightening by their own words: never
 * growth, whatever an entry claims. (The SDK seal's "an existing signature
 * changed" says neither, so growth there is the reviewer's word.)
 */
const NEVER_GROWTH = /was removed|no longer|tightened|newly required|a new required|may now be null|went back|changed from|is now required|a new refusal|moved from|type changed|a new limit|now names who may|a new contract version/;
/** A change line that is a contract version change: only a `new-version` entry accepts it. */
const VERSION_CHANGE = /: a new contract version\.$/;

/** Why an entry written after the lock cannot accept a change, or null. */
export function postLockEntryProblem(entry: LedgerEntry, lock: Pick<ContractLock, "contractVersion">, supportedVersions?: readonly string[]): string | null {
  if (!entry.reason?.trim()) return "An entry needs a reason.";
  if (entry.type === undefined) return "An entry after the lock has a type: growth, security (with its advisory) or new-version.";
  if (!(LEDGER_ENTRY_TYPES as readonly string[]).includes(entry.type)) return `Unknown entry type ${JSON.stringify(entry.type)}.`;
  if (entry.type === "pre-lock") return "Pre-lock entries end at the lock: a break now is a security fix or a new contract version.";
  if (entry.type === "growth" && NEVER_GROWTH.test(entry.change)) return "This change removes or tightens something: it is not growth.";
  if (VERSION_CHANGE.test(entry.change) && entry.type !== "new-version") return "A contract version change is accepted only as new-version.";
  if (entry.type === "security") {
    const advisory = entry.advisory;
    if (!advisory || !advisory.id?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(advisory.date ?? "")) {
      return 'A security entry names its advisory: "advisory": { "id": "…", "date": "YYYY-MM-DD" }.';
    }
  }
  if (entry.type === "new-version") {
    if (!entry.version || entry.version === lock.contractVersion) return `A new-version entry names the contract version it belongs to, other than the locked ${lock.contractVersion}.`;
    // A new version is real only when this build runs it beside the locked one (an adapter keeps the old shapes).
    if (!supportedVersions) return "A new-version entry is checked against the versions this build supports.";
    if (!supportedVersions.includes(entry.version)) return `Contract version ${entry.version} is not one this build supports (${supportedVersions.join(", ")}).`;
    if (!supportedVersions.includes(lock.contractVersion)) return `This build no longer supports the locked contract version ${lock.contractVersion}: a new version ships beside it.`;
  }
  return null;
}

/** The change lines no reasoned entry from `from` accepts, each as a template to fill in. */
function unaccepted(snapshot: string, from: string, changes: readonly string[], entries: readonly LedgerEntry[], template: Partial<LedgerEntry> = {}): OpenBreak[] {
  const accepted = new Set(entries.filter((entry) => entry.snapshot === snapshot && entry.from === from && entry.reason?.trim()).map((entry) => entry.change));
  return changes.filter((change) => !accepted.has(change)).map((change) => ({ snapshot, from, change, reason: "", ...template }));
}

export interface SealCheck {
  /** The ledger's name for the snapshot (`./abi.protocol.snapshot.json`). */
  snapshot: string;
  /** The snapshot's repository path, the lock's key for it. */
  path: string;
  /** The ledger's repository path, the lock's key for it. */
  ledgerPath: string;
  /** The committed snapshot's text, or null before the first one. */
  committed: string | null;
  current: string;
  /** The seal's own rule: the breaking change lines from one snapshot text to another. */
  breakingChanges: (before: string, after: string) => readonly string[];
  ledger: readonly LedgerEntry[];
  lock: ContractLock | null;
  /** The locked snapshot's text by its blob id (null when this clone does not hold it). */
  lockedText: (blob: string) => Promise<string | null>;
  supportedVersions?: readonly string[];
}

/** What a seal refuses: unaccepted change lines and, after the lock, entries the lock does not accept. Empty when the change may be sealed. */
export async function contractOpenBreaks(check: SealCheck): Promise<OpenBreak[]> {
  const { snapshot, committed, current, lock } = check;
  if (!lock) {
    if (committed === null || committed === current) return [];
    return unaccepted(snapshot, await ledgerFingerprint(committed), check.breakingChanges(committed, current), check.ledger);
  }
  const open: OpenBreak[] = [];
  const atLock = lock.ledgers[check.ledgerPath] ?? { entries: 0, sha256: await ledgerDigest([]) };
  if (await ledgerDigest(check.ledger.slice(0, atLock.entries)) !== atLock.sha256) {
    open.push({ snapshot, from: "", change: `${check.ledgerPath}: the ${atLock.entries} entries recorded at the lock changed.`, reason: "",
      refused: "Entries before the lock are history: append new entries, never edit, retype or remove one." });
  }
  const locked = lock.seals[check.path];
  const lockedFingerprint = locked?.sha256.slice(0, 16);
  if (lockedFingerprint) {
    for (const entry of check.ledger.slice(0, atLock.entries)) {
      if (entry.snapshot === snapshot && entry.from === lockedFingerprint) open.push({ ...entry, refused: "An entry from the locked snapshot was written before the lock." });
    }
  }
  const accepted: LedgerEntry[] = [];
  for (const entry of check.ledger.slice(atLock.entries)) {
    if (entry.snapshot !== snapshot) continue;
    const problem = postLockEntryProblem(entry, lock, check.supportedVersions);
    if (problem) open.push({ ...entry, refused: problem });
    else accepted.push(entry);
  }
  const template = { type: "" as unknown as LedgerEntryType };
  if (committed !== null && committed !== current) {
    open.push(...unaccepted(snapshot, await ledgerFingerprint(committed), check.breakingChanges(committed, current), accepted, template));
  }
  if (locked && await sha256Hex(current) !== locked.sha256) {
    const text = await check.lockedText(locked.blob);
    if (text === null || await sha256Hex(text) !== locked.sha256) {
      open.push({ snapshot, from: lockedFingerprint!, change: `${check.path}: the locked snapshot (git blob ${locked.blob}) is not in this clone.`, reason: "",
        refused: "The seal compares with the locked snapshot: fetch the history that holds it." });
    } else {
      const covered = new Set(accepted.map((entry) => entry.change));
      const from = await ledgerFingerprint(text);
      for (const change of check.breakingChanges(text, current)) {
        if (!covered.has(change)) open.push({ snapshot, from, change, reason: "", ...template });
      }
    }
  }
  const seen = new Set<string>();
  return open.filter((entry) => {
    const key = `${entry.from} ${entry.change} ${entry.refused ?? ""}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

/**
 * The type a ledger entry written before the lock gets when it has none:
 * growth when its change line or its reason says so plainly (the SDK seal
 * records a union that grew, an optional member or a new export as a changed
 * signature), else pre-lock. Never security or new-version: those are a
 * reviewer's call, made when the entry is written.
 */
export function classifyLedgerEntry(entry: Pick<LedgerEntry, "change" | "reason">): "growth" | "pre-lock" {
  if (NEVER_GROWTH.test(entry.change)) return "pre-lock";
  const reason = entry.reason.trim();
  if (/^(?:pre-release|pre-lock|before the rc\.1 freeze|merge of)\b/i.test(reason) && !GROWTH_REASON_STRONG.test(reason)) return "pre-lock";
  return GROWTH_REASON.test(reason) ? "growth" : "pre-lock";
}

/** Reasons that say the change only adds. */
const GROWTH_REASON = /^additive\b|\bsealed codes are only added\b|\bthe union grew by (?:a )?members? only\b|\bwidens the \w+ union\b|\b(?:input|output) fields? only grew\b|\bonly widens\b|\bevery existing (?:manifest|feature|translation) (?:parses|stays)\b|\breads the same\b|\bevery old reader keeps working\b|\ban added union arm\b|\bonly (?:added|adds)\b/i;
/** The same, said plainly enough to outweigh a "pre-release" label (the change it records is growth all the same). */
const GROWTH_REASON_STRONG = /\ban added union arm and an optional field\b|\bthe union grew by (?:a )?members? only\b|\bsealed codes are only added\b/i;
