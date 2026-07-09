import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import {
  ConflictError,
  ForbiddenError,
  RateLimitError,
  UnauthorizedError,
} from "@scalius/core/errors";
import { ASSISTANT_PROTOCOL_VERSION } from "@scalius/shared/assistant-contracts";

import { approveAssistantAction, prepareAssistantAction } from "./assistant-actions";
import { createAssistantSessionCredential } from "./assistant-crypto";
import {
  appendAssistantEvent,
  cleanupExpiredAssistantRateLimits,
  consumeAssistantRateLimit,
  listAssistantEvents,
} from "./assistant-events";
import {
  claimAssistantActionExecution,
  completeAssistantActionExecution,
  failAssistantActionExecution,
} from "./assistant-executions";
import {
  createAssistantSession,
  createAssistantWorkflow,
  resumeAssistantSession,
  revokeAssistantSession,
} from "./assistant-sessions";
import {
  createFakeAssistantAuthorityDb,
  type FakeAssistantAuthorityState,
} from "./assistant-test-db";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const PERMISSION_HASH = "a".repeat(64);
const ARGUMENT_ENCRYPTION_KEY = base64Key(11);
const APPROVAL_CREDENTIAL_KEY = "assistant-approval-key-0123456789abcdef";
const AUTHORIZATION = {
  granted: true,
  permissionSnapshotHash: PERMISSION_HASH,
};
const refundArgumentsSchema = z.object({
  orderId: z.string().regex(/^order_[a-z0-9]+$/),
  amount: z.number().positive(),
}).strict();

describe("assistant authority sessions and workflows", () => {
  it("replays session creation only for the same strong credential and owner", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const credential = createAssistantSessionCredential();
    const input = {
      surface: "admin" as const,
      actorType: "admin" as const,
      actorId: "admin_1",
      conversationKey: "conversation_1",
      credential,
      permissionSnapshotHash: PERMISSION_HASH,
      safeMetadata: { source: "dashboard" },
      now: NOW,
    };

    const created = await createAssistantSession(fake.db, input);
    const replayed = await createAssistantSession(fake.db, {
      ...input,
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(created.replayed).toBe(false);
    expect(replayed).toMatchObject({
      replayed: true,
      credential,
      session: { id: created.session.id },
    });
    expect(fake.state.sessions).toHaveLength(1);
    expect(fake.state.sessions[0]?.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(fake.state.sessions[0])).not.toContain(credential);

    await expect(createAssistantSession(fake.db, {
      ...input,
      actorId: "admin_2",
    })).rejects.toBeInstanceOf(ConflictError);
    await expect(createAssistantSession(fake.db, {
      ...input,
      credential: createAssistantSessionCredential(),
    })).rejects.toBeInstanceOf(ConflictError);
    await expect(createAssistantSession(fake.db, {
      ...input,
      ttlSeconds: 60 * 60,
    })).rejects.toBeInstanceOf(ConflictError);

    await expect(resumeAssistantSession(fake.db, {
      credential,
      expectedSurface: "admin",
      now: new Date(NOW.getTime() + 2_000),
    })).resolves.toMatchObject({ id: created.session.id, status: "active" });

    await revokeAssistantSession(fake.db, { sessionId: created.session.id, now: NOW });
    await expect(createAssistantSession(fake.db, input)).rejects.toBeInstanceOf(ConflictError);
    await expect(resumeAssistantSession(fake.db, {
      credential,
      expectedSurface: "admin",
      now: NOW,
    })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("deduplicates workflow creation and rejects changed intent under the same request ID", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const session = await createSession(fake.state, fake.db);
    const input = {
      sessionId: session.id,
      clientRequestId: "workflow_request_1",
      intent: "admin.order.refund",
      riskClass: "high_risk" as const,
      permissionSnapshotHash: PERMISSION_HASH,
      safePlan: [{ type: "text" as const, text: "Review one refund." }],
      now: NOW,
    };

    const created = await createAssistantWorkflow(fake.db, input);
    const replayed = await createAssistantWorkflow(fake.db, input);
    expect(created.replayed).toBe(false);
    expect(replayed).toMatchObject({ replayed: true, workflow: { id: created.workflow.id } });
    expect(fake.state.workflows).toHaveLength(1);

    await expect(createAssistantWorkflow(fake.db, {
      ...input,
      intent: "admin.order.cancel",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("lists bounded monotonic events only after credential-bound session checks", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const credential = createAssistantSessionCredential();
    const created = await createAssistantSession(fake.db, {
      surface: "admin",
      actorType: "admin",
      actorId: "admin_1",
      conversationKey: "conversation_events",
      credential,
      permissionSnapshotHash: PERMISSION_HASH,
      now: NOW,
    });

    for (const [index, text] of ["First", "Second", "Third"].entries()) {
      await appendAssistantEvent(fake.db, {
        sessionId: created.session.id,
        type: "workflow.progress",
        parts: [{ type: "text", text }],
        now: new Date(NOW.getTime() + index * 1_000),
      });
    }

    const firstPage = await listAssistantEvents(fake.db, {
      credential,
      expectedSurface: "admin",
      expectedSessionId: created.session.id,
      expectedActorId: "admin_1",
      expectedConversationKey: "conversation_events",
      expectedPermissionSnapshotHash: PERMISSION_HASH,
      afterSequence: 0,
      limit: 2,
      now: new Date(NOW.getTime() + 4_000),
    });

    expect(firstPage.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(firstPage.events.map((event) => event.parts[0])).toEqual([
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]);
    expect(firstPage.cursor).toEqual({
      afterSequence: 0,
      nextSequence: 2,
      latestSequence: 3,
      hasMore: true,
    });

    await expect(listAssistantEvents(fake.db, {
      credential,
      expectedSurface: "admin",
      expectedActorId: "admin_2",
      expectedPermissionSnapshotHash: PERMISSION_HASH,
      now: new Date(NOW.getTime() + 4_000),
    })).rejects.toBeInstanceOf(UnauthorizedError);

    await expect(listAssistantEvents(fake.db, {
      credential,
      expectedSurface: "admin",
      limit: 26,
      now: new Date(NOW.getTime() + 4_000),
    })).rejects.toThrow(/event limit/i);
  });
});

describe("assistant authority approval and execution", () => {
  it("enforces step-up and replays one deterministic approval receipt across CAS races", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const prepared = await setupRefundAction(fake.state, fake.db);
    const approvalNow = new Date(NOW.getTime() + 789);
    const base = {
      approvedBy: "admin_1",
      approvalCredentialKey: APPROVAL_CREDENTIAL_KEY,
      authorization: AUTHORIZATION,
      stepUp: { actorId: "admin_1", verifiedAt: approvalNow },
      now: approvalNow,
    };

    await expect(approveAssistantAction(fake.db, {
      ...base,
      stepUp: undefined,
      request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_missing"),
    })).rejects.toBeInstanceOf(ForbiddenError);

    const results = await Promise.all([
      approveAssistantAction(fake.db, {
        ...base,
        request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_1"),
      }),
      approveAssistantAction(fake.db, {
        ...base,
        request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_2"),
      }),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.approvalToken).toMatch(/^approval_asst_[A-Za-z0-9_-]{43}$/);
    expect(fake.state.actions[0]?.status).toBe("approved");
    expect(fake.state.actions[0]?.approvalTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(fake.state.actions[0])).not.toContain(results[0]?.approvalToken);
    expect(fake.state.batches.filter((size) => size === 2)).toHaveLength(2);

    await expect(approveAssistantAction(fake.db, {
      ...base,
      now: new Date(approvalNow.getTime() + 2_000),
      request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_replay"),
    })).resolves.toEqual(results[0]);
    await expect(approveAssistantAction(fake.db, {
      ...base,
      approvedBy: "admin_2",
      stepUp: { actorId: "admin_2", verifiedAt: approvalNow },
      request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_wrong_actor"),
    })).rejects.toBeInstanceOf(ForbiddenError);

    const expiredAt = new Date(NOW.getTime() + 11 * 60 * 1_000);
    await expect(approveAssistantAction(fake.db, {
      ...base,
      now: expiredAt,
      stepUp: { actorId: "admin_1", verifiedAt: expiredAt },
      request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_expired"),
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("claims once, reports in-flight work, completes, and replays the sole action result", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const prepared = await setupRefundAction(fake.state, fake.db);
    const approval = await approveRefund(fake.db, prepared);
    const request = executeRequest(prepared, approval.approvalToken, "execute_1", "idem_1");
    const batchesBeforeClaim = fake.state.batches.length;

    const claimed = await claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_1",
      authorization: AUTHORIZATION,
      now: NOW,
    });
    expect(claimed.status).toBe("claimed");
    if (claimed.status !== "claimed") throw new Error("Expected execution claim");
    expect(claimed.claim.arguments).toEqual({ amount: 25, orderId: "order_1" });
    expect(fake.state.actions[0]?.encryptedArguments).not.toContain("order_1");
    expect(fake.state.batches.slice(batchesBeforeClaim)).toEqual([3]);

    await expect(claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_2",
      authorization: AUTHORIZATION,
      now: NOW,
    })).resolves.toMatchObject({ status: "processing", actionId: prepared.actionId });

    const completionInput = {
      ...claimIdentity(claimed.claim),
      parts: [{
        type: "result" as const,
        title: "Refund recorded",
        summary: "The refund was recorded once.",
        status: "succeeded" as const,
      }],
      workflowStatus: "running" as const,
      now: new Date(NOW.getTime() + 1_000),
    };
    const completed = await completeAssistantActionExecution(fake.db, completionInput);
    expect(completed).toMatchObject({ status: "succeeded", replayed: false });
    expect(fake.state.batches.at(-1)).toBe(3);

    fake.state.workflows[0]!.status = "succeeded";
    await expect(completeAssistantActionExecution(fake.db, completionInput)).resolves.toMatchObject({
      status: "succeeded",
      replayed: true,
    });

    await expect(claimAssistantActionExecution(fake.db, {
      request: { ...request, argumentsHash: "b".repeat(64) },
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_3",
      authorization: AUTHORIZATION,
      now: new Date(NOW.getTime() + 2_000),
    })).rejects.toBeInstanceOf(ConflictError);
    await expect(claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_3",
      now: new Date(NOW.getTime() + 2_000),
    })).rejects.toBeInstanceOf(ForbiddenError);

    const replay = await claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_3",
      authorization: AUTHORIZATION,
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(replay).toMatchObject({
      status: "replay",
      result: { status: "succeeded", replayed: true },
    });
    expect(fake.state.actions[0]?.safeResult).toContain("Refund recorded");
    expect(Object.keys(fake.state.executions[0] ?? {})).not.toContain("safeResult");
  });

  it("rolls back approval, claim, and completion when a D1 batch fails midway", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const prepared = await setupRefundAction(fake.state, fake.db);
    const approvalInput = {
      request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_1"),
      approvedBy: "admin_1",
      approvalCredentialKey: APPROVAL_CREDENTIAL_KEY,
      authorization: AUTHORIZATION,
      stepUp: { actorId: "admin_1", verifiedAt: NOW },
      now: NOW,
    };

    fake.state.failNextBatchAt = 1;
    await expect(approveAssistantAction(fake.db, approvalInput)).rejects.toThrow(
      "Injected assistant batch failure",
    );
    expect(fake.state.actions[0]?.status).toBe("approval_required");
    expect(fake.state.actions[0]?.approvalTokenHash).toBeNull();
    expect(fake.state.workflows[0]?.status).toBe("approval_required");

    const approval = await approveAssistantAction(fake.db, approvalInput);
    const request = executeRequest(prepared, approval.approvalToken, "execute_1", "idem_1");
    fake.state.failNextBatchAt = 1;
    await expect(claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_1",
      authorization: AUTHORIZATION,
      now: NOW,
    })).rejects.toThrow("Injected assistant batch failure");
    expect(fake.state.actions[0]?.status).toBe("approved");
    expect(fake.state.actions[0]?.executionLeaseId).toBeNull();
    expect(fake.state.executions).toHaveLength(0);

    const claimed = await claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_1",
      authorization: AUTHORIZATION,
      now: NOW,
    });
    if (claimed.status !== "claimed") throw new Error("Expected execution claim");

    const completion = {
      ...claimIdentity(claimed.claim),
      parts: [{
        type: "result" as const,
        title: "Refund recorded",
        summary: "The refund was recorded once.",
        status: "succeeded" as const,
      }],
      workflowStatus: "succeeded" as const,
      now: new Date(NOW.getTime() + 1_000),
    };
    fake.state.failNextBatchAt = 1;
    await expect(completeAssistantActionExecution(fake.db, completion)).rejects.toThrow(
      "Injected assistant batch failure",
    );
    expect(fake.state.actions[0]?.status).toBe("executing");
    expect(fake.state.executions[0]?.status).toBe("claimed");
    expect(fake.state.workflows[0]?.status).toBe("running");

    await expect(completeAssistantActionExecution(fake.db, completion)).resolves.toMatchObject({
      status: "succeeded",
      replayed: false,
    });
    expect(fake.state.batches).toEqual([2, 2, 3, 3, 3, 3]);
  });

  it("reclaims an expired lease and makes failure terminal without a retrying split state", async () => {
    const fake = createFakeAssistantAuthorityDb();
    const prepared = await setupRefundAction(fake.state, fake.db);
    const approval = await approveRefund(fake.db, prepared);
    const request = executeRequest(prepared, approval.approvalToken, "execute_1", "idem_1");
    const first = await claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_1",
      authorization: AUTHORIZATION,
      now: NOW,
    });
    if (first.status !== "claimed") throw new Error("Expected execution claim");
    fake.state.actions[0]!.executionLeaseExpiresAt = new Date(NOW.getTime() - 1_000);

    const reclaimed = await claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_2",
      authorization: AUTHORIZATION,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(reclaimed.status).toBe("claimed");
    if (reclaimed.status !== "claimed") throw new Error("Expected reclaimed execution");
    expect(reclaimed.claim.executionId).toBe(first.claim.executionId);
    expect(fake.state.executions[0]?.attempt).toBe(2);
    expect(fake.state.actions[0]?.retryCount).toBe(1);

    await failAssistantActionExecution(fake.db, {
      ...claimIdentity(reclaimed.claim),
      errorCode: "provider.declined",
      safeError: "The provider declined the request.",
      workflowStatus: "failed",
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(fake.state.actions[0]?.status).toBe("failed");
    expect(fake.state.workflows[0]?.status).toBe("failed");

    await expect(claimAssistantActionExecution(fake.db, {
      request,
      argumentsSchema: refundArgumentsSchema,
      argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
      executorId: "executor_3",
      authorization: AUTHORIZATION,
      now: new Date(NOW.getTime() + 3_000),
    })).resolves.toMatchObject({ status: "replay", result: { status: "failed" } });
  });
});

describe("assistant authority events and rate limits", () => {
  it("appends monotonic events and atomically bounds hashed rate-limit windows", async () => {
    const fake = createFakeAssistantAuthorityDb({ rateLimitCeiling: 2 });
    const session = await createSession(fake.state, fake.db);
    const events = await Promise.all([
      appendAssistantEvent(fake.db, {
        sessionId: session.id,
        type: "assistant.started",
        status: "running",
        parts: [{ type: "text", text: "Started." }],
        now: NOW,
      }),
      appendAssistantEvent(fake.db, {
        sessionId: session.id,
        type: "assistant.progress",
        status: "running",
        parts: [{ type: "text", text: "Still working." }],
        now: NOW,
      }),
    ]);
    expect(events.map((event) => event.sequence).sort()).toEqual([1, 2]);
    expect(fake.state.sessions[0]?.lastEventSequence).toBe(2);

    const rateInput = {
      scope: "storefront.chat",
      bucket: "203.0.113.40",
      hashKey: "assistant-rate-limit-key-0123456789abcdef",
      limit: 2,
      windowSeconds: 60,
      now: NOW,
    };
    const rateResults = await Promise.allSettled(
      Array.from({ length: 4 }, () => consumeAssistantRateLimit(fake.db, rateInput)),
    );
    expect(rateResults.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(rateResults.filter((result) => (
      result.status === "rejected" && result.reason instanceof RateLimitError
    ))).toHaveLength(2);
    expect(fake.state.rateLimits[0]?.bucketHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(fake.state.rateLimits[0])).not.toContain(rateInput.bucket);

    await expect(cleanupExpiredAssistantRateLimits(
      fake.db,
      new Date(NOW.getTime() + 61_000),
    )).resolves.toMatchObject({ deleted: 1, hasMore: false });
  });

  it("opens a fresh hashed rate-limit window exactly after the reset boundary", async () => {
    const fake = createFakeAssistantAuthorityDb({ rateLimitCeiling: 2 });
    const input = {
      scope: "storefront.chat",
      bucket: "2001:db8::1",
      hashKey: "assistant-rate-limit-key-0123456789abcdef",
      limit: 2,
      windowSeconds: 60,
      now: NOW,
    };

    await consumeAssistantRateLimit(fake.db, input);
    await consumeAssistantRateLimit(fake.db, input);
    await expect(consumeAssistantRateLimit(fake.db, input)).rejects.toBeInstanceOf(
      RateLimitError,
    );

    await expect(
      consumeAssistantRateLimit(fake.db, {
        ...input,
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ allowed: true, count: 1, remaining: 1 });

    expect(fake.state.rateLimits).toHaveLength(2);
    expect(
      new Set(fake.state.rateLimits.map((row) => row.bucketHash)).size,
    ).toBe(1);
    expect(JSON.stringify(fake.state.rateLimits)).not.toContain(input.bucket);
  });
});

async function setupRefundAction(
  _state: FakeAssistantAuthorityState,
  db: Parameters<typeof createAssistantSession>[0],
) {
  const session = await createSession(_state, db);
  const workflow = await createAssistantWorkflow(db, {
    sessionId: session.id,
    clientRequestId: "workflow_request_1",
    intent: "admin.order.refund",
    riskClass: "high_risk",
    permissionSnapshotHash: PERMISSION_HASH,
    now: NOW,
  });
  const prepared = await prepareAssistantAction(db, {
    request: {
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      sessionId: session.id,
      workflowId: workflow.workflow.id,
      capability: "admin.order.refund",
      arguments: { orderId: "order_1", amount: 25 },
      expectedVersions: [{ resourceType: "order", resourceId: "order_1", version: "4" }],
      clientRequestId: "prepare_request_1",
    },
    descriptor: {
      id: "admin.order.refund",
      title: "Refund order",
      description: "Refunds one captured order payment.",
      surface: "admin",
      permission: "orders.refund",
      riskClass: "high_risk",
      confirmationPolicy: "step_up",
      idempotencyPolicy: "required",
      readOnly: false,
      reversible: false,
      destructive: false,
      financial: true,
      externalSideEffect: true,
      freshAuthRequired: true,
      supportsDryRun: true,
    },
    argumentsSchema: refundArgumentsSchema,
    argumentEncryptionKey: ARGUMENT_ENCRYPTION_KEY,
    authorization: AUTHORIZATION,
    displayParts: [{ type: "text", text: "Review the refund details." }],
    confirmation: {
      title: "Confirm refund",
      summary: "Refund BDT 25 for order 1.",
      consequences: ["This moves money through the configured provider."],
      confirmLabel: "Refund BDT 25",
    },
    monetaryValue: 25,
    currency: "BDT",
    now: NOW,
  });
  return {
    actionId: prepared.action.actionId,
    argumentsHash: prepared.action.argumentsHash,
  };
}

async function createSession(
  _state: FakeAssistantAuthorityState,
  db: Parameters<typeof createAssistantSession>[0],
) {
  const created = await createAssistantSession(db, {
    surface: "admin",
    actorType: "admin",
    actorId: "admin_1",
    conversationKey: "conversation_1",
    credential: createAssistantSessionCredential(),
    permissionSnapshotHash: PERMISSION_HASH,
    now: NOW,
  });
  return created.session;
}

async function approveRefund(
  db: Parameters<typeof approveAssistantAction>[0],
  prepared: { actionId: string; argumentsHash: string },
) {
  return approveAssistantAction(db, {
    request: confirmRequest(prepared.actionId, prepared.argumentsHash, "confirm_1"),
    approvedBy: "admin_1",
    approvalCredentialKey: APPROVAL_CREDENTIAL_KEY,
    authorization: AUTHORIZATION,
    stepUp: { actorId: "admin_1", verifiedAt: NOW },
    now: NOW,
  });
}

function confirmRequest(actionId: string, argumentsHash: string, clientRequestId: string) {
  return {
    protocolVersion: ASSISTANT_PROTOCOL_VERSION,
    actionId,
    argumentsHash,
    clientRequestId,
  };
}

function executeRequest(
  prepared: { actionId: string; argumentsHash: string },
  approvalToken: string,
  clientRequestId: string,
  idempotencyKey: string,
) {
  return {
    protocolVersion: ASSISTANT_PROTOCOL_VERSION,
    actionId: prepared.actionId,
    argumentsHash: prepared.argumentsHash,
    approvalToken,
    idempotencyKey,
    clientRequestId,
  };
}

function claimIdentity(claim: {
  actionId: string;
  executionId: string;
  leaseId: string;
  executorId: string;
}) {
  return {
    actionId: claim.actionId,
    executionId: claim.executionId,
    leaseId: claim.leaseId,
    executorId: claim.executorId,
  };
}

function base64Key(seed: number): string {
  return btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (
    seed + index
  ) % 256)));
}
