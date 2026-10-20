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
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { agentBrowserHandoffs } from "@scalius/database/schema";
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
  input: { binding: string; summary: string; operationIds: readonly string[] },
): Promise<AgentApprovalLink> {
  const now = Math.floor(Date.now() / 1000);
  const approvalId = `abh_${nanoid(20)}`;
  const payload: ApprovalPayload = {
    kind: "approval",
    binding: input.binding,
    summary: input.summary,
    operationIds: [...input.operationIds].slice(0, 20),
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

export interface AgentApprovalView {
  approvalId: string;
  status: "pending" | "approved";
  summary: string;
  operationIds: string[];
  expiresAt: string;
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
  }).from(agentBrowserHandoffs).where(and(
    eq(agentBrowserHandoffs.id, approvalId),
    eq(agentBrowserHandoffs.ownerUserId, ownerUserId),
    gt(agentBrowserHandoffs.expiresAt, new Date()),
    isApproval,
  )).get();
  if (!row || (row.status !== "active" && row.status !== "consumed")) return null;
  const payload = await readPayload(row.encryptedAction, env);
  if (!payload) return null;
  return {
    approvalId,
    status: row.status === "active" ? "pending" : "approved",
    summary: payload.summary,
    operationIds: payload.operationIds,
    expiresAt: row.expiresAt.toISOString(),
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
