import type { Database } from "@scalius/database/client";
import {
  assistantComputerHandoffs,
  assistantComputerStopBarriers,
} from "@scalius/database/schema";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { and, eq, isNull, lte, or } from "drizzle-orm";

import { constantTimeAssistantHashEqual } from "./assistant-crypto";
import {
  ASSISTANT_CLAIM_TOKEN_PATTERN,
  ASSISTANT_INSTANCE_ID_PATTERN,
  hashAssistantDispatchClaim,
  randomAssistantBase64Url,
  requireAssistantPattern,
} from "./assistant-computer-handoff-internal";
import { boundedPositiveInteger, d1Timestamp, requireOpaqueId } from "./assistant-internal";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const PROGRAM_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TICKET_REMAINING_MS = 125_000;
const MAX_TICKET_LIFETIME_MS = 120_000;
const MAX_TICKET_CLOCK_SKEW_MS = 5_000;

export {
  beginAssistantAgentAdmission,
  finishAssistantAgentAdmission,
  finishAssistantComputerStopBarrier,
  readAssistantComputerStopBarrier,
  reconcileAssistantAgentAdmissionAfterStop,
  recordAssistantComputerStopBarrier,
} from "./assistant-agent-stop-barriers";
export type {
  AssistantAgentStopReconciliationResult,
  AssistantComputerStopBarrierResult,
  BeginAssistantAgentAdmissionResult,
} from "./assistant-agent-stop-barriers";

export const ASSISTANT_COMPUTER_HANDOFF_AUDIT_RETENTION_SECONDS = 24 * 60 * 60;

export type AssistantComputerHandoffState = "cancelled" | "dispatched";
export type AssistantComputerDispatchStatus =
  | "claimed"
  | "dispatching"
  | "confirmed"
  | "failed"
  | "uncertain"
  | "blocked";

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
  }
  | {
    status: "stopped";
    state: "dispatched";
    requestId: string;
  };

export type BeginAssistantComputerHandoffDispatchResult =
  | { status: "started"; requestId: string }
  | { status: "blocked"; requestId: string }
  | { status: "uncertain"; requestId: string }
  | { status: "replayed"; requestId: string }
  | { status: "failed"; requestId: string };

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
  ticketIssuedAtMs: number;
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
    ticketIssuedAtMs: number;
    ticketExpiresAt: number;
    now?: Date;
  },
): Promise<ConsumeAssistantComputerHandoffResult> {
  if (input.state !== "cancelled" && input.state !== "dispatched") {
    throw new ValidationError("Computer handoff state is invalid.");
  }
  const identity = normalizeHandoffIdentity(input);
  if (
    input.state === "dispatched" &&
    await isStoppedThrough(db, identity)
  ) {
    return {
      status: "stopped",
      state: "dispatched",
      requestId: identity.requestId,
    };
  }
  const dispatchClaimToken = input.state === "dispatched"
    ? randomAssistantBase64Url(32)
    : null;
  const dispatchClaimHash = dispatchClaimToken
    ? await hashAssistantDispatchClaim(dispatchClaimToken)
    : null;

  const inserted = await db.insert(assistantComputerHandoffs).values({
    sessionId: identity.sessionId,
    agentInstanceId: identity.agentInstanceId,
    requestId: identity.requestId,
    programDigest: identity.programDigest,
    state: input.state,
    ticketIssuedAtMs: identity.ticketIssuedAtMs,
    ticketExpiresAt: identity.ticketExpiresAt,
    retentionExpiresAt: identity.retentionExpiresAt,
    dispatchClaimHash,
    dispatchStatus: input.state === "dispatched" ? "claimed" : null,
    dispatchConfirmedAt: null,
    dispatchFailedAt: null,
    dispatchUncertainAt: null,
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
    if (input.state === "dispatched" && await isStoppedThrough(db, identity)) {
      return {
        status: "stopped",
        state: "dispatched",
        requestId: identity.requestId,
      };
    }
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
  if (existing.dispatchStatus === "confirmed") {
    return { status: "replayed", state: "dispatched", requestId: identity.requestId };
  }
  if (existing.dispatchStatus === "blocked") {
    return { status: "stopped", state: "dispatched", requestId: identity.requestId };
  }
  return { status: "uncertain", state: "dispatched", requestId: identity.requestId };
}

export async function beginAssistantComputerHandoffDispatch(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    requestId: string;
    programDigest: string;
    dispatchClaimToken: string;
    now?: Date;
  },
): Promise<BeginAssistantComputerHandoffDispatchResult> {
  const claim = await normalizeDispatchClaim(input);
  const now = d1Timestamp(input.now ?? new Date());
  const started = await db.update(assistantComputerHandoffs).set({
    dispatchStatus: "dispatching",
    updatedAt: now,
  }).where(and(
    eq(assistantComputerHandoffs.sessionId, claim.sessionId),
    eq(assistantComputerHandoffs.agentInstanceId, claim.agentInstanceId),
    eq(assistantComputerHandoffs.requestId, claim.requestId),
    eq(assistantComputerHandoffs.programDigest, claim.programDigest),
    eq(assistantComputerHandoffs.state, "dispatched"),
    eq(assistantComputerHandoffs.dispatchClaimHash, claim.dispatchClaimHash),
    eq(assistantComputerHandoffs.dispatchStatus, "claimed"),
    isNull(assistantComputerHandoffs.dispatchConfirmedAt),
    isNull(assistantComputerHandoffs.dispatchFailedAt),
    )).returning();
  if (started[0]) return { status: "started", requestId: claim.requestId };

  const existing = await requireDispatchClaimRow(db, claim);
  if (existing.dispatchStatus === "claimed") {
    const blocked = await isStoppedThrough(db, {
      sessionId: claim.sessionId,
      agentInstanceId: claim.agentInstanceId,
      ticketIssuedAtMs: existing.ticketIssuedAtMs,
    });
    if (blocked) {
      await db.update(assistantComputerHandoffs).set({
        dispatchStatus: "blocked",
        updatedAt: now,
      }).where(and(
        eq(assistantComputerHandoffs.agentInstanceId, claim.agentInstanceId),
        eq(assistantComputerHandoffs.requestId, claim.requestId),
        eq(assistantComputerHandoffs.dispatchStatus, "claimed"),
      ));
      return { status: "blocked", requestId: claim.requestId };
    }
    throw new ServiceUnavailableError("Assistant computer dispatch start is uncertain.");
  }
  if (existing.dispatchStatus === "blocked") {
    return { status: "blocked", requestId: claim.requestId };
  }
  if (existing.dispatchStatus === "dispatching") {
    return { status: "uncertain", requestId: claim.requestId };
  }
  if (existing.dispatchStatus === "confirmed") {
    return { status: "replayed", requestId: claim.requestId };
  }
  return { status: "failed", requestId: claim.requestId };
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
  const result = await finalizeAssistantComputerHandoffDispatch(db, {
    ...input,
    outcome: "confirmed",
  });
  return {
    status: result.status === "finalized" ? "confirmed" : "replayed",
    state: "dispatched",
    requestId: result.requestId,
  };
}

export async function failAssistantComputerHandoffDispatch(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    requestId: string;
    programDigest: string;
    dispatchClaimToken: string;
    now?: Date;
  },
): Promise<{ status: "failed" | "replayed"; state: "dispatched"; requestId: string }> {
  const result = await finalizeAssistantComputerHandoffDispatch(db, {
    ...input,
    outcome: "failed",
  });
  return {
    status: result.status === "finalized" ? "failed" : "replayed",
    state: "dispatched",
    requestId: result.requestId,
  };
}

export async function markAssistantComputerHandoffDispatchUncertain(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    requestId: string;
    programDigest: string;
    dispatchClaimToken: string;
    now?: Date;
  },
): Promise<{ status: "uncertain" | "replayed"; state: "dispatched"; requestId: string }> {
  const result = await finalizeAssistantComputerHandoffDispatch(db, {
    ...input,
    outcome: "uncertain",
  });
  return {
    status: result.status === "finalized" ? "uncertain" : "replayed",
    state: "dispatched",
    requestId: result.requestId,
  };
}

async function finalizeAssistantComputerHandoffDispatch(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    requestId: string;
    programDigest: string;
    dispatchClaimToken: string;
    outcome: "confirmed" | "failed" | "uncertain";
    now?: Date;
  },
): Promise<{ status: "finalized" | "replayed"; requestId: string }> {
  const claim = await normalizeDispatchClaim(input);
  const now = d1Timestamp(input.now ?? new Date());
  const finalized = await db.update(assistantComputerHandoffs).set({
    dispatchStatus: input.outcome,
    dispatchConfirmedAt: input.outcome === "confirmed" ? now : null,
    dispatchFailedAt: input.outcome === "failed" ? now : null,
    dispatchUncertainAt: input.outcome === "uncertain" ? now : null,
    updatedAt: now,
  }).where(and(
    eq(assistantComputerHandoffs.sessionId, claim.sessionId),
    eq(assistantComputerHandoffs.agentInstanceId, claim.agentInstanceId),
    eq(assistantComputerHandoffs.requestId, claim.requestId),
    eq(assistantComputerHandoffs.programDigest, claim.programDigest),
    eq(assistantComputerHandoffs.state, "dispatched"),
    eq(assistantComputerHandoffs.dispatchClaimHash, claim.dispatchClaimHash),
    eq(assistantComputerHandoffs.dispatchStatus, "dispatching"),
    isNull(assistantComputerHandoffs.dispatchConfirmedAt),
    isNull(assistantComputerHandoffs.dispatchFailedAt),
    isNull(assistantComputerHandoffs.dispatchUncertainAt),
  )).returning();
  if (finalized[0]) return { status: "finalized", requestId: claim.requestId };

  const existing = await requireDispatchClaimRow(db, claim);
  if (existing.dispatchStatus === input.outcome) {
    return { status: "replayed", requestId: claim.requestId };
  }
  throw new ServiceUnavailableError("Assistant computer dispatch finalization is uncertain.");
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
  ticketIssuedAtMs: number;
  ticketExpiresAt: number;
  now?: Date;
}): HandoffIdentity {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const requestId = requireAssistantPattern(
    input.requestId,
    REQUEST_ID_PATTERN,
    "Computer request ID",
  );
  const programDigest = requireAssistantPattern(
    input.programDigest,
    PROGRAM_DIGEST_PATTERN,
    "Computer program digest",
  );
  if (!Number.isSafeInteger(input.ticketExpiresAt)) {
    throw new ValidationError("Computer ticket expiry is invalid.");
  }
  if (!Number.isSafeInteger(input.ticketIssuedAtMs)) {
    throw new ValidationError("Computer ticket issue time is invalid.");
  }
  const now = d1Timestamp(input.now ?? new Date());
  const ticketExpiresAt = d1Timestamp(new Date(input.ticketExpiresAt));
  const remainingMs = ticketExpiresAt.getTime() - now.getTime();
  if (
    remainingMs <= 0 ||
    remainingMs > MAX_TICKET_REMAINING_MS ||
    input.ticketIssuedAtMs > now.getTime() + MAX_TICKET_CLOCK_SKEW_MS ||
    input.ticketExpiresAt <= input.ticketIssuedAtMs ||
    input.ticketExpiresAt - input.ticketIssuedAtMs > MAX_TICKET_LIFETIME_MS
  ) {
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
    ticketIssuedAtMs: input.ticketIssuedAtMs,
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
    row.ticketIssuedAtMs === identity.ticketIssuedAtMs &&
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
    ? row.dispatchClaimHash === null &&
      row.dispatchStatus === null &&
      row.dispatchConfirmedAt === null &&
      row.dispatchFailedAt === null &&
      row.dispatchUncertainAt === null
    : typeof row.dispatchClaimHash === "string" &&
      SHA256_HEX_PATTERN.test(row.dispatchClaimHash) &&
      isDispatchStatus(row.dispatchStatus) &&
      (row.dispatchStatus === "confirmed") === Boolean(row.dispatchConfirmedAt) &&
      (row.dispatchStatus === "failed") === Boolean(row.dispatchFailedAt) &&
      (row.dispatchStatus === "uncertain") === Boolean(row.dispatchUncertainAt);
  if (!claimShapeValid || row.retentionExpiresAt <= row.ticketExpiresAt) {
    throw new ServiceUnavailableError("Assistant computer handoff state is unreadable.");
  }
}

async function normalizeDispatchClaim(input: {
  sessionId: string;
  agentInstanceId: string;
  requestId: string;
  programDigest: string;
  dispatchClaimToken: string;
}) {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const requestId = requireAssistantPattern(
    input.requestId,
    REQUEST_ID_PATTERN,
    "Computer request ID",
  );
  const programDigest = requireAssistantPattern(
    input.programDigest,
    PROGRAM_DIGEST_PATTERN,
    "Computer program digest",
  );
  const dispatchClaimToken = requireAssistantPattern(
    input.dispatchClaimToken,
    ASSISTANT_CLAIM_TOKEN_PATTERN,
    "Computer dispatch claim",
  );
  return {
    sessionId,
    agentInstanceId,
    requestId,
    programDigest,
    dispatchClaimHash: await hashAssistantDispatchClaim(dispatchClaimToken),
  };
}

async function requireDispatchClaimRow(
  db: Database,
  claim: Awaited<ReturnType<typeof normalizeDispatchClaim>>,
) {
  const existing = await selectHandoff(db, claim.agentInstanceId, claim.requestId);
  if (!existing) {
    throw new ServiceUnavailableError("Assistant computer handoff state is unavailable.");
  }
  assertStoredHandoffReadable(existing);
  if (
    existing.sessionId !== claim.sessionId ||
    existing.programDigest !== claim.programDigest ||
    existing.state !== "dispatched" ||
    !existing.dispatchClaimHash ||
    !constantTimeAssistantHashEqual(existing.dispatchClaimHash, claim.dispatchClaimHash)
  ) {
    throw new ValidationError("Assistant computer dispatch claim is invalid.");
  }
  return existing;
}

async function isStoppedThrough(
  db: Database,
  identity: {
    sessionId: string;
    agentInstanceId: string;
    ticketIssuedAtMs: number;
  },
): Promise<boolean> {
  const rows = await db.select({
    stoppedThroughIssuedAtMs: assistantComputerStopBarriers.stoppedThroughIssuedAtMs,
  }).from(assistantComputerStopBarriers).where(and(
    eq(assistantComputerStopBarriers.sessionId, identity.sessionId),
    eq(assistantComputerStopBarriers.agentInstanceId, identity.agentInstanceId),
  )).limit(1);
  return (rows[0]?.stoppedThroughIssuedAtMs ?? -1) >= identity.ticketIssuedAtMs;
}

function isDispatchStatus(value: unknown): value is AssistantComputerDispatchStatus {
  return value === "claimed" ||
    value === "dispatching" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "uncertain" ||
    value === "blocked";
}
