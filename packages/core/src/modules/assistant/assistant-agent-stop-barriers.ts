import type { Database } from "@scalius/database/client";
import {
  assistantComputerHandoffs,
  assistantComputerStopBarriers,
} from "@scalius/database/schema";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { and, count, eq, isNull, lte, or, sql } from "drizzle-orm";

import { d1Timestamp, requireOpaqueId } from "./assistant-internal";
import {
  ASSISTANT_CLAIM_TOKEN_PATTERN,
  ASSISTANT_INSTANCE_ID_PATTERN,
  hashAssistantDispatchClaim,
  randomAssistantBase64Url,
  requireAssistantPattern,
} from "./assistant-computer-handoff-internal";

const ADMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const ADMISSION_LEASE_MS = 30_000;

export interface AssistantComputerStopBarrierResult {
  status: "ready" | "pending";
  stoppedThroughIssuedAtMs: number;
  blockedDispatches: number;
  pendingDispatches: number;
  pendingAdmissions: number;
}

export interface AssistantAgentStopReconciliationResult {
  status: "reconciled" | "replayed";
  readiness: AssistantComputerStopBarrierResult["status"];
  stoppedThroughIssuedAtMs: number;
  blockedDispatches: number;
  pendingDispatches: number;
  pendingAdmissions: number;
}

export type BeginAssistantAgentAdmissionResult =
  | {
      status: "started";
      admissionId: string;
      admissionClaimToken: string;
      generation: number;
    }
  | { status: "stopping" | "busy" };

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
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const admissionId = randomAssistantBase64Url(16);
  const admissionClaimToken = randomAssistantBase64Url(32);
  const admissionClaimHash = await hashAssistantDispatchClaim(
    admissionClaimToken,
  );
  const activeAdmissionExpiresAt = new Date(now.getTime() + ADMISSION_LEASE_MS);
  const values = {
    activeAdmissionId: admissionId,
    activeAdmissionClaimHash: admissionClaimHash,
    activeAdmissionExpiresAt,
    updatedAt: now,
  };

  const inserted = await db
    .insert(assistantComputerStopBarriers)
    .values({
      sessionId,
      agentInstanceId,
      stoppedThroughIssuedAtMs: 0,
      stopping: false,
      ...values,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return {
      status: "started",
      admissionId,
      admissionClaimToken,
      generation: admissionGeneration(inserted[0], now),
    };
  }

  const opened = await db
    .update(assistantComputerStopBarriers)
    .set(values)
    .where(
      and(
        eq(assistantComputerStopBarriers.sessionId, sessionId),
        eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
        eq(assistantComputerStopBarriers.stopping, false),
        isNull(assistantComputerStopBarriers.activeAdmissionId),
      ),
    )
    .returning();
  if (opened[0]) {
    return {
      status: "started",
      admissionId,
      admissionClaimToken,
      generation: admissionGeneration(opened[0], now),
    };
  }

  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (!barrier || barrier.sessionId !== sessionId) {
    throw new ServiceUnavailableError(
      "Assistant admission barrier is unavailable.",
    );
  }
  return { status: barrier.stopping ? "stopping" : "busy" };
}

function admissionGeneration(
  barrier: typeof assistantComputerStopBarriers.$inferSelect,
  now: Date,
): number {
  const generation = Math.max(
    now.getTime(),
    barrier.stoppedThroughIssuedAtMs + 1,
  );
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new ServiceUnavailableError(
      "Assistant admission generation is unavailable.",
    );
  }
  return generation;
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
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const admissionId = requireAssistantPattern(
    input.admissionId,
    ADMISSION_ID_PATTERN,
    "Admission ID",
  );
  const admissionClaimToken = requireAssistantPattern(
    input.admissionClaimToken,
    ASSISTANT_CLAIM_TOKEN_PATTERN,
    "Admission claim",
  );
  const admissionClaimHash = await hashAssistantDispatchClaim(
    admissionClaimToken,
  );
  const now = d1Timestamp(input.now ?? new Date());
  const finished = await db
    .update(assistantComputerStopBarriers)
    .set({
      activeAdmissionId: null,
      activeAdmissionClaimHash: null,
      activeAdmissionExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantComputerStopBarriers.sessionId, sessionId),
        eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
        eq(assistantComputerStopBarriers.activeAdmissionId, admissionId),
        eq(
          assistantComputerStopBarriers.activeAdmissionClaimHash,
          admissionClaimHash,
        ),
      ),
    )
    .returning();
  if (finished[0]) return { status: "finished" };

  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (
    barrier?.sessionId === sessionId &&
    barrier.activeAdmissionId === null &&
    barrier.activeAdmissionClaimHash === null
  ) {
    return { status: "replayed" };
  }
  throw new ServiceUnavailableError(
    "Assistant admission settlement is unavailable.",
  );
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
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const stoppedThroughIssuedAtMs =
    input.stoppedThroughIssuedAtMs ?? (input.now ?? new Date()).getTime();
  if (
    !Number.isSafeInteger(stoppedThroughIssuedAtMs) ||
    stoppedThroughIssuedAtMs <= 0
  ) {
    throw new ValidationError("Computer stop barrier is invalid.");
  }

  const barrierWrite = db
    .insert(assistantComputerStopBarriers)
    .values({
      sessionId,
      agentInstanceId,
      stoppedThroughIssuedAtMs,
      stopping: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: assistantComputerStopBarriers.agentInstanceId,
      set: {
        // A post-Stop admission may have used the prior cutoff + 1 when the
        // wall clock repeated. Always advance the next Stop beyond that value.
        stoppedThroughIssuedAtMs: sql`max(${assistantComputerStopBarriers.stoppedThroughIssuedAtMs} + 1, ${stoppedThroughIssuedAtMs})`,
        stopping: true,
        updatedAt: now,
      },
    })
    .returning();
  const blockPreAbort = db
    .update(assistantComputerHandoffs)
    .set({
      dispatchStatus: "blocked",
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantComputerHandoffs.sessionId, sessionId),
        eq(assistantComputerHandoffs.agentInstanceId, agentInstanceId),
        eq(assistantComputerHandoffs.state, "dispatched"),
        or(
          eq(assistantComputerHandoffs.dispatchStatus, "claimed"),
          eq(assistantComputerHandoffs.dispatchStatus, "uncertain"),
        ),
        lte(
          assistantComputerHandoffs.ticketIssuedAtMs,
          stoppedThroughIssuedAtMs,
        ),
      ),
    )
    .returning({ requestId: assistantComputerHandoffs.requestId });

  const [barriers, blocked] = await db.batch([barrierWrite, blockPreAbort]);
  const barrier = barriers[0];
  if (
    !barrier ||
    barrier.sessionId !== sessionId ||
    barrier.agentInstanceId !== agentInstanceId ||
    barrier.stoppedThroughIssuedAtMs < stoppedThroughIssuedAtMs
  ) {
    throw new ServiceUnavailableError(
      "Assistant computer stop barrier is unavailable.",
    );
  }

  return describeAssistantStopBarrier(db, barrier, blocked.length);
}

export async function readAssistantComputerStopBarrier(
  db: Database,
  input: { sessionId: string; agentInstanceId: string; now?: Date },
): Promise<AssistantComputerStopBarrierResult> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (!barrier || barrier.sessionId !== sessionId || !barrier.stopping) {
    throw new ServiceUnavailableError(
      "Assistant computer stop barrier is unavailable.",
    );
  }
  const blocked = await db
    .update(assistantComputerHandoffs)
    .set({
      dispatchStatus: "blocked",
      updatedAt: d1Timestamp(input.now ?? new Date()),
    })
    .where(
      and(
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
      ),
    )
    .returning({ requestId: assistantComputerHandoffs.requestId });
  return describeAssistantStopBarrier(db, barrier, blocked.length);
}

/**
 * Settles pre-cutoff admission state only after the caller has received an
 * exact successful abort from the Flue Durable Object for the same cutoff.
 * Expiry alone never grants this transition.
 */
export async function reconcileAssistantAgentAdmissionAfterStop(
  db: Database,
  input: {
    sessionId: string;
    agentInstanceId: string;
    stoppedThroughIssuedAtMs: number;
    now?: Date;
  },
): Promise<AssistantAgentStopReconciliationResult> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  if (
    !Number.isSafeInteger(input.stoppedThroughIssuedAtMs) ||
    input.stoppedThroughIssuedAtMs <= 0
  ) {
    throw new ValidationError("Computer stop barrier is invalid.");
  }
  const now = d1Timestamp(input.now ?? new Date());
  const existing = await selectStopBarrier(db, agentInstanceId);
  if (
    !existing ||
    existing.sessionId !== sessionId ||
    existing.stoppedThroughIssuedAtMs !== input.stoppedThroughIssuedAtMs ||
    !existing.stopping
  ) {
    throw new ServiceUnavailableError(
      "Assistant computer stop reconciliation is unavailable.",
    );
  }
  const hadActiveAdmission =
    existing.activeAdmissionId !== null ||
    existing.activeAdmissionClaimHash !== null;
  const settleAdmission = db
    .update(assistantComputerStopBarriers)
    .set({
      activeAdmissionId: null,
      activeAdmissionClaimHash: null,
      activeAdmissionExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantComputerStopBarriers.sessionId, sessionId),
        eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
        eq(assistantComputerStopBarriers.stopping, true),
        eq(
          assistantComputerStopBarriers.stoppedThroughIssuedAtMs,
          input.stoppedThroughIssuedAtMs,
        ),
      ),
    )
    .returning();
  const settleDispatches = db
    .update(assistantComputerHandoffs)
    .set({
      dispatchStatus: "blocked",
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantComputerHandoffs.sessionId, sessionId),
        eq(assistantComputerHandoffs.agentInstanceId, agentInstanceId),
        eq(assistantComputerHandoffs.state, "dispatched"),
        or(
          eq(assistantComputerHandoffs.dispatchStatus, "claimed"),
          eq(assistantComputerHandoffs.dispatchStatus, "dispatching"),
          eq(assistantComputerHandoffs.dispatchStatus, "uncertain"),
        ),
        lte(
          assistantComputerHandoffs.ticketIssuedAtMs,
          input.stoppedThroughIssuedAtMs,
        ),
      ),
    )
    .returning({ requestId: assistantComputerHandoffs.requestId });

  const [barriers, blocked] = await db.batch([
    settleAdmission,
    settleDispatches,
  ]);
  const barrier = barriers[0];
  if (
    !barrier ||
    barrier.sessionId !== sessionId ||
    barrier.agentInstanceId !== agentInstanceId ||
    barrier.stoppedThroughIssuedAtMs !== input.stoppedThroughIssuedAtMs ||
    !barrier.stopping
  ) {
    throw new ServiceUnavailableError(
      "Assistant computer stop reconciliation is unavailable.",
    );
  }
  const readiness = await describeAssistantStopBarrier(
    db,
    barrier,
    blocked.length,
  );
  return {
    status:
      hadActiveAdmission || blocked.length > 0 ? "reconciled" : "replayed",
    readiness: readiness.status,
    stoppedThroughIssuedAtMs: readiness.stoppedThroughIssuedAtMs,
    blockedDispatches: readiness.blockedDispatches,
    pendingDispatches: readiness.pendingDispatches,
    pendingAdmissions: readiness.pendingAdmissions,
  };
}

export async function finishAssistantComputerStopBarrier(
  db: Database,
  input: { sessionId: string; agentInstanceId: string; now?: Date },
): Promise<{ status: "finished" | "replayed" }> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const agentInstanceId = requireAssistantPattern(
    input.agentInstanceId,
    ASSISTANT_INSTANCE_ID_PATTERN,
    "Agent instance ID",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const barrier = await selectStopBarrier(db, agentInstanceId);
  if (!barrier || barrier.sessionId !== sessionId) {
    throw new ServiceUnavailableError(
      "Assistant computer stop barrier is unavailable.",
    );
  }
  if (!barrier.stopping) return { status: "replayed" };
  const readiness = await describeAssistantStopBarrier(db, barrier, 0);
  if (readiness.status !== "ready") {
    throw new ServiceUnavailableError("Assistant work is still settling.");
  }
  const finished = await db
    .update(assistantComputerStopBarriers)
    .set({
      stopping: false,
      activeAdmissionId: null,
      activeAdmissionClaimHash: null,
      activeAdmissionExpiresAt: null,
      lastStopCompletedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantComputerStopBarriers.sessionId, sessionId),
        eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId),
        eq(assistantComputerStopBarriers.stopping, true),
      ),
    )
    .returning();
  if (finished[0]) return { status: "finished" };
  throw new ServiceUnavailableError(
    "Assistant computer stop completion is unavailable.",
  );
}

async function describeAssistantStopBarrier(
  db: Database,
  barrier: typeof assistantComputerStopBarriers.$inferSelect,
  blockedDispatches: number,
): Promise<AssistantComputerStopBarrierResult> {
  const pendingRows = await db
    .select({ count: count() })
    .from(assistantComputerHandoffs)
    .where(
      and(
        eq(assistantComputerHandoffs.sessionId, barrier.sessionId),
        eq(
          assistantComputerHandoffs.agentInstanceId,
          barrier.agentInstanceId,
        ),
        eq(assistantComputerHandoffs.state, "dispatched"),
        or(
          eq(assistantComputerHandoffs.dispatchStatus, "dispatching"),
          eq(assistantComputerHandoffs.dispatchStatus, "uncertain"),
        ),
        lte(
          assistantComputerHandoffs.ticketIssuedAtMs,
          barrier.stoppedThroughIssuedAtMs,
        ),
      ),
    );
  const pendingDispatches = pendingRows[0]?.count ?? 0;
  const pendingAdmissions =
    barrier.activeAdmissionId !== null &&
    barrier.activeAdmissionClaimHash !== null
      ? 1
      : 0;
  return {
    status:
      pendingDispatches === 0 && pendingAdmissions === 0 ? "ready" : "pending",
    stoppedThroughIssuedAtMs: barrier.stoppedThroughIssuedAtMs,
    blockedDispatches,
    pendingDispatches,
    pendingAdmissions,
  };
}

async function selectStopBarrier(db: Database, agentInstanceId: string) {
  const rows = await db
    .select()
    .from(assistantComputerStopBarriers)
    .where(eq(assistantComputerStopBarriers.agentInstanceId, agentInstanceId))
    .limit(1);
  return rows[0] ?? null;
}
