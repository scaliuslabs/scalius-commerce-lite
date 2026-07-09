import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import {
  assistantEvents,
  assistantRateLimitWindows,
  assistantSessions,
} from "@scalius/database/schema";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "@scalius/core/errors";
import {
  assistantWorkflowStatusSchema,
  type AssistantMessagePart,
  type AssistantWorkflowStatus,
} from "@scalius/shared/assistant-contracts";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";

import {
  canonicalizeAssistantJson,
  constantTimeAssistantHashEqual,
  hashAssistantRateLimitBucket,
} from "./assistant-crypto";
import {
  boundedPositiveInteger,
  createId,
  d1Timestamp,
  optionalPartsSchema,
  parseContract,
  requireCapabilityId,
  requireOpaqueId,
  selectAction,
  selectSession,
  selectWorkflow,
} from "./assistant-internal";
import type {
  AssistantEventView,
  AssistantRateLimitResult,
  CleanupAssistantRateLimitsResult,
  ListAssistantEventsResult,
} from "./assistant-types";
import { resumeAssistantSession } from "./assistant-sessions";

const MAX_EVENT_APPEND_ATTEMPTS = 5;
export const MAX_ASSISTANT_EVENT_LIST_LIMIT = 25;

export async function listAssistantEvents(
  db: Database,
  input: {
    credential: string;
    expectedSurface: "admin" | "storefront";
    expectedSessionId?: string;
    expectedActorId?: string | null;
    expectedConversationKey?: string;
    expectedPermissionSnapshotHash?: string | null;
    expectedSafeMetadata?: unknown | null;
    afterSequence?: number;
    limit?: number;
    now?: Date;
  },
): Promise<ListAssistantEventsResult> {
  const afterSequence = boundedEventCursor(input.afterSequence ?? 0);
  const limit = boundedPositiveInteger(
    input.limit ?? 20,
    MAX_ASSISTANT_EVENT_LIST_LIMIT,
    "Assistant event limit",
  );
  const session = await resumeAssistantSession(db, {
    credential: input.credential,
    expectedSurface: input.expectedSurface,
    expectedSessionId: input.expectedSessionId,
    expectedActorId: input.expectedActorId,
    expectedConversationKey: input.expectedConversationKey,
    expectedPermissionSnapshotHash: input.expectedPermissionSnapshotHash,
    expectedSafeMetadata: input.expectedSafeMetadata,
    now: input.now,
  });

  if (
    (input.expectedSessionId !== undefined &&
      session.id !== requireOpaqueId(input.expectedSessionId, "Session ID")) ||
    (input.expectedActorId !== undefined && session.actorId !== input.expectedActorId) ||
    (input.expectedConversationKey !== undefined &&
      session.conversationKey !== requireOpaqueId(
        input.expectedConversationKey,
        "Conversation key",
      )) ||
    !permissionSnapshotMatches(
      session.permissionSnapshotHash,
      input.expectedPermissionSnapshotHash,
    )
  ) {
    throw new UnauthorizedError(
      "Assistant session is unavailable for the current authority context.",
    );
  }

  const rows = await db
    .select()
    .from(assistantEvents)
    .where(
      and(
        eq(assistantEvents.sessionId, session.id),
        gt(assistantEvents.sequence, afterSequence),
      ),
    )
    .orderBy(asc(assistantEvents.sequence))
    .limit(limit + 1);

  const boundedRows = rows
    .filter(
      (row) => row.sessionId === session.id && row.sequence > afterSequence,
    )
    .sort((left, right) => left.sequence - right.sequence);
  const hasMore = boundedRows.length > limit;
  const visibleRows = boundedRows.slice(0, limit);
  const events = visibleRows.map(mapStoredEvent);
  const nextSequence = events.at(-1)?.sequence ?? afterSequence;

  return {
    session,
    events,
    cursor: {
      afterSequence,
      nextSequence,
      latestSequence: session.lastEventSequence,
      hasMore,
    },
  };
}

function boundedEventCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(
      "Assistant event cursor must be a bounded non-negative integer.",
    );
  }
  return value;
}

function permissionSnapshotMatches(
  actual: string | null,
  expected: string | null | undefined,
): boolean {
  if (expected === undefined) return true;
  if (actual === null || expected === null) return actual === expected;
  return constantTimeAssistantHashEqual(actual, expected);
}

function mapStoredEvent(
  row: typeof assistantEvents.$inferSelect,
): AssistantEventView {
  if (row.safePayload.length > 128 * 1024) {
    throw new ServiceUnavailableError(
      "Stored assistant event display content is unreadable.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(row.safePayload);
  } catch {
    throw new ServiceUnavailableError(
      "Stored assistant event display content is unreadable.",
    );
  }

  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as { parts?: unknown }
    : null;
  const parts = parseContract(
    () => optionalPartsSchema.parse(payload?.parts ?? []),
    "Stored assistant event display content is unreadable.",
  );

  return {
    eventId: row.id,
    sessionId: row.sessionId,
    workflowId: row.workflowId,
    actionId: row.actionId,
    sequence: row.sequence,
    type: row.type,
    status: row.status,
    occurredAt: row.createdAt.getTime(),
    parts,
  };
}

export async function appendAssistantEvent(
  db: Database,
  input: {
    sessionId: string;
    workflowId?: string | null;
    actionId?: string | null;
    type: string;
    status?: AssistantWorkflowStatus | null;
    traceId?: string | null;
    parts?: AssistantMessagePart[];
    now?: Date;
  },
): Promise<AssistantEventView> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const workflowId = input.workflowId
    ? requireOpaqueId(input.workflowId, "Workflow ID")
    : null;
  const actionId = input.actionId
    ? requireOpaqueId(input.actionId, "Action ID")
    : null;
  const type = requireCapabilityId(input.type, "Assistant event type");
  const status = input.status == null
    ? null
    : parseContract(
      () => assistantWorkflowStatusSchema.parse(input.status),
      "Assistant event status is invalid.",
    );
  const traceId = input.traceId ? requireOpaqueId(input.traceId, "Trace ID") : null;
  const parts = parseContract(
    () => optionalPartsSchema.parse(input.parts ?? []),
    "Assistant event contains unsupported display content.",
  );
  const safePayload = canonicalizeAssistantJson({ parts });
  const now = d1Timestamp(input.now ?? new Date());

  const session = await selectSession(db, sessionId);
  if (!session) throw new NotFoundError("Assistant session not found.");
  if (workflowId) {
    const workflow = await selectWorkflow(db, workflowId);
    if (!workflow || workflow.sessionId !== sessionId) {
      throw new NotFoundError("Assistant workflow not found in this session.");
    }
  }
  if (actionId) {
    const action = await selectAction(db, actionId);
    if (!action) throw new NotFoundError("Assistant action not found.");
    const actionWorkflow = await selectWorkflow(db, action.workflowId);
    if (!actionWorkflow || actionWorkflow.sessionId !== sessionId) {
      throw new NotFoundError("Assistant action not found in this session.");
    }
    if (workflowId && action.workflowId !== workflowId) {
      throw new ConflictError("Assistant event action does not belong to its workflow.");
    }
  }

  for (let attempt = 0; attempt < MAX_EVENT_APPEND_ATTEMPTS; attempt += 1) {
    const current = await selectSession(db, sessionId);
    if (!current) throw new NotFoundError("Assistant session not found.");
    const sequence = current.lastEventSequence + 1;
    const eventId = createId("aev");

    try {
      const [updatedSessions, insertedEvents] = await safeBatch(db, [
        db.update(assistantSessions).set({
          lastEventSequence: sequence,
          updatedAt: now,
        }).where(and(
          eq(assistantSessions.id, sessionId),
          eq(assistantSessions.lastEventSequence, current.lastEventSequence),
        )).returning({ id: assistantSessions.id }),
        db.insert(assistantEvents).values({
          id: eventId,
          sessionId,
          workflowId,
          actionId,
          sequence,
          type,
          status,
          actorType: current.actorType,
          actorId: current.actorId,
          traceId,
          safePayload,
          createdAt: now,
        }).returning({ id: assistantEvents.id }),
      ] as const);

      if (updatedSessions[0]?.id && insertedEvents[0]?.id) {
        return {
          eventId,
          sessionId,
          workflowId,
          actionId,
          sequence,
          type,
          status,
          occurredAt: now.getTime(),
          parts,
        };
      }
    } catch (error) {
      if (!isEventSequenceConflict(error) || attempt === MAX_EVENT_APPEND_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw new ServiceUnavailableError("Assistant event sequence was busy. Please retry the append.");
}

export async function consumeAssistantRateLimit(
  db: Database,
  input: {
    scope: string;
    bucket: string;
    hashKey: string;
    limit: number;
    windowSeconds: number;
    now?: Date;
  },
): Promise<AssistantRateLimitResult> {
  const scope = requireCapabilityId(input.scope, "Rate-limit scope");
  const limit = boundedPositiveInteger(input.limit, 10_000, "Rate-limit request limit");
  const windowSeconds = boundedPositiveInteger(
    input.windowSeconds,
    24 * 60 * 60,
    "Rate-limit window",
  );
  const now = d1Timestamp(input.now ?? new Date());
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const windowStartedAt = new Date(
    Math.floor(nowSeconds / windowSeconds) * windowSeconds * 1_000,
  );
  const expiresAt = new Date(windowStartedAt.getTime() + windowSeconds * 1_000);
  const bucketHash = await hashAssistantRateLimitBucket(scope, input.bucket, input.hashKey);

  const inserted = await db.insert(assistantRateLimitWindows).values({
    bucketHash,
    scope,
    windowStartedAt,
    expiresAt,
    requestCount: 1,
    updatedAt: now,
  }).onConflictDoNothing().returning({
    requestCount: assistantRateLimitWindows.requestCount,
  });
  if (inserted[0]) {
    return {
      allowed: true,
      count: 1,
      remaining: Math.max(0, limit - 1),
      resetAt: expiresAt.getTime(),
    };
  }

  const incremented = await db.update(assistantRateLimitWindows).set({
    requestCount: sql`${assistantRateLimitWindows.requestCount} + 1`,
    updatedAt: now,
  }).where(and(
    eq(assistantRateLimitWindows.bucketHash, bucketHash),
    eq(assistantRateLimitWindows.scope, scope),
    eq(assistantRateLimitWindows.windowStartedAt, windowStartedAt),
    gt(assistantRateLimitWindows.expiresAt, now),
    sql`${assistantRateLimitWindows.requestCount} < ${limit}`,
  )).returning({
    requestCount: assistantRateLimitWindows.requestCount,
    expiresAt: assistantRateLimitWindows.expiresAt,
  });
  if (incremented[0]) {
    return {
      allowed: true,
      count: incremented[0].requestCount,
      remaining: Math.max(0, limit - incremented[0].requestCount),
      resetAt: incremented[0].expiresAt.getTime(),
    };
  }

  const current = await db.select({
    requestCount: assistantRateLimitWindows.requestCount,
    expiresAt: assistantRateLimitWindows.expiresAt,
  }).from(assistantRateLimitWindows).where(and(
    eq(assistantRateLimitWindows.bucketHash, bucketHash),
    eq(assistantRateLimitWindows.scope, scope),
    eq(assistantRateLimitWindows.windowStartedAt, windowStartedAt),
  )).get();
  if (!current) {
    throw new ServiceUnavailableError("Assistant rate-limit state is unavailable.");
  }
  throw new RateLimitError(
    "Assistant request limit reached. Please try again later.",
    Math.max(1, Math.ceil((current.expiresAt.getTime() - now.getTime()) / 1_000)),
  );
}

export async function cleanupExpiredAssistantRateLimits(
  db: Database,
  now = new Date(),
  options: { limit?: number } = {},
): Promise<CleanupAssistantRateLimitsResult> {
  const limit = boundedPositiveInteger(options.limit ?? 200, 500, "Cleanup limit");
  const cutoff = d1Timestamp(now);
  const rows = await db.select({
    bucketHash: assistantRateLimitWindows.bucketHash,
    scope: assistantRateLimitWindows.scope,
    windowStartedAt: assistantRateLimitWindows.windowStartedAt,
  }).from(assistantRateLimitWindows)
    .where(lte(assistantRateLimitWindows.expiresAt, cutoff))
    .limit(limit + 1);

  const deleteRows = rows.slice(0, limit);
  let deleted = 0;
  if (deleteRows.length > 0) {
    const removed = await db.delete(assistantRateLimitWindows).where(or(
      ...deleteRows.map((row) => and(
        eq(assistantRateLimitWindows.bucketHash, row.bucketHash),
        eq(assistantRateLimitWindows.scope, row.scope),
        eq(assistantRateLimitWindows.windowStartedAt, row.windowStartedAt),
      )),
    )).returning({ bucketHash: assistantRateLimitWindows.bucketHash });
    deleted = removed.length;
  }
  return {
    scanned: deleteRows.length,
    deleted,
    limit,
    hasMore: rows.length > limit,
  };
}

function isEventSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /assistant_events.*(?:session_id|sequence)|assistant_events_session_sequence_unique|UNIQUE constraint failed/i
    .test(message);
}
