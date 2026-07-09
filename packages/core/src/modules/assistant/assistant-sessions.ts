import type { Database } from "@scalius/database/client";
import { assistantSessions, assistantWorkflows } from "@scalius/database/schema";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "@scalius/core/errors";
import {
  assistantActorTypeSchema,
  assistantRiskClassSchema,
  assistantSurfaceSchema,
  type AssistantActorType,
  type AssistantMessagePart,
  type AssistantRiskClass,
  type AssistantSurface,
} from "@scalius/shared/assistant-contracts";
import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { canonicalizeAssistantJson, hashAssistantSessionCredential } from "./assistant-crypto";
import {
  MAX_SAFE_METADATA_BYTES,
  addSeconds,
  assertActorMatchesSurface,
  boundedSeconds,
  createId,
  d1Timestamp,
  loadActiveSession,
  mapSession,
  mapWorkflow,
  normalizeActorId,
  normalizePermissionSnapshotHash,
  optionalPartsSchema,
  parseContract,
  requireCapabilityId,
  requireOpaqueId,
  selectSession,
  selectSessionByConversationKey,
  selectSessionByCredentialHash,
  selectWorkflow,
  selectWorkflowByRequest,
} from "./assistant-internal";
import type { AssistantSessionView, AssistantWorkflowView } from "./assistant-types";

const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function createAssistantSession(
  db: Database,
  input: {
    surface: AssistantSurface;
    actorType: AssistantActorType;
    actorId?: string | null;
    conversationKey: string;
    credential: string;
    permissionSnapshotHash?: string | null;
    safeMetadata?: unknown;
    ttlSeconds?: number;
    now?: Date;
  },
): Promise<{ session: AssistantSessionView; credential: string; replayed: boolean }> {
  const surface = parseContract(
    () => assistantSurfaceSchema.parse(input.surface),
    "Assistant surface is invalid.",
  );
  const actorType = parseContract(
    () => assistantActorTypeSchema.parse(input.actorType),
    "Assistant actor type is invalid.",
  );
  assertActorMatchesSurface(surface, actorType);

  const actorId = normalizeActorId(input.actorId, actorType);
  const conversationKey = requireOpaqueId(input.conversationKey, "Conversation key");
  const permissionSnapshotHash = normalizePermissionSnapshotHash(
    input.permissionSnapshotHash ?? null,
  );
  if (surface === "admin" && actorType !== "system" && !permissionSnapshotHash) {
    throw new ValidationError("Admin assistant sessions require a permission snapshot hash.");
  }

  const safeMetadata = input.safeMetadata === undefined
    ? null
    : canonicalizeAssistantJson(input.safeMetadata, { maxBytes: MAX_SAFE_METADATA_BYTES });
  const now = d1Timestamp(input.now ?? new Date());
  const ttlSeconds = boundedSeconds(
    input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
    60,
    MAX_SESSION_TTL_SECONDS,
    "Session TTL",
  );
  const expiresAt = addSeconds(now, ttlSeconds);
  const credential = input.credential.trim();
  const credentialHash = await hashAssistantSessionCredential(credential);

  const inserted = await db.insert(assistantSessions).values({
    id: createId("as"),
    surface,
    actorType,
    actorId,
    credentialHash,
    conversationKey,
    status: "active",
    lastEventSequence: 0,
    permissionSnapshotHash,
    safeMetadata,
    expiresAt,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();

  const row = inserted[0];
  if (row) {
    return { session: mapSession(row), credential, replayed: false };
  }

  const existing = await selectSessionByConversationKey(db, conversationKey) ??
    await selectSessionByCredentialHash(db, credentialHash);
  if (
    !existing ||
    existing.conversationKey !== conversationKey ||
    existing.credentialHash !== credentialHash ||
    existing.surface !== surface ||
    existing.actorType !== actorType ||
    existing.actorId !== actorId ||
    existing.permissionSnapshotHash !== permissionSnapshotHash ||
    existing.safeMetadata !== safeMetadata ||
    existing.status !== "active" ||
    existing.expiresAt <= now ||
    Math.round((existing.expiresAt.getTime() - existing.createdAt.getTime()) / 1_000) !== ttlSeconds
  ) {
    throw new ConflictError(
      "Assistant conversation or credential is already owned by another session.",
    );
  }

  return { session: mapSession(existing), credential, replayed: true };
}

export async function resumeAssistantSession(
  db: Database,
  input: {
    credential: string;
    expectedSurface?: AssistantSurface;
    expectedSessionId?: string;
    expectedActorId?: string | null;
    expectedConversationKey?: string;
    expectedPermissionSnapshotHash?: string | null;
    expectedSafeMetadata?: unknown | null;
    touchAfterSeconds?: number;
    now?: Date;
  },
): Promise<AssistantSessionView> {
  const credentialHash = await hashAssistantSessionCredential(input.credential);
  const now = d1Timestamp(input.now ?? new Date());
  const conditions = [
    eq(assistantSessions.credentialHash, credentialHash),
    eq(assistantSessions.status, "active"),
    gt(assistantSessions.expiresAt, now),
  ];
  if (input.expectedSurface) {
    conditions.push(eq(
      assistantSessions.surface,
      parseContract(
        () => assistantSurfaceSchema.parse(input.expectedSurface),
        "Assistant surface is invalid.",
      ),
    ));
  }
  if (input.expectedSessionId !== undefined) {
    conditions.push(eq(
      assistantSessions.id,
      requireOpaqueId(input.expectedSessionId, "Session ID"),
    ));
  }
  if (input.expectedActorId !== undefined) {
    conditions.push(input.expectedActorId === null
      ? isNull(assistantSessions.actorId)
      : eq(
        assistantSessions.actorId,
        requireOpaqueId(input.expectedActorId, "Assistant actor ID"),
      ));
  }
  if (input.expectedConversationKey !== undefined) {
    conditions.push(eq(
      assistantSessions.conversationKey,
      requireOpaqueId(input.expectedConversationKey, "Conversation key"),
    ));
  }
  if (input.expectedPermissionSnapshotHash !== undefined) {
    const expectedHash = normalizePermissionSnapshotHash(
      input.expectedPermissionSnapshotHash,
    );
    conditions.push(expectedHash === null
      ? isNull(assistantSessions.permissionSnapshotHash)
      : eq(assistantSessions.permissionSnapshotHash, expectedHash));
  }
  if (input.expectedSafeMetadata !== undefined) {
    const expectedMetadata = input.expectedSafeMetadata === null
      ? null
      : canonicalizeAssistantJson(input.expectedSafeMetadata, {
        maxBytes: MAX_SAFE_METADATA_BYTES,
      });
    conditions.push(expectedMetadata === null
      ? isNull(assistantSessions.safeMetadata)
      : eq(assistantSessions.safeMetadata, expectedMetadata));
  }

  const touchAfterSeconds = input.touchAfterSeconds ?? 0;
  if (
    !Number.isSafeInteger(touchAfterSeconds) ||
    touchAfterSeconds < 0 ||
    touchAfterSeconds > 24 * 60 * 60
  ) {
    throw new ValidationError(
      "Assistant session touch interval must be between 0 and 86400 seconds.",
    );
  }

  if (touchAfterSeconds > 0) {
    const active = await db.select().from(assistantSessions)
      .where(and(...conditions)).limit(1);
    const row = active[0];
    if (
      row &&
      row.lastSeenAt.getTime() > now.getTime() - touchAfterSeconds * 1_000
    ) {
      return mapSession(row);
    }
    const touchThreshold = new Date(
      now.getTime() - touchAfterSeconds * 1_000,
    );
    const touched = await db.update(assistantSessions).set({
      lastSeenAt: now,
      updatedAt: now,
    }).where(and(
      ...conditions,
      lte(assistantSessions.lastSeenAt, touchThreshold),
    )).returning();
    if (touched[0]) return mapSession(touched[0]);

    const raced = await db.select().from(assistantSessions)
      .where(and(...conditions)).limit(1);
    if (raced[0]) return mapSession(raced[0]);
  } else {
    const resumed = await db.update(assistantSessions).set({
      lastSeenAt: now,
      updatedAt: now,
    }).where(and(...conditions)).returning();
    if (resumed[0]) return mapSession(resumed[0]);
  }

  await db.update(assistantSessions).set({
    status: "expired",
    updatedAt: now,
  }).where(and(
    eq(assistantSessions.credentialHash, credentialHash),
    eq(assistantSessions.status, "active"),
    lte(assistantSessions.expiresAt, now),
  ));
  throw new UnauthorizedError("Assistant session is unavailable or expired.");
}

export async function revokeAssistantSession(
  db: Database,
  input: { sessionId: string; now?: Date },
): Promise<{ session: AssistantSessionView; changed: boolean }> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const now = d1Timestamp(input.now ?? new Date());
  const revoked = await db.update(assistantSessions).set({
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
  }).where(and(
    eq(assistantSessions.id, sessionId),
    eq(assistantSessions.status, "active"),
  )).returning();
  if (revoked[0]) return { session: mapSession(revoked[0]), changed: true };

  const existing = await selectSession(db, sessionId);
  if (!existing) throw new NotFoundError("Assistant session not found.");
  return { session: mapSession(existing), changed: false };
}

export async function createAssistantWorkflow(
  db: Database,
  input: {
    sessionId: string;
    clientRequestId: string;
    intent: string;
    riskClass: AssistantRiskClass;
    permissionSnapshotHash?: string | null;
    safePlan?: AssistantMessagePart[];
    parentWorkflowId?: string | null;
    now?: Date;
  },
): Promise<{ workflow: AssistantWorkflowView; replayed: boolean }> {
  const sessionId = requireOpaqueId(input.sessionId, "Session ID");
  const clientRequestId = requireOpaqueId(input.clientRequestId, "Workflow request ID");
  const intent = requireCapabilityId(input.intent, "Workflow intent");
  const riskClass = parseContract(
    () => assistantRiskClassSchema.parse(input.riskClass),
    "Workflow risk class is invalid.",
  );
  const permissionSnapshotHash = normalizePermissionSnapshotHash(
    input.permissionSnapshotHash ?? null,
  );
  const safePlanParts = parseContract(
    () => optionalPartsSchema.parse(input.safePlan ?? []),
    "Workflow plan contains unsupported display content.",
  );
  const safePlan = canonicalizeAssistantJson(safePlanParts);
  const parentWorkflowId = input.parentWorkflowId
    ? requireOpaqueId(input.parentWorkflowId, "Parent workflow ID")
    : null;
  const now = d1Timestamp(input.now ?? new Date());

  await loadActiveSession(db, sessionId, now);
  if (parentWorkflowId) {
    const parent = await selectWorkflow(db, parentWorkflowId);
    if (!parent || parent.sessionId !== sessionId) {
      throw new NotFoundError("Parent assistant workflow not found in this session.");
    }
  }

  const inserted = await db.insert(assistantWorkflows).values({
    id: createId("aw"),
    sessionId,
    clientRequestId,
    intent,
    status: "queued",
    riskClass,
    currentStep: 0,
    parentWorkflowId,
    permissionSnapshotHash,
    safePlan,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  if (inserted[0]) {
    return { workflow: mapWorkflow(inserted[0]), replayed: false };
  }

  const existing = await selectWorkflowByRequest(db, sessionId, clientRequestId);
  if (!existing) {
    throw new ServiceUnavailableError("Assistant workflow deduplication state is unavailable.");
  }
  if (
    existing.intent !== intent ||
    existing.riskClass !== riskClass ||
    existing.permissionSnapshotHash !== permissionSnapshotHash ||
    existing.parentWorkflowId !== parentWorkflowId ||
    existing.safePlan !== safePlan
  ) {
    throw new ConflictError(
      "This workflow request ID was already used for different assistant work.",
    );
  }
  return { workflow: mapWorkflow(existing), replayed: true };
}
