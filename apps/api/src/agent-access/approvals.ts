// A person's approval of one gated agent change, given in the dashboard
// (decision D2, audit R2 F3). The agent never holds anything it could redeem
// on its own: a refused change gets an approval link for the grant's owner,
// who opens it in a 2FA-verified dashboard session and approves or declines
// exactly the summary shown. Only then does the agent's retry with the
// approval id run, once, for exactly the operations and inputs approved.
//
// Approvals are rows in `agent_browser_handoffs` (operation id
// `approval:<operation>`, the encrypted payload holds the binding and the
// summary): pending (`active`) for 5 minutes, then approved (`consumed`, with
// a fresh 5-minute window to redeem it) or declined (`expired`). Redeeming
// deletes the row, so a replay finds nothing.
import { nanoid } from "nanoid";
import { sha256Hex } from "@scalius/shared/hash";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { agentBrowserHandoffs } from "@scalius/database/schema";
import { APPROVAL_RECORD_KINDS, type ApprovalRecordKind } from "@scalius/shared/agent-approval";
import { readApprovalRecords, type AgentApprovalRecord } from "./approval-records";
import { decryptCredentialBytes, encryptCredential } from "@scalius/core/utils/credential-encryption";
import { handoffActionOwner } from "./browser-handoffs";
import { readAgentConnection } from "./audit";
import {
  APPROVAL_OPERATION_PREFIX,
  dashboardOrigin,
  grantAuthorityGuard,
  requireEncryptionKey,
} from "./browser-handoffs";
import { AgentDispatchError, agentConnectionInactive } from "./dispatch-error";
import {
  SUMMARY_NOTE_CODES,
  SUMMARY_ROW_KINDS,
  SUMMARY_VALUE_TYPES,
  cleanSummaryText,
  incompleteSummaryReasons,
  summaryText,
  type SummaryNoteCode,
  type SummaryRow,
  type SummaryRowKind,
  type SummaryValueType,
} from "./summary-rows";
import type { AgentPrincipal } from "./types";

/** The REST lane's retry header: `Scalius-Approval: abh_...`. */
export const APPROVAL_HEADER = "Scalius-Approval";
export const APPROVAL_ID_PATTERN = /^abh_[A-Za-z0-9_-]{20}$/;
const APPROVAL_TTL_SECONDS = 5 * 60;
const isApproval = sql`substr(${agentBrowserHandoffs.operationId}, 1, ${APPROVAL_OPERATION_PREFIX.length}) = ${APPROVAL_OPERATION_PREFIX}`;

interface ApprovalPayload {
  kind: "approval";
  binding: string;
  /** What the owner reads, as typed rows (written by mcp/confirm-summary.ts, shaped by ./summary-rows.ts); the page labels each by its kind. */
  rows: SummaryRow[];
  operationIds: string[];
}

const RECORD_KINDS: ReadonlySet<string> = new Set(APPROVAL_RECORD_KINDS);

/**
 * Records (or entries) one approval holds and shows whole: the dashboard bulk
 * editor's own 200 rows. Every gated list up to it is kept and shown in full
 * ("Show all"); a bigger change, or one whose stored form would not fit the
 * row's 8 KiB, is refused before anyone is asked, telling the agent how to
 * split it. Nothing is ever stored in part.
 */
export const APPROVAL_MAX_RECORDS = 200;
/** The table's bound on the encrypted payload (agent_browser_handoffs_encrypted_action). */
const ENCRYPTED_ACTION_MAX_CHARS = 8_192;

/** A change too large for one approval: the agent is told the largest piece to send instead. */
export class AgentApprovalTooLargeError extends AgentDispatchError {
  constructor(readonly maxRecords: number) {
    super(
      "approval_too_large",
      `Nothing ran: this change is too large for one approval. Split it into changes of at most ${maxRecords} records each and send each one on its own; each gets its own approval link.`,
      422,
    );
  }
}

/** The rows as stored and shown: every row the request carries, each value cleaned, nothing cut. */
function storedRows(value: unknown): SummaryRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SummaryRow[] = [];
  for (const item of value) {
    const row = item as Partial<SummaryRow> | null;
    if (!row || !SUMMARY_ROW_KINDS.includes(row.kind as SummaryRowKind) || typeof row.text !== "string" || typeof row.operationId !== "string") continue;
    const values = Array.isArray(row.values)
      ? row.values.map((value) => value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
        ? value
        : cleanSummaryText(String(value)))
      : undefined;
    const text = cleanSummaryText(row.text);
    rows.push({
      kind: row.kind!,
      operationId: row.operationId.slice(0, 240),
      field: typeof row.field === "string" ? cleanSummaryText(row.field, 120) : null,
      // Values shown as they are need no second copy in the 8 KiB row: their text is the values.
      text: values && text === values.map(String).join(", ") ? "" : text,
      ...(typeof row.amount === "string" && /^-?\d+(?:\.\d+)?$/.test(row.amount) ? { amount: row.amount } : {}),
      ...(row.kind === "money" ? { currency: typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null } : {}),
      ...(values ? { values } : {}),
      ...(SUMMARY_VALUE_TYPES.includes(row.type as SummaryValueType) ? { type: row.type } : {}),
      ...(row.kind === "note" && SUMMARY_NOTE_CODES.includes(row.code as SummaryNoteCode) ? { code: row.code } : {}),
      ...(typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count >= 0 ? { count: row.count } : {}),
      ...(row.kind === "target" && (row.record === "part" || RECORD_KINDS.has(String(row.record))) ? { record: row.record } : {}),
      ...(Array.isArray(row.entries) && row.entries.every((entry) => Number.isSafeInteger(entry) && entry >= 0) ? { entries: row.entries } : {}),
    });
  }
  return rows;
}

/** The most values (records or entries) any one row carries. */
function largestList(rows: readonly SummaryRow[]): number {
  return Math.max(1, ...rows.map((row) => Math.max(row.values?.length ?? 0, row.entries?.length ?? 0)));
}

async function deflated(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/**
 * The most a stored approval may hold once inflated. A repetitive change
 * compresses a thousandfold, so the 8 KiB row alone does not bound what the
 * owner's page would have to read; past this the change is refused when stored
 * and unreadable (so unapprovable) when read.
 */
const APPROVAL_MAX_PLAIN_BYTES = 256 * 1024;

async function inflated(bytes: Uint8Array): Promise<string> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > APPROVAL_MAX_PLAIN_BYTES) {
      await reader.cancel();
      throw new Error("approval payload too large");
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(whole);
}

/**
 * The payload as stored: compressed (a list of SKU ids shares most of each id)
 * and encrypted, within the row's 8 KiB, or the refusal that says how to split it.
 */
async function sealPayload(payload: ApprovalPayload, env: Env, approvalId: string): Promise<string> {
  const largest = largestList(payload.rows);
  if (largest > APPROVAL_MAX_RECORDS) throw new AgentApprovalTooLargeError(APPROVAL_MAX_RECORDS);
  const plain = JSON.stringify(payload);
  if (new TextEncoder().encode(plain).byteLength > APPROVAL_MAX_PLAIN_BYTES) {
    throw new AgentApprovalTooLargeError(Math.max(1, Math.floor(largest / 2)));
  }
  const sealed = await encryptCredential(await deflated(plain), requireEncryptionKey(env), handoffActionOwner(approvalId));
  if (sealed.length > ENCRYPTED_ACTION_MAX_CHARS) {
    throw new AgentApprovalTooLargeError(Math.max(1, Math.floor(largest * (ENCRYPTED_ACTION_MAX_CHARS / sealed.length) * 0.9)));
  }
  return sealed;
}

export interface AgentApprovalLink {
  approvalId: string;
  approvalUrl: string;
  expiresAt: string;
}

/** The change is still waiting for its owner: the same 428 as the first refusal, with the same link. */
export class AgentApprovalPendingError extends AgentDispatchError {
  constructor(readonly confirmation: AgentApprovalLink & { summary: string }) {
    super("confirmation_required", "Nothing ran: the store owner has not approved this change in the dashboard yet. Wait, then repeat the same request with the approval id; the link is confirmation.approvalUrl.", 428);
  }
}

function approvalUrlFor(env: Env, approvalId: string): string {
  return `${dashboardOrigin(env)}/admin/settings/agent-access/approve/${approvalId}`;
}

async function readPayload(approvalId: string, encrypted: string, env: Env): Promise<ApprovalPayload | null> {
  try {
    const value = JSON.parse(await inflated(await decryptCredentialBytes(
      encrypted,
      requireEncryptionKey(env),
      handoffActionOwner(approvalId),
    ))) as Partial<ApprovalPayload>;
    if (value.kind !== "approval" || typeof value.binding !== "string" || !Array.isArray(value.rows) || !Array.isArray(value.operationIds)) return null;
    return value as ApprovalPayload;
  } catch {
    return null;
  }
}

/** Asks the grant's owner to approve these gated operations; returns the link for them. */
export async function requestAgentApproval(
  db: Database,
  env: Env,
  principal: AgentPrincipal,
  input: { binding: string; rows: readonly SummaryRow[]; operationIds: readonly string[] },
): Promise<AgentApprovalLink & { summary: string }> {
  const now = Math.floor(Date.now() / 1000);
  const approvalId = `abh_${nanoid(20)}`;
  const payload: ApprovalPayload = {
    kind: "approval",
    binding: input.binding,
    rows: storedRows(input.rows),
    operationIds: [...input.operationIds].slice(0, 20),
  };
  const encryptedAction = await sealPayload(payload, env, approvalId);
  const url = approvalUrlFor(env, approvalId);
  try {
    await safeBatch(db, [
      buildBatchGuard(db, grantAuthorityGuard(principal), "AGENT_APPROVAL_AUTHORITY_INACTIVE"),
      db.insert(agentBrowserHandoffs).values({
        id: approvalId,
        grantId: principal.grantId,
        credentialId: principal.credentialId,
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        operationId: `${APPROVAL_OPERATION_PREFIX}${payload.operationIds[0] ?? "batch"}`.slice(0, 240),
        authorityRevision: principal.authorityRevision,
        encryptedAction,
        status: "active",
        expiresAt: new Date((now + APPROVAL_TTL_SECONDS) * 1000),
        createdAt: new Date(now * 1000),
        updatedAt: new Date(now * 1000),
      }),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, "AGENT_APPROVAL_AUTHORITY_INACTIVE")) {
      throw agentConnectionInactive();
    }
    throw error;
  }
  return {
    approvalId,
    approvalUrl: url,
    expiresAt: new Date((now + APPROVAL_TTL_SECONDS) * 1000).toISOString(),
    summary: await approvalSummary(db, payload.rows),
  };
}

/** Who asks: the connection's name and the client it runs in, from the grant record. */
export interface AgentApprovalRequester {
  name: string;
  /** The OAuth client or the paired CLI's client ("Claude Code"); null for an access key. */
  client: string | null;
  kind: "oauth" | "pat" | "cli";
}

export type { AgentApprovalRecord };

/** A kind of record the change acts on: every one its rows name, each by its id with its stored name (untrusted text). */
export interface AgentApprovalTarget {
  kind: ApprovalRecordKind;
  total: number;
  records: AgentApprovalRecord[];
}

export interface AgentApprovalView {
  approvalId: string;
  status: "pending" | "approved";
  /** The rows as plain text, for clients that show text. */
  summary: string;
  rows: SummaryRow[];
  operationIds: string[];
  expiresAt: string;
  requester: AgentApprovalRequester | null;
  targets: AgentApprovalTarget[];
  /** Why the change cannot be approved (records it names that cannot be named, parts not shown); empty when it can. */
  unreviewable: string[];
  /**
   * A digest of the records as the page shows them (names, amounts, a role's
   * permissions): the page sends it back with its approval, which is refused
   * when a record changed since the person read it.
   */
  recordsDigest: string;
}

async function readRequester(db: Database, grantId: string): Promise<AgentApprovalRequester | null> {
  return readAgentConnection(db, grantId);
}

/** Every record the rows name, by kind, in the order they first appear (parts and unknown ids are not records). */
function namedIds(rows: readonly SummaryRow[]): Map<ApprovalRecordKind, string[]> {
  const byKind = new Map<ApprovalRecordKind, Set<string>>();
  for (const row of rows) {
    if (row.kind !== "target" || !row.record || row.record === "part") continue;
    const ids = byKind.get(row.record) ?? new Set<string>();
    for (const value of row.values ?? []) if (typeof value === "string" || typeof value === "number") ids.add(String(value));
    byKind.set(row.record, ids);
  }
  return new Map([...byKind].map(([kind, ids]) => [kind, [...ids]]));
}

/** Every record the rows name, each kind's names in bounded reads (an approval bounds its ids). */
async function readTargets(db: Database, rows: readonly SummaryRow[]): Promise<AgentApprovalTarget[]> {
  const targets: AgentApprovalTarget[] = [];
  for (const [kind, ids] of namedIds(rows)) {
    targets.push({ kind, total: ids.length, records: await readApprovalRecords(db, kind, ids) });
  }
  return targets;
}

/**
 * The summary the agent reads, in the page's words and with the records the
 * page names (a name with its id beside), never bare ids. The rows are cleaned
 * as they are stored, so an id list the approval would refuse reads no records.
 */
export async function approvalSummary(db: Database, rows: readonly SummaryRow[]): Promise<string> {
  const kept = storedRows(rows);
  return summaryText(kept, largestList(kept) > APPROVAL_MAX_RECORDS ? [] : await readTargets(db, kept));
}

/** The records as shown, canonically: every field the page reads of each, in order. */
async function recordsDigest(targets: readonly AgentApprovalTarget[]): Promise<string> {
  return sha256Hex(JSON.stringify(targets.map((target) => [
    target.kind,
    target.records.map((record) => [record.id, record.name, record.amount ?? null, record.currency ?? null, record.permissions ?? null]),
  ])));
}

/** A place picked from the store's places, or typed: a value that names no place is the text staff typed. */
const TYPED_WHEN_UNKNOWN: ReadonlySet<ApprovalRecordKind> = new Set(["place"]);

/**
 * Why these rows cannot be approved as named: an id of a kind the page cannot
 * name, a record that has no name (gone, or not of that kind), a role whose
 * permissions cannot be shown. The page refuses the same (approval-describe.ts).
 */
export function unnamedRecordReasons(rows: readonly SummaryRow[], targets: readonly AgentApprovalTarget[]): string[] {
  const named = new Map(targets.map((target) => [target.kind, new Map(target.records.map((record) => [record.id, record]))]));
  const reasons = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "target" || row.record === "part") continue;
    if (!row.record) {
      reasons.add(`unknown_record:${row.field ?? ""}`);
      continue;
    }
    for (const value of row.values ?? []) {
      const record = named.get(row.record)?.get(String(value));
      if (!record?.name && !TYPED_WHEN_UNKNOWN.has(row.record)) reasons.add(`unnamed:${row.record}`);
      if (row.record === "role" && record?.name && !record.permissions) reasons.add("role_permissions_unknown");
    }
  }
  return [...reasons];
}

/** What the owner approves: the summary of a live pending or approved request, for its owner only. */
export async function readAgentApproval(
  db: Database,
  env: Env,
  approvalId: string,
  ownerUserId: string,
): Promise<AgentApprovalView | null> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return null;
  const row = await db.select({
    status: agentBrowserHandoffs.status,
    expiresAt: agentBrowserHandoffs.expiresAt,
    encryptedAction: agentBrowserHandoffs.encryptedAction,
    grantId: agentBrowserHandoffs.grantId,
  }).from(agentBrowserHandoffs).where(and(
    eq(agentBrowserHandoffs.id, approvalId),
    eq(agentBrowserHandoffs.ownerUserId, ownerUserId),
    gt(agentBrowserHandoffs.expiresAt, new Date()),
    isApproval,
  )).get();
  if (!row || (row.status !== "active" && row.status !== "consumed")) return null;
  const payload = await readPayload(approvalId, row.encryptedAction, env);
  if (!payload) return null;
  const requester = await readRequester(db, row.grantId);
  const rows = storedRows(payload.rows);
  const targets = await readTargets(db, rows);
  return {
    approvalId,
    status: row.status === "active" ? "pending" : "approved",
    summary: summaryText(rows, targets),
    rows,
    operationIds: payload.operationIds,
    expiresAt: row.expiresAt.toISOString(),
    requester,
    targets,
    unreviewable: [...incompleteSummaryReasons(rows), ...unnamedRecordReasons(rows, targets)],
    recordsDigest: await recordsDigest(targets),
  };
}

/**
 * The owner's answer. Approving starts a fresh 5-minute window for the
 * agent's retry; declining closes the request. Only a pending request of a
 * still-active grant changes; returns whether this answer took effect.
 */
export async function decideAgentApproval(
  db: Database,
  approvalId: string,
  ownerUserId: string,
  decision: "approve" | "decline",
): Promise<boolean> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return false;
  const now = Math.floor(Date.now() / 1000);
  const pending = and(
    eq(agentBrowserHandoffs.id, approvalId),
    eq(agentBrowserHandoffs.ownerUserId, ownerUserId),
    eq(agentBrowserHandoffs.status, "active"),
    gt(agentBrowserHandoffs.expiresAt, new Date(now * 1000)),
    isApproval,
  );
  if (decision === "decline") {
    const rows = await db.update(agentBrowserHandoffs)
      .set({ status: "expired", updatedAt: new Date(now * 1000) })
      .where(pending)
      .returning({ id: agentBrowserHandoffs.id });
    return rows.length === 1;
  }
  const rows = await db.update(agentBrowserHandoffs)
    .set({
      status: "consumed",
      consumedAt: new Date(now * 1000),
      // The redemption window starts at the approval (the table caps a row at 5 minutes).
      createdAt: new Date(now * 1000),
      expiresAt: new Date((now + APPROVAL_TTL_SECONDS) * 1000),
      updatedAt: new Date(now * 1000),
    })
    .where(and(pending, sql`EXISTS (
      SELECT 1 FROM agent_grants
      WHERE agent_grants.id = ${agentBrowserHandoffs.grantId}
        AND agent_grants.owner_user_id = ${ownerUserId}
        AND agent_grants.authority_revision = ${agentBrowserHandoffs.authorityRevision}
        AND agent_grants.status = 'active'
        AND agent_grants.expires_at > unixepoch()
    )`))
    .returning({ id: agentBrowserHandoffs.id });
  return rows.length === 1;
}

/** A change the page cannot show in full: never approved, by the page or by a direct call. */
export class AgentApprovalNotReviewableError extends AgentDispatchError {
  constructor(readonly reasons: readonly string[]) {
    super("approval_not_reviewable", "This change cannot be shown in full, so it cannot be approved. Decline it.", 409);
  }
}

/**
 * The owner approves: only a pending request whose stored summary shows the
 * whole change (`incompleteSummaryReasons`), as the approval page requires
 * before it offers Approve. Returns whether the approval took effect.
 */
export async function approveAgentChange(db: Database, env: Env, approvalId: string, ownerUserId: string, shownDigest: string | null): Promise<boolean> {
  const approval = await readAgentApproval(db, env, approvalId, ownerUserId);
  const reasons = approval?.unreviewable ?? [];
  if (reasons.length > 0) throw new AgentApprovalNotReviewableError(reasons);
  // The owner approves the records as they read them: a role whose permissions, a payment whose
  // amount or a record whose name changed since is read again first.
  if (approval && approval.recordsDigest !== shownDigest) throw new AgentApprovalChangedError();
  return decideAgentApproval(db, approvalId, ownerUserId, "approve");
}

/** A record the approval names changed since the owner opened it. */
export class AgentApprovalChangedError extends AgentDispatchError {
  constructor() {
    super("approval_changed", "This changed since you opened it: review it again before you approve.", 409);
  }
}

/**
 * Runs the agent's retry only on an approval its owner gave for exactly this
 * grant, credential, operations and input; uses it up. A request still
 * waiting for the owner answers `approval_pending` (428) with its link.
 */
export async function redeemAgentApproval(
  db: Database,
  env: Env,
  principal: AgentPrincipal,
  approvalId: string,
  binding: string,
): Promise<void> {
  const invalid = () => new AgentDispatchError(
    "approval_invalid",
    "This approval is not for this connection, operation and input, was declined, or expired. Repeat the change without it for a new approval link.",
    400,
  );
  if (!APPROVAL_ID_PATTERN.test(approvalId)) throw invalid();
  const now = new Date();
  const row = await db.select({
    status: agentBrowserHandoffs.status,
    expiresAt: agentBrowserHandoffs.expiresAt,
    encryptedAction: agentBrowserHandoffs.encryptedAction,
  }).from(agentBrowserHandoffs).where(and(
    eq(agentBrowserHandoffs.id, approvalId),
    eq(agentBrowserHandoffs.grantId, principal.grantId),
    principal.credentialId === null
      ? isNull(agentBrowserHandoffs.credentialId)
      : eq(agentBrowserHandoffs.credentialId, principal.credentialId),
    eq(agentBrowserHandoffs.authorityRevision, principal.authorityRevision),
    gt(agentBrowserHandoffs.expiresAt, now),
    isApproval,
  )).get();
  if (!row) throw invalid();
  const payload = await readPayload(approvalId, row.encryptedAction, env);
  if (!payload || payload.binding !== binding) throw invalid();
  if (row.status === "active") {
    throw new AgentApprovalPendingError({
      summary: await approvalSummary(db, payload.rows),
      approvalId,
      approvalUrl: approvalUrlFor(env, approvalId),
      expiresAt: row.expiresAt.toISOString(),
    });
  }
  if (row.status !== "consumed") throw invalid();
  const used = await db.delete(agentBrowserHandoffs).where(and(
    eq(agentBrowserHandoffs.id, approvalId),
    eq(agentBrowserHandoffs.status, "consumed"),
  )).returning({ id: agentBrowserHandoffs.id });
  if (used.length !== 1) throw new AgentDispatchError("approval_used", "This approval was already used", 409);
}
