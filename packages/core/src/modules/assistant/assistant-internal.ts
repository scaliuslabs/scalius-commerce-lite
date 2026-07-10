import type { Database } from "@scalius/database/client";
import {
  assistantActionExecutions,
  assistantActions,
  assistantSessions,
  assistantWorkflows,
} from "@scalius/database/schema";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "@scalius/core/errors";
import {
  ASSISTANT_PROTOCOL_VERSION,
  assistantActionResultSchema,
  assistantMessagePartSchema,
  assistantPreparedActionSchema,
  assistantVersionPreconditionSchema,
  type AssistantActionResult,
  type AssistantActorType,
  type AssistantMessagePart,
  type AssistantPreparedAction,
  type AssistantSurface,
} from "@scalius/shared/assistant-contracts";
import { and, eq, lte, or } from "drizzle-orm";
import { z } from "zod/v4";

import { canonicalizeAssistantJson, constantTimeAssistantHashEqual } from "./assistant-crypto";
import type {
  AssistantAuthorizationAssertion,
  AssistantSessionView,
  AssistantWorkflowView,
} from "./assistant-types";

export const MAX_SAFE_METADATA_BYTES = 8 * 1024;
export const MAX_SAFE_ERROR_LENGTH = 1_000;
export const optionalPartsSchema = z.array(assistantMessagePartSchema).max(40);
export const partsSchema = z.array(assistantMessagePartSchema).min(1).max(40);

export type SessionRow = typeof assistantSessions.$inferSelect;
export type WorkflowRow = typeof assistantWorkflows.$inferSelect;
export type ActionRow = typeof assistantActions.$inferSelect;
export type ExecutionRow = typeof assistantActionExecutions.$inferSelect;

export interface ActionAuthority {
  action: ActionRow;
  workflow: WorkflowRow;
  session: SessionRow;
}

export async function loadActionAuthority(
  db: Database,
  actionId: string,
): Promise<ActionAuthority> {
  const action = await selectAction(db, requireOpaqueId(actionId, "Action ID"));
  if (!action) throw new NotFoundError("Assistant action not found.");
  const workflow = await selectWorkflow(db, action.workflowId);
  if (!workflow) throw new ServiceUnavailableError("Assistant action workflow is unavailable.");
  const session = await selectSession(db, workflow.sessionId);
  if (!session) throw new ServiceUnavailableError("Assistant action session is unavailable.");
  return { action, workflow, session };
}

export async function assertAuthoritySessionActive(
  db: Database,
  session: SessionRow,
  now: Date,
): Promise<void> {
  if (session.status === "active" && session.expiresAt > now) return;
  if (session.status === "active" && session.expiresAt <= now) {
    await db.update(assistantSessions).set({
      status: "expired",
      updatedAt: now,
    }).where(and(
      eq(assistantSessions.id, session.id),
      eq(assistantSessions.status, "active"),
      lte(assistantSessions.expiresAt, now),
    ));
  }
  throw new UnauthorizedError("Assistant session is unavailable or expired.");
}

export async function loadActiveSession(
  db: Database,
  sessionId: string,
  now: Date,
): Promise<SessionRow> {
  const session = await selectSession(db, sessionId);
  if (!session) throw new NotFoundError("Assistant session not found.");
  await assertAuthoritySessionActive(db, session, now);
  return session;
}

export async function ensureActionNotExpired(
  db: Database,
  action: ActionRow,
  now: Date,
): Promise<void> {
  if (action.status === "expired" || action.expiresAt <= now) {
    await expireActionIfNeeded(db, action.id, now);
    throw new ConflictError("Assistant action expired and must be prepared again.");
  }
}

export async function expireActionIfNeeded(
  db: Database,
  actionId: string,
  now: Date,
): Promise<void> {
  await db.update(assistantActions).set({
    status: "expired",
    approvalTokenHash: null,
    updatedAt: now,
  }).where(and(
    eq(assistantActions.id, actionId),
    or(
      eq(assistantActions.status, "prepared"),
      eq(assistantActions.status, "approval_required"),
      eq(assistantActions.status, "approved"),
    ),
    lte(assistantActions.expiresAt, now),
  ));
}

export function assertActionArgumentsHash(action: ActionRow, argumentsHash: string): void {
  if (!constantTimeAssistantHashEqual(action.argumentsHash, argumentsHash)) {
    throw new ConflictError("Assistant action arguments changed after preparation.");
  }
}

export function assertAuthorization(
  permission: string | null,
  storedSnapshotHash: string | null,
  assertion: AssistantAuthorizationAssertion | undefined,
): string | null {
  const assertedHash = normalizePermissionSnapshotHash(
    assertion?.permissionSnapshotHash ?? null,
  );
  if (permission && (!assertion?.granted || !assertedHash)) {
    throw new ForbiddenError(`Assistant command requires permission ${permission}.`);
  }
  if (storedSnapshotHash && assertedHash !== storedSnapshotHash) {
    throw new ForbiddenError("Assistant permissions changed; prepare the action again.");
  }
  return assertedHash;
}

export function mapSession(row: SessionRow): AssistantSessionView {
  return {
    id: row.id,
    surface: row.surface,
    actorType: row.actorType,
    actorId: row.actorId,
    conversationKey: row.conversationKey,
    status: row.status,
    permissionSnapshotHash: row.permissionSnapshotHash,
    safeMetadata: row.safeMetadata ? parseStoredJson(row.safeMetadata, "session metadata") : null,
    lastEventSequence: row.lastEventSequence,
    expiresAt: row.expiresAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
  };
}

export function mapWorkflow(row: WorkflowRow): AssistantWorkflowView {
  const safePlan = row.safePlan
    ? parseContract(
      () => optionalPartsSchema.parse(parseStoredJson(row.safePlan!, "workflow plan")),
      "Stored assistant workflow plan is unreadable.",
    )
    : [];
  return {
    id: row.id,
    sessionId: row.sessionId,
    clientRequestId: row.clientRequestId,
    intent: row.intent,
    status: row.status,
    riskClass: row.riskClass,
    currentStep: row.currentStep,
    permissionSnapshotHash: row.permissionSnapshotHash,
    safePlan,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function mapPreparedAction(
  row: ActionRow,
  sessionId: string,
): AssistantPreparedAction {
  return parseContract(
    () => assistantPreparedActionSchema.parse({
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      actionId: row.id,
      sessionId,
      workflowId: row.workflowId,
      capability: row.capability,
      argumentsHash: row.argumentsHash,
      permission: row.permission,
      riskClass: row.riskClass,
      confirmationPolicy: row.confirmationPolicy,
      status: row.status,
      expiresAt: row.expiresAt.getTime(),
      expectedVersions: parseStoredExpectedVersions(row.expectedVersions),
      affectedCount: row.affectedCount ?? undefined,
      monetaryValue: row.monetaryValue ?? undefined,
      currency: row.currency ?? undefined,
      parts: parseStoredParts(row.safeDisplay),
    }),
    "Stored assistant action is unreadable.",
  );
}

export function mapActionResult(row: ActionRow, replayed: boolean): AssistantActionResult {
  if (!isTerminalAction(row) || !row.executedAt || !row.safeResult) {
    throw new ServiceUnavailableError("Assistant action result is unavailable.");
  }
  const completedAt = row.executedAt.getTime();
  const parts = parseStoredParts(row.safeResult);
  return parseContract(
    () => assistantActionResultSchema.parse({
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      actionId: row.id,
      workflowId: row.workflowId,
      status: row.status,
      replayed,
      completedAt,
      parts,
    }),
    "Stored assistant action result is unreadable.",
  );
}

export function parseStoredExpectedVersions(value: string): unknown[] {
  return parseContract(
    () => z.array(assistantVersionPreconditionSchema).max(100).parse(
      parseStoredJson(value, "action version preconditions"),
    ),
    "Stored assistant version preconditions are unreadable.",
  );
}

export function parseStoredParts(value: string): AssistantMessagePart[] {
  return parseContract(
    () => partsSchema.parse(parseStoredJson(value, "action display")),
    "Stored assistant display content is unreadable.",
  );
}

export function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ServiceUnavailableError(`Stored assistant ${label} is unreadable.`);
  }
}

export async function selectSession(db: Database, id: string): Promise<SessionRow | undefined> {
  return db.select().from(assistantSessions).where(eq(assistantSessions.id, id)).get();
}

export async function selectSessionByConversationKey(
  db: Database,
  conversationKey: string,
): Promise<SessionRow | undefined> {
  return db.select().from(assistantSessions)
    .where(eq(assistantSessions.conversationKey, conversationKey))
    .get();
}

export async function selectSessionByAgentInstanceId(
  db: Database,
  agentInstanceId: string,
): Promise<SessionRow | undefined> {
  return db.select().from(assistantSessions)
    .where(eq(assistantSessions.agentInstanceId, agentInstanceId))
    .get();
}

export async function selectSessionByCredentialHash(
  db: Database,
  credentialHash: string,
): Promise<SessionRow | undefined> {
  return db.select().from(assistantSessions)
    .where(eq(assistantSessions.credentialHash, credentialHash))
    .get();
}

export async function selectWorkflow(db: Database, id: string): Promise<WorkflowRow | undefined> {
  return db.select().from(assistantWorkflows).where(eq(assistantWorkflows.id, id)).get();
}

export async function selectWorkflowByRequest(
  db: Database,
  sessionId: string,
  clientRequestId: string,
): Promise<WorkflowRow | undefined> {
  return db.select().from(assistantWorkflows).where(and(
    eq(assistantWorkflows.sessionId, sessionId),
    eq(assistantWorkflows.clientRequestId, clientRequestId),
  )).get();
}

export async function selectAction(db: Database, id: string): Promise<ActionRow | undefined> {
  return db.select().from(assistantActions).where(eq(assistantActions.id, id)).get();
}

export async function selectActionByPrepareRequest(
  db: Database,
  workflowId: string,
  prepareRequestId: string,
): Promise<ActionRow | undefined> {
  return db.select().from(assistantActions).where(and(
    eq(assistantActions.workflowId, workflowId),
    eq(assistantActions.prepareRequestId, prepareRequestId),
  )).get();
}

export async function selectExecution(db: Database, id: string): Promise<ExecutionRow | undefined> {
  return db.select().from(assistantActionExecutions)
    .where(eq(assistantActionExecutions.id, id))
    .get();
}

export async function selectExecutionByIdempotencyKey(
  db: Database,
  idempotencyKeyHash: string,
): Promise<ExecutionRow | undefined> {
  return db.select().from(assistantActionExecutions).where(eq(
    assistantActionExecutions.idempotencyKeyHash,
    idempotencyKeyHash,
  )).get();
}

export async function selectExecutionByActionRequest(
  db: Database,
  actionId: string,
  clientRequestId: string,
): Promise<ExecutionRow | undefined> {
  return db.select().from(assistantActionExecutions).where(and(
    eq(assistantActionExecutions.actionId, actionId),
    eq(assistantActionExecutions.clientRequestId, clientRequestId),
  )).get();
}

export function isTerminalAction(
  action: ActionRow,
): action is ActionRow & { status: "succeeded" | "failed" } {
  return action.status === "succeeded" || action.status === "failed";
}

export function assertActorMatchesSurface(
  surface: AssistantSurface,
  actorType: AssistantActorType,
): void {
  const allowed = surface === "admin"
    ? actorType === "admin" || actorType === "system"
    : actorType === "customer" || actorType === "guest" || actorType === "system";
  if (!allowed) throw new ValidationError("Assistant actor type is invalid for this surface.");
}

export function normalizeActorId(
  actorId: string | null | undefined,
  actorType: AssistantActorType,
): string | null {
  if (actorType === "guest") {
    return actorId ? requireOpaqueId(actorId, "Guest actor ID") : null;
  }
  if (!actorId) throw new ValidationError("Assistant actor ID is required.");
  return requireOpaqueId(actorId, "Assistant actor ID");
}

export function normalizePermissionSnapshotHash(value: string | null): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ValidationError("Permission snapshot hash is malformed.");
  }
  return normalized;
}

export function normalizeCurrency(
  value: string | undefined,
  monetaryValue: number | null,
): string | null {
  if (value == null) {
    if (monetaryValue != null) {
      throw new ValidationError("Currency is required when an action has monetary value.");
    }
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new ValidationError("Currency is malformed.");
  return normalized;
}

export function normalizeSafeError(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SAFE_ERROR_LENGTH) {
    throw new ValidationError(
      `Assistant safe error must contain between 1 and ${MAX_SAFE_ERROR_LENGTH} characters.`,
    );
  }
  return normalized;
}

export function requireOpaqueId(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)
  ) {
    throw new ValidationError(`${label} is malformed.`);
  }
  return normalized;
}

export function requireCapabilityId(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 160 ||
    !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(normalized)
  ) {
    throw new ValidationError(`${label} is malformed.`);
  }
  return normalized;
}

export function boundedSeconds(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(`${label} must be between ${minimum} and ${maximum} seconds.`);
  }
  return value;
}

export function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ValidationError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export function boundedNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new ValidationError(`${label} must be a bounded non-negative integer.`);
  }
  return value;
}

export function optionalNonnegativeInteger(
  value: number | undefined,
  label: string,
): number | null {
  return value == null ? null : boundedNonnegativeInteger(value, label);
}

export function optionalNonnegativeNumber(
  value: number | undefined,
  label: string,
): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(`${label} must be a bounded non-negative number.`);
  }
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createId(prefix: "as" | "aw" | "aa" | "aal" | "aae" | "aev"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

export function d1Timestamp(date: Date): Date {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new ValidationError("Assistant timestamp is invalid.");
  return new Date(Math.floor(milliseconds / 1_000) * 1_000);
}

export function minDate(left: Date, right: Date): Date {
  return left <= right ? left : right;
}

export function parseContract<T>(parser: () => T, message: string): T {
  try {
    return parser();
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ConflictError ||
      error instanceof ForbiddenError ||
      error instanceof ServiceUnavailableError
    ) {
      throw error;
    }
    throw new ValidationError(message);
  }
}

export function canonicalDisplaySemantics(parts: AssistantMessagePart[]): string {
  return canonicalizeAssistantJson(parts.map((part) => {
    if (part.type !== "confirmation") return part;
    const { actionId: _actionId, expiresAt: _expiresAt, ...semantic } = part;
    return semantic;
  }));
}
