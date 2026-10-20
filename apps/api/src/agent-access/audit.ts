// Agent, MCP and app call audit (one row per call at most, in the same batch
// as the principal's usage stamp):
//
// - Every write, destructive, financial or security call and every denied or
//   failed call is its own row, as it happens: the forensic record.
// - Successful reads roll up: the first read of an operation by a principal
//   (grant, app, credential) in each clock hour is recorded, with its
//   request id and resource ids; the hour's further reads of that operation
//   write nothing (a deterministic row id, insert-or-ignore). So the log
//   still says which credential read what, and when, without a row write per
//   read (D1 bills rows written).
// - `last_used_at` (grant and credential) moves only when it is older than a
//   minute: a busy credential is not one hot row rewritten per call.
import { nanoid } from "nanoid";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import {
  agentAuditEvents,
  agentCredentials,
  agentGrants,
} from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import type { AgentAuditInput } from "./types";

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_STRING_LENGTH = 160;
const MAX_RESOURCE_IDS = 16;
/** `last_used_at` resolution: a stamp younger than this is not rewritten. */
export const AGENT_LAST_USED_RESOLUTION_SECONDS = 60;
/** Successful reads are recorded once per principal, operation and this window. */
export const AGENT_READ_ROLLUP_SECONDS = 3_600;

const SAFE_METADATA_KEYS = new Set([
  "batchStepCount",
  "confirmedBy",
  "dryRun",
  "resultCount",
  "retryCount",
  "rollup",
  "transport",
]);

function clampText(value: string | null | undefined, maximum: number): string | null {
  if (!value) return null;
  return value.slice(0, maximum);
}

function sanitizeMetadata(
  metadata: AgentAuditInput["metadata"],
): Record<string, string | number | boolean | null> {
  if (!metadata) return {};
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, MAX_METADATA_KEYS)) {
    if (!SAFE_METADATA_KEYS.has(rawKey)) continue;
    if (typeof rawValue === "string") {
      if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(rawValue)) continue;
      sanitized[rawKey] = rawValue.slice(0, MAX_METADATA_STRING_LENGTH);
    } else {
      sanitized[rawKey] = rawValue;
    }
  }
  return sanitized;
}

function sanitizeResourceIds(values: string[] | undefined): string[] {
  return (values ?? [])
    .filter((value) =>
      /^[A-Za-z][A-Za-z0-9_-]{2,95}$/.test(value) &&
      !/^(?:sc_|chk_|cst_|cs_|otp_|receipt_|token_)/i.test(value),
    )
    .slice(0, MAX_RESOURCE_IDS);
}

/** True for a call recorded once per hour (a successful read), not once per call. */
export function isRolledUpAgentCall(input: Pick<AgentAuditInput, "risk" | "outcome">): boolean {
  return input.risk === "read" && input.outcome === "success";
}

async function rollupEventId(input: AgentAuditInput, operationId: string, now: Date): Promise<string> {
  const window = Math.floor(now.getTime() / 1000 / AGENT_READ_ROLLUP_SECONDS);
  const principal = [input.grantId ?? "", input.pluginId ?? "", input.credentialId ?? "", input.ownerUserId ?? ""].join("|");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${principal}|${operationId}|${window}`)));
  // The id shape every audit row has (`aae_` and 20 characters): 80 bits of the digest.
  return `aae_${Array.from(digest.slice(0, 10), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function writeAgentAuditEvent(
  db: Database,
  input: AgentAuditInput,
): Promise<void> {
  const now = new Date();
  const operationId = input.operationId.slice(0, 160);
  const rolledUp = isRolledUpAgentCall(input);
  const metadata = sanitizeMetadata(input.metadata);
  const values = {
    id: rolledUp ? await rollupEventId(input, operationId, now) : input.eventId ?? `aae_${nanoid(20)}`,
    grantId: input.grantId,
    pluginId: input.pluginId ?? null,
    credentialId: input.credentialId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    resource: input.resource ?? null,
    operationId,
    risk: input.risk,
    outcome: input.outcome,
    httpStatus: input.httpStatus ?? null,
    errorClass: clampText(input.errorClass, 96),
    durationMs: input.durationMs ?? null,
    requestId: clampText(input.requestId, 128),
    idempotencyKeyHashPrefix: clampText(input.idempotencyKeyHashPrefix, 24),
    resourceIdsJson: JSON.stringify(sanitizeResourceIds(input.resourceIds)),
    metadataJson: JSON.stringify(rolledUp ? { ...metadata, rollup: "hour" } : metadata),
    createdAt: now,
  };
  const auditInsert = rolledUp
    ? db.insert(agentAuditEvents).values(values).onConflictDoNothing()
    : db.insert(agentAuditEvents).values(values);
  if (!input.grantId) {
    await safeBatch(db, [auditInsert]);
    return;
  }

  const stale = new Date(now.getTime() - AGENT_LAST_USED_RESOLUTION_SECONDS * 1000);
  const grantUpdate = db.update(agentGrants).set({
    lastUsedAt: now,
    lastOperationId: operationId,
    updatedAt: now,
  }).where(and(eq(agentGrants.id, input.grantId), or(isNull(agentGrants.lastUsedAt), lt(agentGrants.lastUsedAt, stale))));
  if (input.credentialId) {
    const credentialUpdate = db.update(agentCredentials)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(and(
        eq(agentCredentials.id, input.credentialId),
        or(isNull(agentCredentials.lastUsedAt), lt(agentCredentials.lastUsedAt, stale)),
      ));
    await safeBatch(db, [auditInsert, grantUpdate, credentialUpdate]);
    return;
  }
  await safeBatch(db, [auditInsert, grantUpdate]);
}
