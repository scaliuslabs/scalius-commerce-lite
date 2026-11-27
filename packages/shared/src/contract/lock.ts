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
//   growth       additive: nothing that worked stops working. Real growth makes
//                no change line at all (every rule lets growth pass), so after
//                the lock no `growth` entry is accepted. A changed pattern is
//                always a line: a needed one is a security fix or waits for the
//                next contract version.
//   wording      a reworded meaning or description (`WORDING_LINES`): the code,
//                status and details hold. Accepted after the lock.
//   pre-lock     a real break made before the freeze. None is accepted after it.
//   security     a tightening that closes a hole; names its advisory, a file
//                `packages/plugin-sdk/advisories/<id>.md` in the public tree
//                whose front matter lists the same date and the exact change.
//   new-version  belongs to a new contract version. Refused after the lock
//                until per-version snapshots and the host adapter exist
//                (promise.md: the adapter is built with the first new version).
//
// Before a lock exists every seal behaves as it always did: a change line
// needs an entry with a reason from the committed snapshot's fingerprint,
// whatever its type. With a lock, each seal also compares the current
// snapshot with the LOCKED one (read from git by its blob id), and every
// difference must be covered by an entry written after the lock (the ledger's
// entries past the count the lock recorded) typed growth, security or
// new-version. The entries before the lock are history: the lock holds their
// digest, so editing or retyping one is refused.

export const LEDGER_ENTRY_TYPES = ["growth", "pre-lock", "security", "new-version", "wording"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** The release the contract freezes at: from it on a lock must exist, and only it may write the first one. */
export const CONTRACT_FREEZE_RELEASE = "2.0.0-rc.1";
/** Where a security entry's advisory lives (kept in the public export). */
export const CONTRACT_ADVISORIES_DIR = "packages/plugin-sdk/advisories";

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
 * Lines that change only words a reader is told (an error code's meaning): a
 * `wording` entry accepts them after the lock, since the code, its status and
 * details hold.
 */
export const WORDING_LINES: readonly RegExp[] = [/^errors\.[a-z0-9_]+: the meaning changed\.$/];

/** Lines that remove or tighten by their own words (the classifier of entries written before the lock reads them). */
const NEVER_GROWTH = /was removed|no longer|tightened|newly required|a new required|may now be null|went back|changed from|is now required|a new refusal|moved from|type changed|a new limit|now names who may|a new contract version/;

/** A change line that is a contract version change. */
const VERSION_CHANGE = /: a new contract version\.$/;

/** Why an advisory file does not stand behind a security entry, or null. Its front matter: `id`, `date`, `changes: [{ "snapshot", "change" }]` (JSON). */
export function advisoryProblem(entry: LedgerEntry, text: string | null, today: string): string | null {
  const advisory = entry.advisory;
  if (!advisory || !/^SC-\d{4}-\d{3}$/.test(advisory.id ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(advisory.date ?? "")) {
    return 'A security entry names its advisory: "advisory": { "id": "SC-YYYY-NNN", "date": "YYYY-MM-DD" }.';
  }
  const file = `${CONTRACT_ADVISORIES_DIR}/${advisory.id}.md`;
  if (text === null) return `${file} does not exist (start from ${CONTRACT_ADVISORIES_DIR}/TEMPLATE.md).`;
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const field = (name: string) => front.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  if (field("id") !== advisory.id) return `${file} names another id.`;
  if (field("date") !== advisory.date) return `${file} is dated ${field("date") ?? "nowhere"}, the entry ${advisory.date}.`;
  if (advisory.date > today) return `${file} is dated in the future (${advisory.date}).`;
  let changes: unknown = null;
  try {
    changes = JSON.parse(field("changes") ?? "null");
  } catch {
    changes = null;
  }
  const listed = Array.isArray(changes) && changes.some((item) => item && typeof item === "object"
    && (item as Record<string, unknown>).snapshot === entry.snapshot && (item as Record<string, unknown>).change === entry.change);
  return listed ? null : `${file} does not list this change: its "changes" names the snapshot ${entry.snapshot} and the exact line.`;
}

/** What else a post-lock entry is judged with: the versions this build runs, its advisory file and today. */
export interface EntryContext {
  supportedVersions?: readonly string[];
  advisory?: (id: string) => string | null;
  today?: string;
}

/** Why an entry written after the lock cannot accept a change, or null. */
export function postLockEntryProblem(entry: LedgerEntry, lock: Pick<ContractLock, "contractVersion">, context: EntryContext = {}): string | null {
  if (!entry.reason?.trim()) return "An entry needs a reason.";
  if (entry.type === undefined) return "An entry after the lock has a type: security (with its advisory), or wording for a reworded meaning.";
  if (!(LEDGER_ENTRY_TYPES as readonly string[]).includes(entry.type)) return `Unknown entry type ${JSON.stringify(entry.type)}.`;
  if (entry.type === "pre-lock") return "Pre-lock entries end at the lock: a break now is a security fix.";
  if (entry.type === "new-version") {
    return `No new contract version can ship yet: per-version snapshots and the host adapter that keeps ${lock.contractVersion}'s shapes come first (promise.md, Versions).`;
  }
  if (VERSION_CHANGE.test(entry.change)) return "A contract version change ships only as a new version, which needs per-version snapshots and the host adapter first.";
  if (entry.type === "growth") return "Every line a compat rule writes is a break: growth makes no line. A break after the lock ships only as a security fix.";
  if (entry.type === "wording") return WORDING_LINES.some((line) => line.test(entry.change)) ? null : "A wording entry is for a reworded meaning or description only (WORDING_LINES).";
  return advisoryProblem(entry, context.advisory?.(entry.advisory?.id ?? "") ?? null, context.today ?? new Date().toISOString().slice(0, 10));
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
  /** An advisory file's text by its id (null when it does not exist). */
  advisory?: (id: string) => string | null;
  /** Today, `YYYY-MM-DD` (an advisory is never dated after it). */
  today?: string;
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
  if (!locked) {
    open.push({ snapshot, from: "", change: `${check.path}: not a locked seal.`, reason: "",
      refused: "Every seal is in the lock: a snapshot at a new path, or a new seal, joins only with the next lock (a new contract version)." });
    return open;
  }
  const text = await sha256Hex(current) === locked.sha256 ? current : await check.lockedText(locked.blob);
  if (text === null || await sha256Hex(text) !== locked.sha256) {
    open.push({ snapshot, from: lockedFingerprint!, change: `${check.path}: the locked snapshot (git blob ${locked.blob}) is not in this clone.`, reason: "",
      refused: "The seal compares with the locked snapshot: fetch the history that holds it." });
    return open;
  }
  const context: EntryContext = { supportedVersions: check.supportedVersions, advisory: check.advisory, today: check.today };
  const accepted: LedgerEntry[] = [];
  for (const entry of check.ledger.slice(atLock.entries)) {
    if (entry.snapshot !== snapshot) continue;
    const problem = postLockEntryProblem(entry, lock, context);
    if (problem) open.push({ ...entry, refused: problem });
    else accepted.push(entry);
  }
  const template = { type: "" as unknown as LedgerEntryType };
  if (committed !== null && committed !== current) {
    open.push(...unaccepted(snapshot, await ledgerFingerprint(committed), check.breakingChanges(committed, current), accepted, template));
  }
  if (text !== current) {
    const covered = new Set(accepted.map((entry) => entry.change));
    const from = await ledgerFingerprint(text);
    for (const change of check.breakingChanges(text, current)) {
      if (!covered.has(change)) open.push({ snapshot, from, change, reason: "", ...template });
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
