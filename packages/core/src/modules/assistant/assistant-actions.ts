import { safeBatch, type Database } from "@scalius/database/client";
import { assistantActions, assistantWorkflows } from "@scalius/database/schema";
import { ConflictError, ForbiddenError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import {
  ASSISTANT_PROTOCOL_VERSION,
  assistantApprovalReceiptSchema,
  assistantCommandDescriptorSchema,
  assistantConfirmRequestSchema,
  assistantMessagePartSchema,
  assistantPrepareRequestSchema,
  isTerminalAssistantWorkflowStatus,
  type AssistantApprovalReceipt,
  type AssistantCommandDescriptor,
  type AssistantMessagePart,
  type AssistantPreparedAction,
  type AssistantRiskClass,
} from "@scalius/shared/assistant-contracts";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
  canonicalizeAssistantJson,
  constantTimeAssistantHashEqual,
  createAssistantApprovalCredential,
  encryptAssistantArguments,
  hashAssistantApprovalCredential,
  hashAssistantArguments,
} from "./assistant-crypto";
import {
  addSeconds,
  assertAuthorization,
  boundedNonnegativeInteger,
  boundedSeconds,
  canonicalDisplaySemantics,
  createId,
  d1Timestamp,
  ensureActionNotExpired,
  isPlainRecord,
  loadActionAuthority,
  loadActiveSession,
  mapPreparedAction,
  minDate,
  normalizeCurrency,
  optionalNonnegativeInteger,
  optionalNonnegativeNumber,
  parseContract,
  parseStoredParts,
  requireOpaqueId,
  selectAction,
  selectActionByPrepareRequest,
  selectWorkflow,
  type ActionRow,
  type SessionRow,
} from "./assistant-internal";
import type {
  AssistantArgumentsParser,
  AssistantAuthorizationAssertion,
  AssistantConfirmationDisplay,
} from "./assistant-types";

const DEFAULT_ACTION_TTL_SECONDS = 15 * 60;
const MAX_ACTION_TTL_SECONDS = 60 * 60;
const DEFAULT_APPROVAL_TTL_SECONDS = 10 * 60;
const MAX_APPROVAL_TTL_SECONDS = 15 * 60;
const MAX_STEP_UP_AGE_SECONDS = 5 * 60;

const confirmationDisplaySchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(1_000),
  consequences: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  confirmLabel: z.string().trim().min(1).max(80),
}).strict();

export async function prepareAssistantAction<TArguments extends Record<string, unknown>>(
  db: Database,
  input: {
    request: unknown;
    descriptor: unknown;
    argumentsSchema: AssistantArgumentsParser<TArguments>;
    argumentEncryptionKey: string;
    authorization?: AssistantAuthorizationAssertion;
    displayParts: AssistantMessagePart[];
    confirmation?: AssistantConfirmationDisplay;
    stepIndex?: number;
    affectedCount?: number;
    monetaryValue?: number;
    currency?: string;
    actionTtlSeconds?: number;
    now?: Date;
  },
): Promise<{ action: AssistantPreparedAction; replayed: boolean }> {
  const request = parseContract(
    () => assistantPrepareRequestSchema.parse(input.request),
    "Assistant prepare request is invalid.",
  );
  const descriptor = parseContract(
    () => assistantCommandDescriptorSchema.parse(input.descriptor),
    "Assistant command descriptor is invalid.",
  );
  assertDescriptorRiskPolicy(descriptor);
  if (!request.workflowId) {
    throw new ValidationError("Assistant actions require a durable workflow ID.");
  }
  if (request.capability !== descriptor.id) {
    throw new ValidationError("Assistant capability does not match its command descriptor.");
  }

  const now = d1Timestamp(input.now ?? new Date());
  const workflow = await selectWorkflow(db, request.workflowId);
  if (!workflow || workflow.sessionId !== request.sessionId) {
    throw new ConflictError("Assistant workflow was not found in this session.");
  }
  if (isTerminalAssistantWorkflowStatus(workflow.status)) {
    throw new ConflictError("Assistant workflow is already complete.");
  }
  const session = await loadActiveSession(db, workflow.sessionId, now);
  if (session.surface !== descriptor.surface) {
    throw new ForbiddenError("Assistant command is not available on this surface.");
  }

  const permissionSnapshotHash = assertAuthorization(
    descriptor.permission,
    workflow.permissionSnapshotHash,
    input.authorization,
  );
  const validatedArguments = parseContract(
    () => input.argumentsSchema.parse(request.arguments),
    "Assistant command arguments are invalid.",
  );
  if (!isPlainRecord(validatedArguments)) {
    throw new ValidationError("Assistant command arguments must be a JSON object.");
  }

  const canonicalArguments = canonicalizeAssistantJson(validatedArguments);
  const argumentsHash = await hashAssistantArguments(validatedArguments);
  const actionId = createId("aa");
  const ttlSeconds = boundedSeconds(
    input.actionTtlSeconds ?? DEFAULT_ACTION_TTL_SECONDS,
    30,
    MAX_ACTION_TTL_SECONDS,
    "Action TTL",
  );
  const expiresAt = addSeconds(now, ttlSeconds);
  const displayParts = buildPreparedDisplayParts(
    input.displayParts,
    input.confirmation,
    descriptor,
    actionId,
    expiresAt,
  );
  const safeDisplay = canonicalizeAssistantJson(displayParts);
  const displaySemantics = canonicalDisplaySemantics(displayParts);
  const expectedVersions = canonicalizeAssistantJson(request.expectedVersions);
  const encryptedArguments = await encryptAssistantArguments(
    canonicalArguments,
    input.argumentEncryptionKey,
    { actionId, argumentsHash },
  );
  const stepIndex = boundedNonnegativeInteger(input.stepIndex ?? workflow.currentStep, "Step index");
  const affectedCount = optionalNonnegativeInteger(input.affectedCount, "Affected count");
  const monetaryValue = optionalNonnegativeNumber(input.monetaryValue, "Monetary value");
  const currency = normalizeCurrency(input.currency, monetaryValue);
  const status = descriptor.confirmationPolicy === "none"
    ? "prepared" as const
    : "approval_required" as const;

  const inserted = await db.insert(assistantActions).values({
    id: actionId,
    workflowId: workflow.id,
    prepareRequestId: request.clientRequestId,
    stepIndex,
    capability: descriptor.id,
    permission: descriptor.permission,
    riskClass: descriptor.riskClass,
    confirmationPolicy: descriptor.confirmationPolicy,
    status,
    argumentsHash,
    encryptedArguments,
    expectedVersions,
    safeDisplay,
    permissionSnapshotHash,
    affectedCount,
    monetaryValue,
    currency,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();

  let action: ActionRow;
  let replayed = false;
  if (inserted[0]) {
    action = inserted[0];
  } else {
    replayed = true;
    const existing = await selectActionByPrepareRequest(
      db,
      workflow.id,
      request.clientRequestId,
    );
    if (!existing) {
      throw new ServiceUnavailableError("Assistant action deduplication state is unavailable.");
    }
    assertSamePreparedAction(existing, {
      capability: descriptor.id,
      argumentsHash,
      expectedVersions,
      permissionSnapshotHash,
      permission: descriptor.permission,
      riskClass: descriptor.riskClass,
      confirmationPolicy: descriptor.confirmationPolicy,
      stepIndex,
      affectedCount,
      monetaryValue,
      currency,
      displaySemantics,
      ttlSeconds,
    });
    action = existing;
  }

  await db.update(assistantWorkflows).set({
    status: status === "approval_required" ? "approval_required" : "running",
    riskClass: descriptor.riskClass,
    currentStep: stepIndex,
    startedAt: workflow.startedAt ?? now,
    updatedAt: now,
  }).where(and(
    eq(assistantWorkflows.id, workflow.id),
    eq(assistantWorkflows.sessionId, session.id),
  ));
  return { action: mapPreparedAction(action, session.id), replayed };
}

export async function approveAssistantAction(
  db: Database,
  input: {
    request: unknown;
    approvedBy: string;
    approvalCredentialKey: string;
    authorization?: AssistantAuthorizationAssertion;
    stepUp?: { actorId: string; verifiedAt: Date };
    approvalTtlSeconds?: number;
    now?: Date;
  },
): Promise<AssistantApprovalReceipt> {
  const request = parseContract(
    () => assistantConfirmRequestSchema.parse(input.request),
    "Assistant approval request is invalid.",
  );
  const approvedBy = requireOpaqueId(input.approvedBy, "Approving actor ID");
  const now = d1Timestamp(input.now ?? new Date());
  const authority = await loadActionAuthority(db, request.actionId);
  if (isTerminalAssistantWorkflowStatus(authority.workflow.status)) {
    throw new ConflictError("Assistant workflow is already complete.");
  }
  await ensureActionNotExpired(db, authority.action, now);
  await loadActiveSession(db, authority.session.id, now);
  if (!constantTimeAssistantHashEqual(authority.action.argumentsHash, request.argumentsHash)) {
    throw new ConflictError("Assistant action arguments changed after preparation.");
  }
  assertAuthorization(
    authority.action.permission,
    authority.action.permissionSnapshotHash,
    input.authorization,
  );
  assertApprovingActor(authority.session, approvedBy);

  if (authority.action.confirmationPolicy === "none") {
    throw new ConflictError("This assistant action does not require approval.");
  }
  if (authority.action.confirmationPolicy === "step_up") {
    assertFreshStepUp(input.stepUp, approvedBy, now);
  }
  if (authority.action.status === "approved") {
    await reconcileApprovedWorkflow(db, authority.workflow.id, authority.action.id, now);
    return buildApprovalReceipt(
      authority.action,
      approvedBy,
      input.approvalCredentialKey,
      now,
    );
  }
  if (authority.action.status !== "approval_required") {
    throw new ConflictError("Assistant action is not awaiting approval.");
  }

  const ttlSeconds = boundedSeconds(
    input.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS,
    30,
    MAX_APPROVAL_TTL_SECONDS,
    "Approval TTL",
  );
  const approvalExpiresAt = minDate(
    authority.action.expiresAt,
    addSeconds(now, ttlSeconds),
  );
  const approvalToken = await createAssistantApprovalCredential(
    input.approvalCredentialKey,
    {
      actionId: authority.action.id,
      argumentsHash: authority.action.argumentsHash,
      approvedBy,
      approvedAt: now,
      expiresAt: approvalExpiresAt,
    },
  );
  const approvalTokenHash = await hashAssistantApprovalCredential(approvalToken);
  const permissionCondition = authority.action.permissionSnapshotHash
    ? eq(assistantActions.permissionSnapshotHash, authority.action.permissionSnapshotHash)
    : isNull(assistantActions.permissionSnapshotHash);

  const [approved, runningWorkflows] = await safeBatch(db, [
    db.update(assistantActions).set({
      status: "approved",
      approvalTokenHash,
      approvedBy,
      approvedAt: now,
      approvalExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(assistantActions.id, authority.action.id),
      eq(assistantActions.status, "approval_required"),
      eq(assistantActions.argumentsHash, authority.action.argumentsHash),
      permissionCondition,
      gt(assistantActions.expiresAt, now),
      isNull(assistantActions.approvalTokenHash),
      sql`EXISTS (
        SELECT 1 FROM ${assistantWorkflows}
        WHERE ${assistantWorkflows.id} = ${authority.workflow.id}
          AND ${assistantWorkflows.status} IN ('approval_required', 'running')
      )`,
    )).returning({ id: assistantActions.id }),
    db.update(assistantWorkflows).set({ status: "running", updatedAt: now })
      .where(and(
        eq(assistantWorkflows.id, authority.workflow.id),
        sql`${assistantWorkflows.status} IN ('approval_required', 'running')`,
        sql`EXISTS (
          SELECT 1 FROM ${assistantActions}
          WHERE ${assistantActions.id} = ${authority.action.id}
            AND ${assistantActions.status} = 'approved'
            AND ${assistantActions.approvalTokenHash} = ${approvalTokenHash}
        )`,
      ))
      .returning({ id: assistantWorkflows.id }),
  ] as const);

  if (!approved[0]) {
    const latest = await selectAction(db, authority.action.id);
    if (latest?.status === "approved") {
      await reconcileApprovedWorkflow(db, authority.workflow.id, latest.id, now);
      return buildApprovalReceipt(latest, approvedBy, input.approvalCredentialKey, now);
    }
    throw new ConflictError(
      "Assistant action approval changed before it could be recorded. Refresh and review it again.",
    );
  }
  if (!runningWorkflows[0]) {
    throw new ServiceUnavailableError("Assistant approval workflow transition was not committed.");
  }
  return assistantApprovalReceiptSchema.parse({
    protocolVersion: ASSISTANT_PROTOCOL_VERSION,
    actionId: authority.action.id,
    approvalToken,
    approvedAt: now.getTime(),
    expiresAt: approvalExpiresAt.getTime(),
  });
}

async function reconcileApprovedWorkflow(
  db: Database,
  workflowId: string,
  actionId: string,
  now: Date,
): Promise<void> {
  await db.update(assistantWorkflows).set({ status: "running", updatedAt: now })
    .where(and(
      eq(assistantWorkflows.id, workflowId),
      sql`${assistantWorkflows.status} IN ('approval_required', 'running')`,
      sql`EXISTS (
        SELECT 1 FROM ${assistantActions}
        WHERE ${assistantActions.id} = ${actionId}
          AND ${assistantActions.status} = 'approved'
      )`,
    ));
}

async function buildApprovalReceipt(
  action: ActionRow,
  approvedBy: string,
  approvalCredentialKey: string,
  now: Date,
): Promise<AssistantApprovalReceipt> {
  if (
    action.status !== "approved" ||
    action.approvedBy !== approvedBy ||
    !action.approvedAt ||
    !action.approvalExpiresAt ||
    action.approvalExpiresAt <= now ||
    !action.approvalTokenHash
  ) {
    throw new ConflictError("Assistant approval receipt is unavailable or expired.");
  }
  const approvedAt = action.approvedAt;
  const expiresAt = action.approvalExpiresAt;
  const approvalToken = await createAssistantApprovalCredential(
    approvalCredentialKey,
    {
      actionId: action.id,
      argumentsHash: action.argumentsHash,
      approvedBy,
      approvedAt,
      expiresAt,
    },
  );
  const approvalTokenHash = await hashAssistantApprovalCredential(approvalToken);
  if (!constantTimeAssistantHashEqual(approvalTokenHash, action.approvalTokenHash)) {
    throw new ServiceUnavailableError("Assistant approval receipt failed integrity validation.");
  }
  return assistantApprovalReceiptSchema.parse({
    protocolVersion: ASSISTANT_PROTOCOL_VERSION,
    actionId: action.id,
    approvalToken,
    approvedAt: approvedAt.getTime(),
    expiresAt: expiresAt.getTime(),
  });
}

function assertDescriptorRiskPolicy(descriptor: AssistantCommandDescriptor): void {
  if (!descriptor.readOnly && descriptor.riskClass === "read_only") {
    throw new ValidationError("Mutating assistant commands cannot use the read-only risk class.");
  }
  if (descriptor.riskClass === "high_risk" && descriptor.confirmationPolicy !== "step_up") {
    throw new ValidationError("High-risk assistant commands require step-up confirmation.");
  }
  if (
    descriptor.riskClass === "consequential" &&
    descriptor.confirmationPolicy !== "explicit" &&
    descriptor.confirmationPolicy !== "step_up"
  ) {
    throw new ValidationError(
      "Consequential assistant commands require explicit or step-up confirmation.",
    );
  }
  if (descriptor.riskClass === "reversible" && descriptor.confirmationPolicy === "none") {
    throw new ValidationError("Persistent reversible assistant commands require confirmation.");
  }
}

function buildPreparedDisplayParts(
  rawParts: AssistantMessagePart[],
  rawConfirmation: AssistantConfirmationDisplay | undefined,
  descriptor: AssistantCommandDescriptor,
  actionId: string,
  expiresAt: Date,
): AssistantMessagePart[] {
  const maxBaseParts = descriptor.confirmationPolicy === "none" ? 40 : 39;
  const baseParts = parseContract(
    () => z.array(assistantMessagePartSchema).min(1).max(maxBaseParts).parse(rawParts),
    "Assistant action display contains unsupported content.",
  );
  if (baseParts.some((part) => part.type === "confirmation")) {
    throw new ValidationError("Assistant confirmation display is created by the authority service.");
  }
  if (descriptor.confirmationPolicy === "none") {
    if (rawConfirmation) {
      throw new ValidationError("Read-only assistant actions cannot include confirmation display.");
    }
    return baseParts;
  }

  const confirmation = parseContract(
    () => confirmationDisplaySchema.parse(rawConfirmation),
    "Assistant confirmation display is required and must be safe.",
  );
  const confirmationPart = assistantMessagePartSchema.parse({
    type: "confirmation",
    actionId,
    title: confirmation.title,
    summary: confirmation.summary,
    riskClass: descriptor.riskClass,
    consequences: confirmation.consequences,
    confirmLabel: confirmation.confirmLabel,
    expiresAt: expiresAt.getTime(),
  });
  return [...baseParts, confirmationPart];
}

function assertSamePreparedAction(
  existing: ActionRow,
  expected: {
    capability: string;
    argumentsHash: string;
    expectedVersions: string;
    permissionSnapshotHash: string | null;
    permission: string | null;
    riskClass: AssistantRiskClass;
    confirmationPolicy: AssistantCommandDescriptor["confirmationPolicy"];
    stepIndex: number;
    affectedCount: number | null;
    monetaryValue: number | null;
    currency: string | null;
    displaySemantics: string;
    ttlSeconds: number;
  },
): void {
  const existingDisplay = parseStoredParts(existing.safeDisplay);
  if (
    existing.capability !== expected.capability ||
    existing.argumentsHash !== expected.argumentsHash ||
    existing.expectedVersions !== expected.expectedVersions ||
    existing.permissionSnapshotHash !== expected.permissionSnapshotHash ||
    existing.permission !== expected.permission ||
    existing.riskClass !== expected.riskClass ||
    existing.confirmationPolicy !== expected.confirmationPolicy ||
    existing.stepIndex !== expected.stepIndex ||
    existing.affectedCount !== expected.affectedCount ||
    existing.monetaryValue !== expected.monetaryValue ||
    existing.currency !== expected.currency ||
    Math.round((existing.expiresAt.getTime() - existing.createdAt.getTime()) / 1_000) !==
      expected.ttlSeconds ||
    canonicalDisplaySemantics(existingDisplay) !== expected.displaySemantics
  ) {
    throw new ConflictError(
      "This prepare request ID was already used for a different assistant action.",
    );
  }
}

function assertFreshStepUp(
  stepUp: { actorId: string; verifiedAt: Date } | undefined,
  approvedBy: string,
  now: Date,
): void {
  if (!stepUp || requireOpaqueId(stepUp.actorId, "Step-up actor ID") !== approvedBy) {
    throw new ForbiddenError("This assistant action requires fresh step-up verification.");
  }
  const ageSeconds = (now.getTime() - stepUp.verifiedAt.getTime()) / 1_000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < -30 || ageSeconds > MAX_STEP_UP_AGE_SECONDS) {
    throw new ForbiddenError("Assistant step-up verification is missing or stale.");
  }
}

function assertApprovingActor(session: SessionRow, approvedBy: string): void {
  if (session.actorType !== "system" && session.actorId !== approvedBy) {
    throw new ForbiddenError("Assistant approval actor does not own this session.");
  }
}
