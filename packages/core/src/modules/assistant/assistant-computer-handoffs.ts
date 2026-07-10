import type { Database } from "@scalius/database/client";
import {
  assistantComputerHandoffs,
  assistantComputerStopBarriers,
} from "@scalius/database/schema";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { and, count, eq, isNull, lte, or, sql } from "drizzle-orm";

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
const MAX_TICKET_LIFETIME_MS = 120_000;
const MAX_TICKET_CLOCK_SKEW_MS = 5_000;
const ADMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const ADMISSION_LEASE_MS = 30_000;

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

export interface AssistantComputerStopBarrierResult {
  status: "ready" | "pending";
  stoppedThroughIssuedAtMs: number;
  blockedDispatches: number;
  pendingDispatches: number;
  pendingAdmissions: number;
}

export type BeginAssistantAgentAdmissionResult =
  | { status: "started"; admissionId: string; admissionClaimToken: string }
  | { status: "stopping" | "busy" };

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

/**
 * Opens the single prompt-admission lease for an agent instance. The row and
 * Stop share one D1 serialization point: an admission that wins first is
 * visible to Stop, while a Stop that wins first prevents admission entirely.
 */
export async function beginAssistantAgentAdmission(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    now?: Date;
  },
): Promise<BeginAssistantAgentAdmissionResult> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const admissionId = randomBase64Url(16);
  const admissionClaimToken = randomBase64Url(32);
  const admissionClaimHash = await hashDispatchClaim(admissionClaimToken);
  const activeAdmissionExpiresAt = new Date(now.getTime() + ADMISSION_LEASE_MS);
  const values = {
    activeAdmissionId: admissionId,
    activeAdmissionClaimHash: admissionClaimHash,
    activeAdmissionExpiresAt,
    updatedAt: now,
  };

  const inserted = await db.insert(assistantComputerStopBarriers).values({
    sessionId,
    agentInstanceId,
    stoppedThroughIssuedAtMs: 0,
    stopping: false,
    ...values,
    createdAt: now,
  }).onConflictDoNothing().returning();
  if (inserted[0]) {
    return { status: "started", admissionId, admissionClaimToken };
  }

  const opened = await db.update(assistantComputerStopBarriers).set(values)
    .where(and(
      eq(assistantComputerStopBarriers.sessionId, sessionId),
      eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
      eq(assistantComputerStopBarriers.stopping, false),
      isNull(assistantComputerStopBarriers.activeAdmissionId),
    )).returning();
  if (opened[0]) {
    return { status: "started", admissionId, admissionClaimToken };
  }

  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (!barrier || barrier.sessionId !== sessionId) {
    throw new ServiceUnavailableError("Assistant admission barrier is unavailable.");
  }
  return { status: barrier.stopping ? "stopping" : "busy" };
}

export async function finishAssistantAgentAdmission(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    admissionId: string;
    admissionClaimToken: string;
    now?: Date;
  },
): Promise<{ status: "finished" | "replayed" }> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const admissionId = requirePattern(
    input.admissionId,
    ADMISSION_ID_PATTERN,
    "Admission ID",
  );
  const admissionClaimToken = requirePattern(
    input.admissionClaimToken,
    CLAIM_TOKEN_PATTERN,
    "Admission claim",
  );
  const admissionClaimHash = await hashDispatchClaim(admissionClaimToken);
  const now = d1Timestamp(input.now ?? new Date());
  const finished = await db.update(assistantComputerStopBarriers).set({
    activeAdmissionId: null,
    activeAdmissionClaimHash: null,
    activeAdmissionExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(assistantComputerStopBarriers.sessionId, sessionId),
    eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
    eq(assistantComputerStopBarriers.activeAdmissionId, admissionId),
    eq(assistantComputerStopBarriers.activeAdmissionClaimHash, admissionClaimHash),
  )).returning();
  if (finished[0]) return { status: "finished" };

  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (
    barrier?.sessionId === sessionId &&
    barrier.activeAdmissionId === null &&
    barrier.activeAdmissionClaimHash === null
  ) {
    return { status: "replayed" };
  }
  throw new ServiceUnavailableError("Assistant admission settlement is unavailable.");
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

export async function recordAssistantComputerStopBarrier(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    stoppedThroughIssuedAtMs?: number;
    now?: Date;
  },
): Promise<AssistantComputerStopBarrierResult> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const stoppedThroughIssuedAtMs = input.stoppedThroughIssuedAtMs ??
    (input.now ?? new Date()).getTime();
  if (
    !Number.isSafeInteger(stoppedThroughIssuedAtMs) ||
    stoppedThroughIssuedAtMs <= 0
  ) {
    throw new ValidationError("Computer stop barrier is invalid.");
  }

  const barrierWrite = db.insert(assistantComputerStopBarriers).values({
    sessionId,
    agentInstanceId,
    stoppedThroughIssuedAtMs,
    stopping: true,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: assistantComputerStopBarriers.agentInstanceId,
    set: {
      stoppedThroughIssuedAtMs: sql`max(${assistantComputerStopBarriers.stoppedThroughIssuedAtMs}, ${stoppedThroughIssuedAtMs})`,
      stopping: true,
      updatedAt: now,
    },
  }).returning();
  const blockPreAbort = db.update(assistantComputerHandoffs).set({
    dispatchStatus: "blocked",
    updatedAt: now,
  }).where(and(
    eq(assistantComputerHandoffs.sessionId, sessionId),
    eq(assistantComputerHandoffs.agentInstanceId, agentInstanceId),
    eq(assistantComputerHandoffs.state, "dispatched"),
    or(
      eq(assistantComputerHandoffs.dispatchStatus, "claimed"),
      eq(assistantComputerHandoffs.dispatchStatus, "uncertain"),
    ),
    lte(assistantComputerHandoffs.ticketIssuedAtMs, stoppedThroughIssuedAtMs),
  )).returning({ requestId: assistantComputerHandoffs.requestId });

  const [barriers, blocked] = await db.batch([barrierWrite, blockPreAbort]);
  const barrier = barriers[0];
  if (
    !barrier ||
    barrier.sessionId !== sessionId ||
    barrier.agentInstanceId !== agentInstanceId ||
    barrier.stoppedThroughIssuedAtMs < stoppedThroughIssuedAtMs
  ) {
    throw new ServiceUnavailableError("Assistant computer stop barrier is unavailable.");
  }

  return describeAssistantStopBarrier(db, barrier, blocked.length);
}

export async function readAssistantComputerStopBarrier(
  db: Database,
  input: { sessionId: string; agentInstanceId: string; now?: Date },
): Promise<AssistantComputerStopBarrierResult> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (!barrier || barrier.sessionId !== sessionId || !barrier.stopping) {
    throw new ServiceUnavailableError("Assistant computer stop barrier is unavailable.");
  }
  const blocked = await db.update(assistantComputerHandoffs).set({
    dispatchStatus: "blocked",
    updatedAt: d1Timestamp(input.now ?? new Date()),
  }).where(and(
    eq(assistantComputerHandoffs.sessionId, sessionId),
    eq(assistantComputerHandoffs.agentInstanceId, agentInstanceId),
    eq(assistantComputerHandoffs.state, "dispatched"),
    or(
      eq(assistantComputerHandoffs.dispatchStatus, "claimed"),
      eq(assistantComputerHandoffs.dispatchStatus, "uncertain"),
    ),
    lte(
      assistantComputerHandoffs.ticketIssuedAtMs,
      barrier.stoppedThroughIssuedAtMs,
    ),
  )).returning({ requestId: assistantComputerHandoffs.requestId });
  return describeAssistantStopBarrier(
    db,
    barrier,
    blocked.length,
  );
}

export async function finishAssistantComputerStopBarrier(
  db: Database,
  input: { sessionId: string; agentInstanceId: string; now?: Date },
): Promise<{ status: "finished" | "replayed" }> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requirePattern(
    input.agentInstanceId,
    INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (!barrier || barrier.sessionId !== sessionId) {
    throw new ServiceUnavailableError("Assistant computer stop barrier is unavailable.");
  }
  if (!barrier.stopping) return { status: "replayed" };
  const readiness = await describeAssistantStopBarrier(db, barrier, 0);
  if (readiness.status !== "ready") {
    throw new ServiceUnavailableError("Assistant work is still settling.");
  }
  const finished = await db.update(assistantComputerStopBarriers).set({
    stopping: false,
    activeAdmissionId: null,
    activeAdmissionClaimHash: null,
    activeAdmissionExpiresAt: null,
    lastStopCompletedAt: now,
    updatedAt: now,
  }).where(and(
    eq(assistantComputerStopBarriers.sessionId, sessionId),
    eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
    eq(assistantComputerStopBarriers.stopping, true),
  )).returning();
  if (finished[0]) return { status: "finished" };
  throw new ServiceUnavailableError("Assistant computer stop completion is unavailable.");
}

async function describeAssistantStopBarrier(
  db: Database,
  barrier: typeof assistantComputerStopBarriers.$inferSelect,
  blockedDispatches: number,
): Promise<AssistantComputerStopBarrierResult> {
  const pendingRows = await db.select({ count: count() })
    .from(assistantComputerHandoffs)
    .where(and(
      eq(assistantComputerHandoffs.sessionId, barrier.sessionId),
      eq(assistantComputerHandoffs.agentInstanceId, barrier.agentInstanceId),
      eq(assistantComputerHandoffs.state, "dispatched"),
      or(
        eq(assistantComputerHandoffs.dispatchStatus, "dispatching"),
        eq(assistantComputerHandoffs.dispatchStatus, "uncertain"),
      ),
      lte(
        assistantComputerHandoffs.ticketIssuedAtMs,
        barrier.stoppedThroughIssuedAtMs,
      ),
    ));
  const pendingDispatches = pendingRows[0]?.count ?? 0;
  const pendingAdmissions = barrier.activeAdmissionId !== null &&
      barrier.activeAdmissionClaimHash !== null
    ? 1
    : 0;
  return {
    status: pendingDispatches === 0 && pendingAdmissions === 0 ? "ready" : "pending",
    stoppedThroughIssuedAtMs: barrier.stoppedThroughIssuedAtMs,
    blockedDispatches,
    pendingDispatches,
    pendingAdmissions,
  };
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

async function selectStopBarrier(db: Database, agentInstanceId: string) {
  const rows = await db.select().from(assistantComputerStopBarriers).where(
    eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
  ).limit(1);
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
  return {
    sessionId,
    agentInstanceId,
    requestId,
    programDigest,
    dispatchClaimHash: await hashDispatchClaim(dispatchClaimToken),
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
