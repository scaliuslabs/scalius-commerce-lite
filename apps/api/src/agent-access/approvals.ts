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
import {
  agentBrowserHandoffs,
  agentDeviceAuthorizations,
  agentGrants,
  customers,
  orders,
  products,
  productVariants,
} from "@scalius/database/schema";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import {
  decryptCredentials,
  encodeEncryptedCredential,
  encryptCredentials,
} from "@scalius/core/utils/credential-encryption";
import {
  APPROVAL_OPERATION_PREFIX,
  dashboardOrigin,
  grantAuthorityGuard,
  requireEncryptionKey,
} from "./browser-handoffs";
import { AgentDispatchError } from "./dispatch-error";
import type { ConfirmTarget, ConfirmTargetKind } from "./mcp/confirm";
import type { AgentPrincipal } from "./types";

/** The REST lane's retry header: `Scalius-Approval: abh_...`. */
export const APPROVAL_HEADER = "Scalius-Approval";
export const APPROVAL_ID_PATTERN = /^abh_[A-Za-z0-9_-]{20}$/;
const APPROVAL_TTL_SECONDS = 5 * 60;
const isApproval = sql`substr(${agentBrowserHandoffs.operationId}, 1, ${APPROVAL_OPERATION_PREFIX.length}) = ${APPROVAL_OPERATION_PREFIX}`;

interface ApprovalPayload {
  kind: "approval";
  binding: string;
  summary: string;
  operationIds: string[];
  /** The records the bound input names (ids only; names are read when the owner looks). */
  targets?: ConfirmTarget[];
}

const TARGET_KINDS: readonly ConfirmTargetKind[] = ["product", "variant", "order", "customer"];

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
    super("confirmation_required", "The merchant has not approved this change yet. Ask them to open confirmation.approvalUrl, then repeat the request with the approval id.", 428);
  }
}

function approvalUrlFor(env: Env, approvalId: string): string {
  return `${dashboardOrigin(env)}/admin/settings/agent-access/approve/${approvalId}`;
}

async function readPayload(encrypted: string, env: Env): Promise<ApprovalPayload | null> {
  try {
    const value = JSON.parse(await decryptCredentials(
      encrypted.startsWith("enc:") ? encrypted.slice(4) : encrypted,
      requireEncryptionKey(env),
    )) as Partial<ApprovalPayload>;
    if (value.kind !== "approval" || typeof value.binding !== "string" || typeof value.summary !== "string" || !Array.isArray(value.operationIds)) return null;
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
  input: { binding: string; summary: string; operationIds: readonly string[]; targets?: readonly ConfirmTarget[] },
): Promise<AgentApprovalLink> {
  const now = Math.floor(Date.now() / 1000);
  const approvalId = `abh_${nanoid(20)}`;
  const payload: ApprovalPayload = {
    kind: "approval",
    binding: input.binding,
    summary: input.summary,
    operationIds: [...input.operationIds].slice(0, 20),
    ...(input.targets && input.targets.length > 0 ? { targets: storedTargets(input.targets) } : {}),
  };
  const encryptedAction = encodeEncryptedCredential(await encryptCredentials(JSON.stringify(payload), requireEncryptionKey(env)));
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
      throw new AgentDispatchError("agent_grant_inactive", "This connection is no longer active", 401);
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

/** A kind of record the change acts on: its readable names, how many in all, or a filter. */
export interface AgentApprovalTarget {
  kind: ConfirmTargetKind;
  total: number;
  names: string[];
  matching: boolean;
}

export interface AgentApprovalView {
  approvalId: string;
  status: "pending" | "approved";
  summary: string;
  operationIds: string[];
  expiresAt: string;
  requester: AgentApprovalRequester | null;
  targets: AgentApprovalTarget[];
}

async function readRequester(db: Database, grantId: string): Promise<AgentApprovalRequester | null> {
  const grant = await db.select({
    label: agentGrants.label,
    kind: agentGrants.kind,
    clientName: agentGrants.oauthClientName,
    // A paired CLI keeps its client's name on the pairing that created the grant.
    deviceClientName: sql<string | null>`(
      SELECT ${agentDeviceAuthorizations.clientName} FROM ${agentDeviceAuthorizations}
      WHERE ${agentDeviceAuthorizations.grantId} = ${agentGrants.id} LIMIT 1
    )`,
  }).from(agentGrants).where(eq(agentGrants.id, grantId)).get();
  if (!grant) return null;
  const client = (grant.kind === "oauth" ? grant.clientName : grant.kind === "cli" ? grant.deviceClientName : null)?.trim() || null;
  return { name: grant.label.trim().slice(0, 120), client: client?.slice(0, 120) ?? null, kind: grant.kind };
}

/** Readable names for the ids an approval binds: one bounded read per kind (at most 20 ids each). */
async function readTargetNames(db: Database, target: ConfirmTarget): Promise<string[]> {
  if (target.ids.length === 0) return [];
  let rows: Array<{ id: string; name: string }>;
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
  }
  const names = new Map(rows.map((row) => [row.id, row.name.trim().slice(0, 160)]));
  return target.ids.flatMap((id) => names.get(id) || []);
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
  const payload = await readPayload(row.encryptedAction, env);
  if (!payload) return null;
  const requester = await readRequester(db, row.grantId);
  const targets: AgentApprovalTarget[] = [];
  // Sequential and bounded: at most four reads of at most 20 ids.
  for (const target of storedTargets(payload.targets)) {
    targets.push({ kind: target.kind, total: target.total, names: await readTargetNames(db, target), matching: target.matching });
  }
  return {
    approvalId,
    status: row.status === "active" ? "pending" : "approved",
    summary: payload.summary,
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
  const payload = await readPayload(row.encryptedAction, env);
  if (!payload || payload.binding !== binding) throw invalid();
  if (row.status === "active") {
    throw new AgentApprovalPendingError({
      summary: payload.summary,
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
