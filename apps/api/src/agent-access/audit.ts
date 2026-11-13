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
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  agentAuditEvents,
  agentCredentials,
  agentDeviceAuthorizations,
  agentGrants,
} from "@scalius/database/schema";
import { qualifiedColumn } from "@scalius/core/utils/qualified-column";
import { safeBatch, type Database } from "@scalius/database/client";
import type { AgentAttribution } from "@scalius/core/utils/agent-attribution";
import type { AgentAuditInput } from "./types";
import { cleanAgentLabel, cleanAgentLabelOrNull } from "@scalius/shared/agent-label";

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_STRING_LENGTH = 160;
const MAX_RESOURCE_IDS = 16;
/** `last_used_at` resolution: a stamp younger than this is not rewritten. */
export const AGENT_LAST_USED_RESOLUTION_SECONDS = 60;
/** Successful reads are recorded once per principal, operation and this window. */
export const AGENT_READ_ROLLUP_SECONDS = 3_600;

const SAFE_METADATA_KEYS = new Set([
  "approvalId",
  "approvedBy",
  "batchStepCount",
  "confirmedBy",
  "dryRun",
  "resultCount",
  "retryCount",
  "rollup",
  "transport",
]);
/** Names a person gave (the connection's label, its client's name): kept as text, cleaned and bounded. */
const TEXT_METADATA_KEYS = new Set(["client", "connection"]);
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

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
    if (TEXT_METADATA_KEYS.has(rawKey)) {
      if (typeof rawValue === "string") {
        const text = rawValue.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim().slice(0, 120);
        if (text) sanitized[rawKey] = text;
      }
      continue;
    }
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
      /^[A-Za-z0-9][A-Za-z0-9_-]{2,95}$/.test(value) &&
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
  // A write's row is recorded before it runs (outcome `failed`, `in_progress`)
  // and completed under the same id when it answers.
  const auditInsert = rolledUp
    ? db.insert(agentAuditEvents).values(values).onConflictDoNothing()
    : db.insert(agentAuditEvents).values(values).onConflictDoUpdate({
      target: agentAuditEvents.id,
      set: {
        outcome: values.outcome,
        httpStatus: values.httpStatus,
        errorClass: values.errorClass,
        durationMs: values.durationMs,
        resourceIdsJson: values.resourceIdsJson,
        metadataJson: values.metadataJson,
      },
    });
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

/** The error class of a write's row while it runs: completed when it answers. */
export const AGENT_WRITE_IN_PROGRESS = "in_progress";

/**
 * The records an agent's write touched, for its audit row: the ids its path
 * names, then the ids its answer names (`data.id`, `data.<x>Id`, and an id
 * one object down: the refund, movement or line it made). Any table's row an
 * agent wrote can be traced to the agent through them.
 */
export function agentWriteResourceIds(pathValues: readonly unknown[], answer: unknown): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && !ids.includes(value)) ids.push(value);
  };
  pathValues.forEach(add);
  const data = answer && typeof answer === "object" ? (answer as { data?: unknown }).data ?? answer : null;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "id" || /Id$/.test(key)) && typeof item === "string") add(item);
      else if (depth === 0 && item && typeof item === "object" && !Array.isArray(item)) visit(item, 1);
    }
  };
  visit(data, 0);
  return sanitizeResourceIds(ids);
}

/** Who an agent connection is: its name and the client it runs in (a paired CLI's, an OAuth app's), from the grant record. */
export async function readAgentConnection(
  db: Database,
  grantId: string,
): Promise<{ name: string; client: string | null; kind: "oauth" | "pat" | "cli" } | null> {
  const grant = await db.select({
    label: agentGrants.label,
    kind: agentGrants.kind,
    clientName: agentGrants.oauthClientName,
    // A paired CLI keeps its client's name on the pairing that created the grant.
    deviceClientName: sql<string | null>`(
      SELECT ${agentDeviceAuthorizations.clientName} FROM ${agentDeviceAuthorizations}
      WHERE ${agentDeviceAuthorizations.grantId} = ${qualifiedColumn(agentGrants.id)} LIMIT 1
    )`,
  }).from(agentGrants).where(eq(agentGrants.id, grantId)).get();
  if (!grant) return null;
  // Names an agent or its client chose: cleaned once here (no control, line or direction
  // characters) for every place that shows them: the approval page, the audit row, the timeline.
  const client = cleanAgentLabelOrNull(grant.kind === "oauth" ? grant.clientName : grant.kind === "cli" ? grant.deviceClientName : null);
  return { name: cleanAgentLabel(grant.label), client, kind: grant.kind };
}

/** The connection, client and approval an audit row names, as its metadata. */
export function attributionMetadata(attribution: AgentAttribution): Record<string, string> {
  return {
    connection: attribution.connection,
    ...(attribution.client ? { client: attribution.client } : {}),
    ...(attribution.approvalId ? { approvalId: attribution.approvalId } : {}),
    ...(attribution.approvedBy ? { approvedBy: attribution.approvedBy } : {}),
  };
}
