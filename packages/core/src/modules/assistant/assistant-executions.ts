import { safeBatch, type Database } from "@scalius/database/client";
import { assistantActionExecutions, assistantActions, assistantWorkflows } from "@scalius/database/schema";
import { ConflictError, ForbiddenError, ServiceUnavailableError } from "@scalius/core/errors";
import {
  assistantExecuteRequestSchema,
  type AssistantActionResult,
  type AssistantMessagePart,
} from "@scalius/shared/assistant-contracts";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import {
  canonicalizeAssistantJson,
  constantTimeAssistantHashEqual,
  decryptAssistantArguments,
  hashAssistantApprovalCredential,
  hashAssistantExecutionIdempotencyKey,
  sha256Hex,
} from "./assistant-crypto";
import {
  addSeconds,
  assertActionArgumentsHash,
  assertAuthoritySessionActive,
  assertAuthorization,
  boundedSeconds,
  createId,
  d1Timestamp,
  ensureActionNotExpired,
  isPlainRecord,
  isTerminalAction,
  loadActionAuthority,
  mapActionResult,
  normalizeSafeError,
  parseContract,
  parseStoredExpectedVersions,
  partsSchema,
  requireCapabilityId,
  requireOpaqueId,
  selectAction,
  selectExecution,
  selectExecutionByActionRequest,
  selectExecutionByIdempotencyKey,
  type ActionAuthority,
  type ActionRow,
  type ExecutionRow,
} from "./assistant-internal";
import type {
  AssistantArgumentsParser,
  AssistantAuthorizationAssertion,
  ClaimedAssistantExecution,
  ClaimAssistantExecutionResult,
} from "./assistant-types";

const DEFAULT_EXECUTION_LEASE_SECONDS = 2 * 60;
const MAX_EXECUTION_LEASE_SECONDS = 10 * 60;

export async function claimAssistantActionExecution<
  TArguments extends Record<string, unknown>,
>(
  db: Database,
  input: {
    request: unknown;
    argumentsSchema: AssistantArgumentsParser<TArguments>;
    argumentEncryptionKey: string;
    executorId: string;
    authorization?: AssistantAuthorizationAssertion;
    leaseSeconds?: number;
    now?: Date;
  },
): Promise<ClaimAssistantExecutionResult<TArguments>> {
  const request = parseContract(
    () => assistantExecuteRequestSchema.parse(input.request),
    "Assistant execution request is invalid.",
  );
  const executorId = requireOpaqueId(input.executorId, "Assistant executor ID");
  const now = d1Timestamp(input.now ?? new Date());
  const leaseSeconds = boundedSeconds(
    input.leaseSeconds ?? DEFAULT_EXECUTION_LEASE_SECONDS,
    15,
    MAX_EXECUTION_LEASE_SECONDS,
    "Execution lease",
  );
  const idempotencyKeyHash = await hashAssistantExecutionIdempotencyKey(
    request.actionId,
    request.idempotencyKey,
  );
  const authority = await loadActionAuthority(db, request.actionId);
  await assertAuthoritySessionActive(db, authority.session, now);
  assertActionArgumentsHash(authority.action, request.argumentsHash);
  assertAuthorization(
    authority.action.permission,
    authority.action.permissionSnapshotHash,
    input.authorization,
  );
  if (authority.workflow.status === "succeeded" || authority.workflow.status === "failed" || authority.workflow.status === "cancelled") {
    if (isTerminalAction(authority.action)) {
      return { status: "replay", result: mapActionResult(authority.action, true) };
    }
    throw new ConflictError("Assistant workflow is already complete.");
  }

  const existingExecution = await selectExecutionByIdempotencyKey(db, idempotencyKeyHash);
  if (existingExecution) {
    if (existingExecution.actionId !== authority.action.id) {
      throw new ConflictError("Assistant idempotency key belongs to another action.");
    }
    return resolveExistingExecution(db, {
      authority,
      execution: existingExecution,
      argumentsSchema: input.argumentsSchema,
      argumentEncryptionKey: input.argumentEncryptionKey,
      executorId,
      leaseSeconds,
      now,
    });
  }

  const requestCollision = await selectExecutionByActionRequest(
    db,
    authority.action.id,
    request.clientRequestId,
  );
  if (requestCollision) {
    throw new ConflictError(
      "This execution request ID was already used with a different idempotency key.",
    );
  }
  if (isTerminalAction(authority.action)) {
    return { status: "replay", result: mapActionResult(authority.action, true) };
  }
  await ensureActionNotExpired(db, authority.action, now);

  const approvalTokenHash = await validateExecutionApproval(
    authority.action,
    request.approvalToken,
    now,
  );
  const argumentsValue = await decryptAndValidateActionArguments(
    authority.action,
    input.argumentEncryptionKey,
    input.argumentsSchema,
  );
  const priorStatus = authority.action.confirmationPolicy === "none"
    ? "prepared" as const
    : "approved" as const;
  const leaseId = createId("aal");
  const leaseExpiresAt = addSeconds(now, leaseSeconds);
  const permissionCondition = authority.action.permissionSnapshotHash
    ? eq(assistantActions.permissionSnapshotHash, authority.action.permissionSnapshotHash)
    : isNull(assistantActions.permissionSnapshotHash);
  const approvalConditions = authority.action.confirmationPolicy === "none"
    ? [isNull(assistantActions.approvalTokenHash)]
    : [
      eq(assistantActions.approvalTokenHash, approvalTokenHash!),
      gt(assistantActions.approvalExpiresAt, now),
    ];

  const executionId = createId("aae");
  let transition: Awaited<ReturnType<typeof runClaimTransition>>;
  try {
    transition = await runClaimTransition(db, {
      actionId: authority.action.id,
      workflowId: authority.workflow.id,
      clientRequestId: request.clientRequestId,
      idempotencyKeyHash,
      executionId,
      executorId,
      leaseId,
      leaseExpiresAt,
      now,
      priorStatus,
      argumentsHash: authority.action.argumentsHash,
      permissionCondition,
      approvalConditions,
    });
  } catch (error) {
    if (!isExecutionClaimConflict(error)) throw error;
    const winner = await selectExecutionByIdempotencyKey(db, idempotencyKeyHash) ??
      await selectExecutionByActionRequest(db, authority.action.id, request.clientRequestId);
    if (!winner) throw error;
    return resolveExistingExecution(db, {
      authority: {
        ...authority,
        action: (await selectAction(db, authority.action.id)) ?? authority.action,
      },
      execution: winner,
      argumentsSchema: input.argumentsSchema,
      argumentEncryptionKey: input.argumentEncryptionKey,
      executorId,
      leaseSeconds,
      now,
    });
  }

  if (!transition.claimedAction[0]) {
    const latest = await selectAction(db, authority.action.id);
    if (latest && isTerminalAction(latest)) {
      return { status: "replay", result: mapActionResult(latest, true) };
    }
    if (latest?.status === "executing" && latest.executionLeaseExpiresAt) {
      return {
        status: "processing",
        actionId: latest.id,
        workflowId: latest.workflowId,
        leaseExpiresAt: latest.executionLeaseExpiresAt.getTime(),
      };
    }
    throw new ConflictError("Assistant action could not be claimed in its current state.");
  }
  if (!transition.insertedExecution[0] || !transition.runningWorkflow[0]) {
    throw new ServiceUnavailableError("Assistant execution claim transition was not committed.");
  }
  return {
    status: "claimed",
    claim: buildExecutionClaim({
      authority,
      executionId,
      leaseId,
      executorId,
      leaseExpiresAt,
      argumentsValue,
    }),
  };
}

async function runClaimTransition(
  db: Database,
  input: {
    actionId: string;
    workflowId: string;
    clientRequestId: string;
    idempotencyKeyHash: string;
    executionId: string;
    executorId: string;
    leaseId: string;
    leaseExpiresAt: Date;
    now: Date;
    priorStatus: "prepared" | "approved";
    argumentsHash: string;
    permissionCondition: ReturnType<typeof eq> | ReturnType<typeof isNull>;
    approvalConditions: Array<ReturnType<typeof eq> | ReturnType<typeof gt> | ReturnType<typeof isNull>>;
  },
) {
  const unixNow = Math.floor(input.now.getTime() / 1_000);
  const [claimedAction, insertedExecution, runningWorkflow] = await safeBatch(db, [
    db.update(assistantActions).set({
      status: "executing",
      executionLeaseId: input.leaseId,
      executionLeaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now,
    }).where(and(
      eq(assistantActions.id, input.actionId),
      eq(assistantActions.status, input.priorStatus),
      eq(assistantActions.argumentsHash, input.argumentsHash),
      input.permissionCondition,
      gt(assistantActions.expiresAt, input.now),
      ...input.approvalConditions,
      sql`EXISTS (
        SELECT 1 FROM ${assistantWorkflows}
        WHERE ${assistantWorkflows.id} = ${input.workflowId}
          AND ${assistantWorkflows.status} NOT IN ('succeeded', 'failed', 'cancelled')
      )`,
    )).returning({ id: assistantActions.id }),
    db.insert(assistantActionExecutions).select(sql`
      SELECT
        ${input.executionId},
        ${input.actionId},
        ${input.clientRequestId},
        ${input.idempotencyKeyHash},
        1,
        'claimed',
        ${input.executorId},
        ${unixNow},
        NULL,
        ${unixNow}
      WHERE EXISTS (
        SELECT 1 FROM ${assistantActions}
        WHERE ${assistantActions.id} = ${input.actionId}
          AND ${assistantActions.status} = 'executing'
          AND ${assistantActions.executionLeaseId} = ${input.leaseId}
      )
    `).returning({ id: assistantActionExecutions.id }),
    db.update(assistantWorkflows).set({ status: "running", updatedAt: input.now })
      .where(and(
        eq(assistantWorkflows.id, input.workflowId),
        sql`${assistantWorkflows.status} NOT IN ('succeeded', 'failed', 'cancelled')`,
        sql`EXISTS (
          SELECT 1 FROM ${assistantActions}
          WHERE ${assistantActions.id} = ${input.actionId}
            AND ${assistantActions.status} = 'executing'
            AND ${assistantActions.executionLeaseId} = ${input.leaseId}
        )`,
      ))
      .returning({ id: assistantWorkflows.id }),
  ] as const);
  return { claimedAction, insertedExecution, runningWorkflow };
}

export async function completeAssistantActionExecution(
  db: Database,
  input: {
    actionId: string;
    executionId: string;
    leaseId: string;
    executorId: string;
    parts: AssistantMessagePart[];
    workflowStatus: "running" | "succeeded";
    now?: Date;
  },
): Promise<AssistantActionResult> {
  return finalizeAssistantActionExecution(db, {
    ...input,
    status: "succeeded",
    errorCode: null,
    safeError: null,
    now: d1Timestamp(input.now ?? new Date()),
  });
}

export async function failAssistantActionExecution(
  db: Database,
  input: {
    actionId: string;
    executionId: string;
    leaseId: string;
    executorId: string;
    errorCode: string;
    safeError: string;
    parts?: AssistantMessagePart[];
    workflowStatus: "failed";
    now?: Date;
  },
): Promise<AssistantActionResult> {
  const errorCode = requireCapabilityId(input.errorCode, "Assistant error code");
  const safeError = normalizeSafeError(input.safeError);
  return finalizeAssistantActionExecution(db, {
    ...input,
    status: "failed",
    parts: input.parts ?? [{
      type: "error",
      code: errorCode,
      message: safeError,
      retryable: false,
    }],
    errorCode,
    safeError,
    now: d1Timestamp(input.now ?? new Date()),
  });
}

async function finalizeAssistantActionExecution(
  db: Database,
  input: {
    actionId: string;
    executionId: string;
    leaseId: string;
    executorId: string;
    status: "succeeded" | "failed";
    parts: AssistantMessagePart[];
    errorCode: string | null;
    safeError: string | null;
    workflowStatus: "running" | "succeeded" | "failed";
    now: Date;
  },
): Promise<AssistantActionResult> {
  const actionId = requireOpaqueId(input.actionId, "Action ID");
  const executionId = requireOpaqueId(input.executionId, "Execution ID");
  const leaseId = requireOpaqueId(input.leaseId, "Execution lease ID");
  const executorId = requireOpaqueId(input.executorId, "Assistant executor ID");
  const parts = parseContract(
    () => partsSchema.parse(input.parts),
    "Assistant action result contains unsupported display content.",
  );
  const safeResult = canonicalizeAssistantJson(parts);
  const authority = await loadActionAuthority(db, actionId);
  const execution = await selectExecution(db, executionId);
  if (!execution || execution.actionId !== actionId || execution.executorId !== executorId) {
    throw new ConflictError("Assistant execution claim does not match this action.");
  }

  if (isTerminalAction(authority.action)) {
    if (
      authority.action.status !== input.status ||
      authority.action.safeResult !== safeResult ||
      authority.action.errorCode !== input.errorCode ||
      authority.action.safeError !== input.safeError
    ) {
      throw new ConflictError("Assistant action already has a different terminal result.");
    }
    if (
      execution.status !== input.status ||
      !isWorkflowCompletionVisible(
        authority.workflow,
        input.workflowStatus,
        authority.action.stepIndex + 1,
      )
    ) {
      throw new ServiceUnavailableError(
        "Assistant terminal transition is incomplete and requires reconciliation.",
      );
    }
    return mapActionResult(authority.action, true);
  }
  if (
    execution.status !== "claimed" ||
    authority.action.status !== "executing" ||
    authority.action.executionLeaseId !== leaseId
  ) {
    throw new ConflictError("Assistant execution lease is no longer active.");
  }

  const transition = await runFinalizeTransition(db, {
    actionId,
    workflowId: authority.workflow.id,
    executionId,
    executorId,
    leaseId,
    status: input.status,
    safeResult,
    errorCode: input.errorCode,
    safeError: input.safeError,
    workflowStatus: input.workflowStatus,
    nextStep: authority.action.stepIndex + 1,
    now: input.now,
  });
  if (!transition.completedAction[0]) {
    const latest = await loadActionAuthority(db, actionId);
    const latestExecution = await selectExecution(db, executionId);
    if (
      isTerminalAction(latest.action) &&
      latest.action.status === input.status &&
      latest.action.safeResult === safeResult &&
      latest.action.errorCode === input.errorCode &&
      latest.action.safeError === input.safeError &&
      latestExecution?.status === input.status &&
      isWorkflowCompletionVisible(
        latest.workflow,
        input.workflowStatus,
        latest.action.stepIndex + 1,
      )
    ) {
      return mapActionResult(latest.action, true);
    }
    throw new ConflictError("Assistant execution lease was lost before completion.");
  }
  if (!transition.completedExecution[0] || !transition.completedWorkflow[0]) {
    throw new ServiceUnavailableError("Assistant terminal transition was not committed.");
  }
  return mapActionResult(transition.completedAction[0], false);
}

async function runFinalizeTransition(
  db: Database,
  input: {
    actionId: string;
    workflowId: string;
    executionId: string;
    executorId: string;
    leaseId: string;
    status: "succeeded" | "failed";
    safeResult: string;
    errorCode: string | null;
    safeError: string | null;
    workflowStatus: "running" | "succeeded" | "failed";
    nextStep: number;
    now: Date;
  },
) {
  const terminalWorkflow = input.workflowStatus === "succeeded" || input.workflowStatus === "failed";
  const [completedAction, completedExecution, completedWorkflow] = await safeBatch(db, [
    db.update(assistantActions).set({
      status: input.status,
      safeResult: input.safeResult,
      errorCode: input.errorCode,
      safeError: input.safeError,
      executedAt: input.now,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
      updatedAt: input.now,
    }).where(and(
      eq(assistantActions.id, input.actionId),
      eq(assistantActions.status, "executing"),
      eq(assistantActions.executionLeaseId, input.leaseId),
      sql`EXISTS (
        SELECT 1 FROM ${assistantActionExecutions}
        WHERE ${assistantActionExecutions.id} = ${input.executionId}
          AND ${assistantActionExecutions.actionId} = ${input.actionId}
          AND ${assistantActionExecutions.status} = 'claimed'
          AND ${assistantActionExecutions.executorId} = ${input.executorId}
      )`,
    )).returning(),
    db.update(assistantActionExecutions).set({
      status: input.status,
      completedAt: input.now,
    }).where(and(
      eq(assistantActionExecutions.id, input.executionId),
      eq(assistantActionExecutions.actionId, input.actionId),
      eq(assistantActionExecutions.status, "claimed"),
      eq(assistantActionExecutions.executorId, input.executorId),
      sql`EXISTS (
        SELECT 1 FROM ${assistantActions}
        WHERE ${assistantActions.id} = ${input.actionId}
          AND ${assistantActions.status} = ${input.status}
          AND ${assistantActions.safeResult} = ${input.safeResult}
      )`,
    )).returning({ id: assistantActionExecutions.id }),
    db.update(assistantWorkflows).set({
      status: input.workflowStatus,
      currentStep: input.nextStep,
      completedAt: terminalWorkflow ? input.now : null,
      updatedAt: input.now,
    }).where(and(
      eq(assistantWorkflows.id, input.workflowId),
      sql`EXISTS (
        SELECT 1 FROM ${assistantActions}
        WHERE ${assistantActions.id} = ${input.actionId}
          AND ${assistantActions.status} = ${input.status}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${assistantActionExecutions}
        WHERE ${assistantActionExecutions.id} = ${input.executionId}
          AND ${assistantActionExecutions.status} = ${input.status}
      )`,
    )).returning({ id: assistantWorkflows.id }),
  ] as const);
  return { completedAction, completedExecution, completedWorkflow };
}

async function resolveExistingExecution<TArguments extends Record<string, unknown>>(
  db: Database,
  input: {
    authority: ActionAuthority;
    execution: ExecutionRow;
    argumentsSchema: AssistantArgumentsParser<TArguments>;
    argumentEncryptionKey: string;
    executorId: string;
    leaseSeconds: number;
    now: Date;
  },
): Promise<ClaimAssistantExecutionResult<TArguments>> {
  if (isTerminalAction(input.authority.action)) {
    if (input.execution.status !== input.authority.action.status) {
      throw new ServiceUnavailableError(
        "Assistant terminal transition is incomplete and requires reconciliation.",
      );
    }
    return { status: "replay", result: mapActionResult(input.authority.action, true) };
  }
  if (input.execution.status !== "claimed") {
    throw new ServiceUnavailableError(
      "Assistant execution is terminal but its authoritative action result is unavailable.",
    );
  }
  if (input.authority.action.status !== "executing") {
    throw new ServiceUnavailableError("Assistant execution state requires reconciliation.");
  }
  if (
    input.authority.action.executionLeaseExpiresAt &&
    input.authority.action.executionLeaseExpiresAt > input.now
  ) {
    return {
      status: "processing",
      actionId: input.authority.action.id,
      workflowId: input.authority.workflow.id,
      leaseExpiresAt: input.authority.action.executionLeaseExpiresAt.getTime(),
    };
  }

  await ensureActionNotExpired(db, input.authority.action, input.now);
  const argumentsValue = await decryptAndValidateActionArguments(
    input.authority.action,
    input.argumentEncryptionKey,
    input.argumentsSchema,
  );
  const leaseId = createId("aal");
  const leaseExpiresAt = addSeconds(input.now, input.leaseSeconds);
  const currentLeaseCondition = input.authority.action.executionLeaseId
    ? eq(assistantActions.executionLeaseId, input.authority.action.executionLeaseId)
    : isNull(assistantActions.executionLeaseId);
  const [reclaimedAction, reclaimedExecution] = await safeBatch(db, [
    db.update(assistantActions).set({
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: leaseExpiresAt,
      retryCount: sql`${assistantActions.retryCount} + 1`,
      updatedAt: input.now,
    }).where(and(
      eq(assistantActions.id, input.authority.action.id),
      eq(assistantActions.status, "executing"),
      currentLeaseCondition,
      or(
        isNull(assistantActions.executionLeaseExpiresAt),
        lte(assistantActions.executionLeaseExpiresAt, input.now),
      ),
      sql`EXISTS (
        SELECT 1 FROM ${assistantActionExecutions}
        WHERE ${assistantActionExecutions.id} = ${input.execution.id}
          AND ${assistantActionExecutions.actionId} = ${input.authority.action.id}
          AND ${assistantActionExecutions.status} = 'claimed'
          AND ${assistantActionExecutions.executorId} = ${input.execution.executorId}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${assistantWorkflows}
        WHERE ${assistantWorkflows.id} = ${input.authority.workflow.id}
          AND ${assistantWorkflows.status} NOT IN ('succeeded', 'failed', 'cancelled')
      )`,
    )).returning({ id: assistantActions.id }),
    db.update(assistantActionExecutions).set({
      executorId: input.executorId,
      attempt: sql`${assistantActionExecutions.attempt} + 1`,
      startedAt: input.now,
    }).where(and(
      eq(assistantActionExecutions.id, input.execution.id),
      eq(assistantActionExecutions.actionId, input.authority.action.id),
      eq(assistantActionExecutions.status, "claimed"),
      eq(assistantActionExecutions.executorId, input.execution.executorId),
      sql`EXISTS (
        SELECT 1 FROM ${assistantActions}
        WHERE ${assistantActions.id} = ${input.authority.action.id}
          AND ${assistantActions.status} = 'executing'
          AND ${assistantActions.executionLeaseId} = ${leaseId}
      )`,
    )).returning({ id: assistantActionExecutions.id }),
  ] as const);
  if (!reclaimedAction[0]) {
    const latest = await selectAction(db, input.authority.action.id);
    if (latest && isTerminalAction(latest)) {
      return { status: "replay", result: mapActionResult(latest, true) };
    }
    if (latest?.executionLeaseExpiresAt) {
      return {
        status: "processing",
        actionId: latest.id,
        workflowId: latest.workflowId,
        leaseExpiresAt: latest.executionLeaseExpiresAt.getTime(),
      };
    }
    throw new ConflictError("Assistant execution could not reclaim its expired lease.");
  }

  if (!reclaimedExecution[0]) {
    throw new ServiceUnavailableError("Assistant execution lease recovery was not committed.");
  }

  return {
    status: "claimed",
    claim: buildExecutionClaim({
      authority: input.authority,
      executionId: input.execution.id,
      leaseId,
      executorId: input.executorId,
      leaseExpiresAt,
      argumentsValue,
    }),
  };
}

async function validateExecutionApproval(
  action: ActionRow,
  approvalToken: string | undefined,
  now: Date,
): Promise<string | null> {
  if (action.confirmationPolicy === "none") {
    if (action.status !== "prepared") {
      throw new ConflictError("Assistant action is not ready for execution.");
    }
    return null;
  }
  if (
    action.status !== "approved" ||
    !action.approvalTokenHash ||
    !action.approvalExpiresAt ||
    action.approvalExpiresAt <= now ||
    !approvalToken
  ) {
    throw new ForbiddenError("Assistant action requires a current approval.");
  }
  const approvalTokenHash = await hashAssistantApprovalCredential(approvalToken);
  if (!constantTimeAssistantHashEqual(action.approvalTokenHash, approvalTokenHash)) {
    throw new ForbiddenError("Assistant approval credential is invalid.");
  }
  return approvalTokenHash;
}

async function decryptAndValidateActionArguments<TArguments extends Record<string, unknown>>(
  action: ActionRow,
  encryptionKey: string,
  argumentsSchema: AssistantArgumentsParser<TArguments>,
): Promise<TArguments> {
  if (!action.encryptedArguments) {
    throw new ServiceUnavailableError("Assistant action arguments are unavailable.");
  }
  const decrypted = await decryptAssistantArguments(
    action.encryptedArguments,
    encryptionKey,
    { actionId: action.id, argumentsHash: action.argumentsHash },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw new ServiceUnavailableError("Assistant action arguments are unreadable.");
  }
  const validated = parseContract(
    () => argumentsSchema.parse(parsed),
    "Stored assistant action arguments no longer match their command schema.",
  );
  if (!isPlainRecord(validated)) {
    throw new ServiceUnavailableError("Stored assistant action arguments are not a JSON object.");
  }
  const canonical = canonicalizeAssistantJson(validated);
  const hash = await sha256Hex(canonical);
  if (canonical !== decrypted || !constantTimeAssistantHashEqual(hash, action.argumentsHash)) {
    throw new ServiceUnavailableError("Assistant action arguments failed integrity validation.");
  }
  return validated;
}

function buildExecutionClaim<TArguments extends Record<string, unknown>>(input: {
  authority: ActionAuthority;
  executionId: string;
  leaseId: string;
  executorId: string;
  leaseExpiresAt: Date;
  argumentsValue: TArguments;
}): ClaimedAssistantExecution<TArguments> {
  return {
    actionId: input.authority.action.id,
    workflowId: input.authority.workflow.id,
    sessionId: input.authority.session.id,
    executionId: input.executionId,
    leaseId: input.leaseId,
    executorId: input.executorId,
    capability: input.authority.action.capability,
    argumentsHash: input.authority.action.argumentsHash,
    arguments: input.argumentsValue,
    expectedVersions: parseStoredExpectedVersions(input.authority.action.expectedVersions),
    permission: input.authority.action.permission,
    riskClass: input.authority.action.riskClass,
    leaseExpiresAt: input.leaseExpiresAt.getTime(),
  };
}

function isExecutionClaimConflict(error: unknown): boolean {
  return error instanceof Error && /(?:assistant_action_executions|execution.*unique)/i.test(
    error.message,
  );
}

function isWorkflowCompletionVisible(
  workflow: { status: string; currentStep: number },
  expectedStatus: "running" | "succeeded" | "failed",
  completedStep: number,
): boolean {
  if (workflow.currentStep < completedStep) return false;
  return expectedStatus === "running" || workflow.status === expectedStatus;
}
