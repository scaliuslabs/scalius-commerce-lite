import { nanoid } from "nanoid";
import { agentAuditEvents } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { AgentAuditInput } from "./types";

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_STRING_LENGTH = 160;
const MAX_RESOURCE_IDS = 16;
const SAFE_METADATA_KEYS = new Set([
  "batchStepCount",
  "resultCount",
  "retryCount",
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

export async function writeAgentAuditEvent(
  db: Database,
  input: AgentAuditInput,
): Promise<void> {
  await db.insert(agentAuditEvents).values({
    id: input.eventId ?? `aae_${nanoid(20)}`,
    grantId: input.grantId,
    credentialId: input.credentialId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    resource: input.resource ?? null,
    operationId: input.operationId.slice(0, 160),
    risk: input.risk,
    outcome: input.outcome,
    httpStatus: input.httpStatus ?? null,
    errorClass: clampText(input.errorClass, 96),
    durationMs: input.durationMs ?? null,
    requestId: clampText(input.requestId, 128),
    idempotencyKeyHashPrefix: clampText(input.idempotencyKeyHashPrefix, 24),
    resourceIdsJson: JSON.stringify(sanitizeResourceIds(input.resourceIds)),
    metadataJson: JSON.stringify(sanitizeMetadata(input.metadata)),
    createdAt: new Date(),
  });
}
