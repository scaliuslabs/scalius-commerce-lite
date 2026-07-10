import type { Database } from "@scalius/database/client";
import { assistantComputerHandoffs } from "@scalius/database/schema";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { and, eq, isNull, lte, or } from "drizzle-orm";

import {
  constantTimeAssistantHashEqual,
  hashAssistantArguments,
} from "./assistant-crypto";
import { boundedPositiveInteger, d1Timestamp, requireOpaqueId } from "./assistant-internal";

const INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const PROGRAM_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TICKET_REMAINING_MS = 125_000;

export const ASSISTANT_COMPUTER_HANDOFF_AUDIT_RETENTION_SECONDS = 24 * 60 * 60;

export type AssistantComputerHandoffState = "cancelled" | "dispatched";

export type ConsumeAssistantComputerHandoffResult =
  | {
    status: "claimed";
    state: "cancelled";
    requestId: string;
  }
  | {
    status: "claimed";
    state: "dispatched";
    requestId: string;
    dispatchClaimToken: string;
  }
  | {
    status: "replayed";
    state: AssistantComputerHandoffState;
    requestId: string;
  }
  | {
    status: "uncertain";
    state: "dispatched";
    requestId: string;
  }
  | {
    status: "conflict";
    state: AssistantComputerHandoffState;
    requestId: string;
  };

export interface CleanupAssistantComputerHandoffsResult {
  scanned: number;
  deleted: number;
  limit: number;
  hasMore: boolean;
}

interface HandoffIdentity {
  sessionId: string;
  agentInstanceId: string;
  requestId: string;
  programDigest: string;
  ticketExpiresAt: Date;
  retentionExpiresAt: Date;
  now: Date;
}

export async function consumeAssistantComputerHandoff(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    requestId: string;
    programDigest: string;
    state: AssistantComputerHandoffState;
    ticketExpiresAt: number;
    now?: Date;
  },
): Promise<ConsumeAssistantComputerHandoffResult> {
  if (input.state !== "cancelled" && input.state !== "dispatched") {
    throw new ValidationError("Computer handoff state is invalid.");
  }
  const identity = normalizeHandoffIdentity(input);
  const dispatchClaimToken = input.state === "dispatched"
    ? randomBase64Url(32)
    : null;
  const dispatchClaimHash = dispatchClaimToken
    ? await hashDispatchClaim(dispatchClaimToken)
    : null;

  const inserted = await db.insert(assistantComputerHandoffs).values({
    sessionId: identity.sessionId,
    agentInstanceId: identity.agentInstanceId,
    requestId: identity.requestId,
    programDigest: identity.programDigest,
    state: input.state,
    ticketExpiresAt: identity.ticketExpiresAt,
    retentionExpiresAt: identity.retentionExpiresAt,
    dispatchClaimHash,
    dispatchConfirmedAt: null,
    createdAt: identity.now,
    updatedAt: identity.now,
  }).onConflictDoNothing().returning();

  if (inserted[0]) {
    return input.state === "cancelled"
      ? { status: "claimed", state: "cancelled", requestId: identity.requestId }
      : {
        status: "claimed",
        state: "dispatched",
        requestId: identity.requestId,
        dispatchClaimToken: dispatchClaimToken!,
      };
  }

  const existing = await selectHandoff(
    db,
    identity.agentInstanceId,
    identity.requestId,
  );
  if (!existing) {
    throw new ServiceUnavailableError("Assistant computer handoff state is unavailable.");
  }
  assertStoredHandoffReadable(existing);
  if (!matchesHandoffIdentity(existing, identity) || existing.state !== input.state) {
    return {
      status: "conflict",
      state: existing.state,
      requestId: identity.requestId,
    };
  }
  if (existing.state === "cancelled") {
    return { status: "replayed", state: "cancelled", requestId: identity.requestId };
  }
  if (existing.dispatchConfirmedAt) {
    return { status: "replayed", state: "dispatched", requestId: identity.requestId };
  }
  return { status: "uncertain", state: "dispatched", requestId: identity.requestId };
}

export async function confirmAssistantComputerHandoffDispatch(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    requestId: string;
    programDigest: string;
    dispatchClaimToken: string;
    now?: Date;
  },
): Promise<{ status: "confirmed" | "replayed"; state: "dispatched"; requestId: string }> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const requestId = requirePattern(input.requestId, REQUEST_ID_PATTERN, "Computer request ID");
  const programDigest = requirePattern(
    input.programDigest,
    PROGRAM_DIGEST_PATTERN,
    "Computer program digest",
  );
  const dispatchClaimToken = requirePattern(
    input.dispatchClaimToken,
    CLAIM_TOKEN_PATTERN,
    "Computer dispatch claim",
  );
  const dispatchClaimHash = await hashDispatchClaim(dispatchClaimToken);
  const now = d1Timestamp(input.now ?? new Date());

  const confirmed = await db.update(assistantComputerHandoffs).set({
    dispatchConfirmedAt: now,
    updatedAt: now,
  }).where(and(
    eq(assistantComputerHandoffs.sessionId, sessionId),
    eq(assistantComputerHandoffs.agentInstanceId, agentInstanceId),
    eq(assistantComputerHandoffs.requestId, requestId),
    eq(assistantComputerHandoffs.programDigest, programDigest),
    eq(assistantComputerHandoffs.state, "dispatched"),
    eq(assistantComputerHandoffs.dispatchClaimHash, dispatchClaimHash),
    isNull(assistantComputerHandoffs.dispatchConfirmedAt),
  )).returning();
  if (confirmed[0]) {
    return { status: "confirmed", state: "dispatched", requestId };
  }

  const existing = await selectHandoff(db, agentInstanceId, requestId);
  if (!existing) {
    throw new ServiceUnavailableError("Assistant computer handoff state is unavailable.");
  }
  assertStoredHandoffReadable(existing);
  if (
    existing.sessionId !== sessionId ||
    existing.programDigest !== programDigest ||
    existing.state !== "dispatched" ||
    !existing.dispatchClaimHash ||
    !constantTimeAssistantHashEqual(existing.dispatchClaimHash, dispatchClaimHash)
  ) {
    throw new ValidationError("Assistant computer dispatch confirmation is invalid.");
  }
  if (!existing.dispatchConfirmedAt) {
    throw new ServiceUnavailableError("Assistant computer dispatch confirmation is uncertain.");
  }
  return { status: "replayed", state: "dispatched", requestId };
}

export async function cleanupExpiredAssistantComputerHandoffs(
  db: Database,
  now = new Date(),
  options: { limit?: number } = {},
): Promise<CleanupAssistantComputerHandoffsResult> {
  // Two bound parameters per composite key; 45 keeps the delete below D1's
  // 100-parameter ceiling even after query bookkeeping.
  const limit = boundedPositiveInteger(options.limit ?? 40, 45, "Cleanup limit");
  const cutoff = d1Timestamp(now);
  const rows = await db.select({
    agentInstanceId: assistantComputerHandoffs.agentInstanceId,
    requestId: assistantComputerHandoffs.requestId,
  }).from(assistantComputerHandoffs)
    .where(lte(assistantComputerHandoffs.retentionExpiresAt, cutoff))
    .limit(limit + 1);
  const deleteRows = rows.slice(0, limit);
  let deleted = 0;
  if (deleteRows.length > 0) {
    const removed = await db.delete(assistantComputerHandoffs).where(or(
      ...deleteRows.map((row) => and(
        eq(assistantComputerHandoffs.agentInstanceId, row.agentInstanceId),
        eq(assistantComputerHandoffs.requestId, row.requestId),
      )),
    )).returning({ requestId: assistantComputerHandoffs.requestId });
    deleted = removed.length;
  }
  return {
    scanned: deleteRows.length,
    deleted,
    limit,
    hasMore: rows.length > limit,
  };
}

function normalizeHandoffIdentity(input: {
  sessionId: string;
  agentInstanceId: string;
  requestId: string;
  programDigest: string;
  ticketExpiresAt: number;
  now?: Date;
}): HandoffIdentity {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const requestId = requirePattern(input.requestId, REQUEST_ID_PATTERN, "Computer request ID");
  const programDigest = requirePattern(
    input.programDigest,
    PROGRAM_DIGEST_PATTERN,
    "Computer program digest",
  );
  if (!Number.isSafeInteger(input.ticketExpiresAt)) {
    throw new ValidationError("Computer ticket expiry is invalid.");
  }
  const now = d1Timestamp(input.now ?? new Date());
  const ticketExpiresAt = d1Timestamp(new Date(input.ticketExpiresAt));
  const remainingMs = ticketExpiresAt.getTime() - now.getTime();
  if (remainingMs <= 0 || remainingMs > MAX_TICKET_REMAINING_MS) {
    throw new ValidationError("Computer ticket expiry is invalid.");
  }
  const retentionExpiresAt = new Date(
    ticketExpiresAt.getTime() +
      ASSISTANT_COMPUTER_HANDOFF_AUDIT_RETENTION_SECONDS * 1_000,
  );
  return {
    sessionId,
    agentInstanceId,
    requestId,
    programDigest,
    ticketExpiresAt,
    retentionExpiresAt,
    now,
  };
}

async function selectHandoff(
  db: Database,
  agentInstanceId: string,
  requestId: string,
) {
  const rows = await db.select().from(assistantComputerHandoffs).where(and(
    eq(assistantComputerHandoffs.agentInstanceId, agentInstanceId),
    eq(assistantComputerHandoffs.requestId, requestId),
  )).limit(1);
  return rows[0] ?? null;
}

function matchesHandoffIdentity(
  row: typeof assistantComputerHandoffs.$inferSelect,
  identity: HandoffIdentity,
): boolean {
  return row.sessionId === identity.sessionId &&
    row.agentInstanceId === identity.agentInstanceId &&
    row.requestId === identity.requestId &&
    row.programDigest === identity.programDigest &&
    row.ticketExpiresAt.getTime() === identity.ticketExpiresAt.getTime() &&
    row.retentionExpiresAt.getTime() === identity.retentionExpiresAt.getTime();
}

function assertStoredHandoffReadable(
  row: typeof assistantComputerHandoffs.$inferSelect,
): void {
  if (row.state !== "cancelled" && row.state !== "dispatched") {
    throw new ServiceUnavailableError("Assistant computer handoff state is unreadable.");
  }
  const claimShapeValid = row.state === "cancelled"
    ? row.dispatchClaimHash === null && row.dispatchConfirmedAt === null
    : typeof row.dispatchClaimHash === "string" &&
      SHA256_HEX_PATTERN.test(row.dispatchClaimHash);
  if (!claimShapeValid || row.retentionExpiresAt <= row.ticketExpiresAt) {
    throw new ServiceUnavailableError("Assistant computer handoff state is unreadable.");
  }
}

async function hashDispatchClaim(token: string): Promise<string> {
  return hashAssistantArguments({
    version: "assistant-computer-dispatch-claim:v1",
    token,
  });
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ValidationError(`${label} is invalid.`);
  }
  return value;
}

function randomBase64Url(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
