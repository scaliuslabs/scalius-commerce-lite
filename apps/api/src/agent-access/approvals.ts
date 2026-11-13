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
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  agentBrowserHandoffs,
  categories,
  collections,
  customers,
  orderPayments,
  orders,
  pages,
  paymentDisputes,
  products,
  productVariants,
  promotions,
  user,
} from "@scalius/database/schema";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { decryptCredential, encryptCredential } from "@scalius/core/utils/credential-encryption";
import { handoffActionOwner } from "./browser-handoffs";
import { readAgentConnection } from "./audit";
import {
  APPROVAL_OPERATION_PREFIX,
  dashboardOrigin,
  grantAuthorityGuard,
  requireEncryptionKey,
} from "./browser-handoffs";
import { AgentDispatchError, agentConnectionInactive } from "./dispatch-error";
import type { ConfirmTarget, ConfirmTargetKind } from "./mcp/confirm";
import {
  CONFIRM_TARGET_KINDS,
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
  /** The records the bound input names (ids only; names are read when the owner looks). */
  targets?: ConfirmTarget[];
}

const TARGET_KINDS: readonly ConfirmTargetKind[] = CONFIRM_TARGET_KINDS;

/** Summary rows kept for the owner, in order, within this many bytes so the encrypted row stays inside its 8 KiB. */
const ROWS_BYTES_BUDGET = 4_200;

function storedRows(value: unknown): SummaryRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SummaryRow[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const item of value) {
    const row = item as Partial<SummaryRow> | null;
    if (!row || !SUMMARY_ROW_KINDS.includes(row.kind as SummaryRowKind) || typeof row.text !== "string" || typeof row.operationId !== "string") continue;
    const values = Array.isArray(row.values)
      ? row.values.slice(0, 500).map((value) => value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
        ? value
        : cleanSummaryText(String(value)))
      : undefined;
    const text = cleanSummaryText(row.text);
    const clean: SummaryRow = {
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
    };
    const size = JSON.stringify(clean).length;
    // Money and the records it acts on come first and are kept before anything else;
    // a row left out makes the change one that cannot be approved (incompleteSummaryReasons).
    if (bytes + size > ROWS_BYTES_BUDGET) {
      dropped += 1;
      continue;
    }
    bytes += size;
    rows.push(clean);
  }
  if (dropped > 0) {
    rows.push({ kind: "note", operationId: rows[0]?.operationId ?? "", field: null, text: `${dropped} more rows of the request not shown`, code: "more_rows", count: dropped });
  }
  return rows;
}

/** Ids kept for names across every kind, so the encrypted row stays well inside its 8 KiB. */
const TARGET_IDS_BUDGET = 30;

function storedTargets(value: unknown): ConfirmTarget[] {
  if (!Array.isArray(value)) return [];
  let budget = TARGET_IDS_BUDGET;
  return value.flatMap((item): ConfirmTarget[] => {
    const target = item as Partial<ConfirmTarget> | null;
    if (
      !target || !TARGET_KINDS.includes(target.kind as ConfirmTargetKind) ||
      !Array.isArray(target.ids) || !target.ids.every((id) => typeof id === "string" && id.length <= 64) ||
      typeof target.total !== "number" || !Number.isSafeInteger(target.total) || target.total < 0
    ) return [];
    const ids = target.ids.slice(0, Math.min(20, budget));
    budget -= ids.length;
    return [{ kind: target.kind!, ids, total: target.total, matching: target.matching === true }];
  });
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
    const value = JSON.parse(await decryptCredential(
      encrypted,
      requireEncryptionKey(env),
      handoffActionOwner(approvalId),
    )) as Partial<ApprovalPayload>;
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
  input: { binding: string; rows: readonly SummaryRow[]; operationIds: readonly string[]; targets?: readonly ConfirmTarget[] },
): Promise<AgentApprovalLink> {
  const now = Math.floor(Date.now() / 1000);
  const approvalId = `abh_${nanoid(20)}`;
  const payload: ApprovalPayload = {
    kind: "approval",
    binding: input.binding,
    rows: storedRows(input.rows),
    operationIds: [...input.operationIds].slice(0, 20),
    ...(input.targets && input.targets.length > 0 ? { targets: storedTargets(input.targets) } : {}),
  };
  const encryptedAction = await encryptCredential(JSON.stringify(payload), requireEncryptionKey(env), handoffActionOwner(approvalId));
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
  return { approvalId, approvalUrl: url, expiresAt: new Date((now + APPROVAL_TTL_SECONDS) * 1000).toISOString() };
}

/** Who asks: the connection's name and the client it runs in, from the grant record. */
export interface AgentApprovalRequester {
  name: string;
  /** The OAuth client or the paired CLI's client ("Claude Code"); null for an access key. */
  client: string | null;
  kind: "oauth" | "pat" | "cli";
}

/** One record the change acts on: its stored name (untrusted text); a payment or chargeback also its amount. */
export interface AgentApprovalRecord {
  id: string;
  name: string | null;
  /** A payment's or chargeback's amount in major units, with its currency (the page formats it). */
  amount?: string;
  currency?: string;
}

/** A kind of record the change acts on: its records by id with their stored names (untrusted text), how many in all. */
export interface AgentApprovalTarget {
  kind: ConfirmTargetKind;
  total: number;
  records: AgentApprovalRecord[];
  matching: boolean;
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
}

async function readRequester(db: Database, grantId: string): Promise<AgentApprovalRequester | null> {
  return readAgentConnection(db, grantId);
}

function safeDecimalPlaces(code: string): number {
  try {
    return getDecimalPlaces(code);
  } catch {
    return 2;
  }
}

/** Readable names for the ids an approval binds: one bounded read per kind (at most 20 ids each). */
async function readTargetNames(db: Database, target: ConfirmTarget): Promise<AgentApprovalRecord[]> {
  if (target.ids.length === 0) return [];
  let rows: Array<{ id: string; name: string; amountMinor?: number; currency?: string }>;
  switch (target.kind) {
    case "product":
      rows = await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, target.ids));
      break;
    case "variant":
      rows = (await db.select({ id: productVariants.id, sku: productVariants.sku, productName: products.name })
        .from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, target.ids)))
        .map((row) => ({ id: row.id, name: `${row.productName} (${row.sku})` }));
      break;
    case "order":
      rows = (await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.id, target.ids)))
        .map((row) => ({ id: row.id, name: formatOrderNumber(row.orderNumber, row.id) }));
      break;
    case "customer":
      rows = await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, target.ids));
      break;
    case "discount":
      // Staff know a discount by its name (a code discount's name is its first code).
      rows = await db.select({ id: promotions.id, name: promotions.name }).from(promotions).where(inArray(promotions.id, target.ids));
      break;
    case "category":
      rows = await db.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, target.ids));
      break;
    case "collection":
      rows = await db.select({ id: collections.id, name: collections.name }).from(collections).where(inArray(collections.id, target.ids));
      break;
    case "page":
      rows = await db.select({ id: pages.id, name: pages.title }).from(pages).where(inArray(pages.id, target.ids));
      break;
    case "staff":
      rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, target.ids));
      break;
    // Staff know a payment and a chargeback by how much and how it was paid.
    case "payment":
      rows = await db.select({ id: orderPayments.id, name: orderPayments.paymentMethod, amountMinor: orderPayments.amountMinor, currency: orderPayments.currency })
        .from(orderPayments).where(inArray(orderPayments.id, target.ids));
      break;
    case "dispute":
      rows = await db.select({ id: paymentDisputes.id, name: paymentDisputes.gateway, amountMinor: paymentDisputes.amountMinor, currency: paymentDisputes.currency })
        .from(paymentDisputes).where(inArray(paymentDisputes.id, target.ids));
      break;
  }
  // A name is whatever was stored (an agent can rename a product): cleaned, bounded, shown beside its id.
  const found = new Map(rows.map((row) => [row.id, row]));
  return target.ids.map((id) => {
    const row = found.get(id);
    const money = row && typeof row.amountMinor === "number" && row.currency && /^[A-Z]{3}$/.test(row.currency)
      ? { amount: (row.amountMinor / 10 ** safeDecimalPlaces(row.currency)).toFixed(safeDecimalPlaces(row.currency)), currency: row.currency }
      : {};
    return { id, name: row ? cleanSummaryText(row.name, 160) || null : null, ...money };
  });
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
  const targets: AgentApprovalTarget[] = [];
  // Sequential and bounded: one read per kind, at most 30 ids in all.
  for (const target of storedTargets(payload.targets)) {
    targets.push({ kind: target.kind, total: target.total, records: await readTargetNames(db, target), matching: target.matching });
  }
  return {
    approvalId,
    status: row.status === "active" ? "pending" : "approved",
    summary: summaryText(payload.rows),
    rows: storedRows(payload.rows),
    operationIds: payload.operationIds,
    expiresAt: row.expiresAt.toISOString(),
    requester,
    targets,
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
export async function approveAgentChange(db: Database, env: Env, approvalId: string, ownerUserId: string): Promise<boolean> {
  const approval = await readAgentApproval(db, env, approvalId, ownerUserId);
  const reasons = approval ? incompleteSummaryReasons(approval.rows) : [];
  if (reasons.length > 0) throw new AgentApprovalNotReviewableError(reasons);
  return decideAgentApproval(db, approvalId, ownerUserId, "approve");
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
      summary: summaryText(payload.rows),
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
