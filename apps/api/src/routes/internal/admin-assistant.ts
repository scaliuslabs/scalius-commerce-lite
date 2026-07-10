import { OpenAPIHono } from "@hono/zod-openapi";
import {
  bindAssistantAgentInstance,
  beginAssistantAgentAdmission,
  beginAssistantComputerHandoffDispatch,
  confirmAssistantComputerHandoffDispatch,
  consumeAssistantComputerHandoff,
  createAssistantSession,
  createAssistantWorkflow,
  failAssistantComputerHandoffDispatch,
  finishAssistantAgentAdmission,
  finishAssistantComputerStopBarrier,
  listAssistantEvents,
  markAssistantComputerHandoffDispatchUncertain,
  readAssistantComputerStopBarrier,
  recordAssistantComputerStopBarrier,
  revokeAssistantSession,
} from "@scalius/core/modules/assistant";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@scalius/core/errors";
import { cookieOriginGuardMiddleware } from "../../middleware/cookie-origin-guard";
import { adminAuthMiddleware } from "../../middleware/admin-auth";
import { ADMIN_COMMAND_POLICY_DIGEST } from "../../modules/assistant";
import { ok } from "../../utils/api-response";
import {
  ADMIN_ASSISTANT_AUTHORITY_BASE_PATH,
  ADMIN_ASSISTANT_AUTHORITY_PATHS,
  adminAssistantCapabilityDescribeSchema,
  adminAssistantCapabilitySearchSchema,
  adminAssistantAdmissionFinishSchema,
  adminAssistantAgentInstanceSchema,
  adminAssistantComputerHandoffConfirmSchema,
  adminAssistantComputerHandoffConsumeSchema,
  adminAssistantEmptyBodySchema,
  adminAssistantEventListSchema,
  adminAssistantFlueAdmitSchema,
  adminAssistantFlueCommandSchema,
  adminAssistantSessionCreateSchema,
  adminAssistantWorkflowCreateSchema,
  isExactInternalAdminAssistantRequest,
  parseAdminAssistantJson,
  readAdminAssistantSessionCredential,
} from "./admin-assistant-contract";
import {
  adminAssistantSessionMetadata,
  assistantRiskForCapability,
  assertCurrentAdminAssistantSession,
  compactAdminCapability,
  compactAssistantSession,
  compactAssistantWorkflow,
  requireAuthorizedAdminCapability,
  requireCurrentAdminAssistantSession,
  resolveAdminAssistantAuthorityContext,
  safeWorkflowPlanForCapability,
  searchAuthorizedAdminCapabilities,
} from "./admin-assistant-context";
import {
  assertFlueAdmissionSession,
  createFlueAgentEnvelope,
  deriveFlueThreadIdentity,
  deriveHiddenAdminAssistantCredential,
  hasCallerSuppliedFlueIdentity,
  requireAssistantThreadSigningKey,
} from "./flue-thread-admission";
import {
  executeAdminFlueCommand,
  failure as flueCommandFailure,
} from "./flue-command-execution";
import { resolveStorefrontAssistantDeploymentContext } from "./storefront-assistant-context";
import { resolveAdminFlueCommandAuthority } from "./flue-command-authority";

const ADMIN_ASSISTANT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const FLUE_SERVICE_HANDOFF_PATHS = new Set<string>([
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConsume,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffConfirm,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffBegin,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffFail,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueComputerHandoffUncertain,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmissionBegin,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueAdmissionFinish,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueStopBegin,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueStopStatus,
  ADMIN_ASSISTANT_AUTHORITY_PATHS.flueStopFinish,
]);

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  if (!isExactInternalAdminAssistantRequest(c.req.raw)) {
    return c.json({ success: false, error: "not_found" }, 404);
  }
  await next();
});
app.use("*", cookieOriginGuardMiddleware);
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (
    path === ADMIN_ASSISTANT_AUTHORITY_PATHS.flueCommand ||
    FLUE_SERVICE_HANDOFF_PATHS.has(path)
  ) {
    await next();
    return;
  }
  return adminAuthMiddleware(c, next);
});

app.post("/session/create", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  const input = await parseAdminAssistantJson(
    c.req.raw,
    adminAssistantSessionCreateSchema,
  );
  const authority = await resolveAdminAssistantAuthorityContext(c);
  const result = await createAssistantSession(c.get("db"), {
    surface: "admin",
    actorType: "admin",
    actorId: authority.actorId,
    conversationKey: input.conversationKey,
    credential,
    permissionSnapshotHash: authority.permissionSnapshotHash,
    safeMetadata: adminAssistantSessionMetadata(authority),
    ttlSeconds: ADMIN_ASSISTANT_SESSION_TTL_SECONDS,
  });

  return ok(c, {
    session: compactAssistantSession(result.session),
    replayed: result.replayed,
    commandPolicyDigest: ADMIN_COMMAND_POLICY_DIGEST,
  });
});

app.post("/session/resume", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  await parseAdminAssistantJson(c.req.raw, adminAssistantEmptyBodySchema);
  const authority = await resolveAdminAssistantAuthorityContext(c);
  const session = await requireCurrentAdminAssistantSession(
    c,
    credential,
    authority,
  );
  return ok(c, {
    session: compactAssistantSession(session),
    commandPolicyDigest: ADMIN_COMMAND_POLICY_DIGEST,
  });
});

app.post("/session/revoke", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  await parseAdminAssistantJson(c.req.raw, adminAssistantEmptyBodySchema);
  const authority = await resolveAdminAssistantAuthorityContext(c);
  const session = await requireCurrentAdminAssistantSession(
    c,
    credential,
    authority,
  );
  const revoked = await revokeAssistantSession(c.get("db"), {
    sessionId: session.id,
  });
  return ok(c, {
    session: compactAssistantSession(revoked.session),
    changed: revoked.changed,
  });
});

app.post("/flue/admit", async (c) => {
  if (hasCallerSuppliedFlueIdentity(c.req.raw.headers)) {
    throw new ValidationError("Assistant thread admission header is invalid.");
  }
  const input = await parseAdminAssistantJson(
    c.req.raw,
    adminAssistantFlueAdmitSchema,
  );
  const signingKey = requireAssistantThreadSigningKey(c.env);
  const [authority, deployment] = await Promise.all([
    resolveAdminAssistantAuthorityContext(c),
    resolveStorefrontAssistantDeploymentContext(c),
  ]);
  const identity = await deriveFlueThreadIdentity({
    surface: "admin",
    deploymentBindingHash: deployment.deploymentBindingHash,
    actorBinding: {
      actorId: authority.actorId,
      dashboardSessionHash: authority.dashboardSessionHash,
    },
    threadId: input.threadId,
    signingKey,
  });
  const credential = await deriveHiddenAdminAssistantCredential({
    deploymentBindingHash: deployment.deploymentBindingHash,
    actorId: authority.actorId,
    dashboardSessionHash: authority.dashboardSessionHash,
    permissionSnapshotHash: authority.permissionSnapshotHash,
    threadId: input.threadId,
    signingKey,
  });
  const created = await createAssistantSession(c.get("db"), {
    surface: "admin",
    actorType: "admin",
    actorId: authority.actorId,
    conversationKey: input.threadId,
    credential,
    permissionSnapshotHash: authority.permissionSnapshotHash,
    safeMetadata: adminAssistantSessionMetadata(authority),
    ttlSeconds: ADMIN_ASSISTANT_SESSION_TTL_SECONDS,
  });
  assertCurrentAdminAssistantSession(created.session, authority);
  assertFlueAdmissionSession(created.session, {
    surface: "admin",
    threadId: input.threadId,
  });
  const agent = await createFlueAgentEnvelope({
    surface: "admin",
    identity,
    signingKey,
    expiresAt: created.session.expiresAt,
  });
  const bound = await bindAssistantAgentInstance(c.get("db"), {
    sessionId: created.session.id,
    agentInstanceId: agent.instanceId,
  });
  assertCurrentAdminAssistantSession(bound, authority);
  assertFlueAdmissionSession(bound, {
    surface: "admin",
    threadId: input.threadId,
  });

  return ok(c, {
    agent: { ...agent, expiresAt: bound.expiresAt },
  });
});

app.post("/flue/command", async (c) => {
  if (
    c.req.raw.headers.has("cookie") ||
    hasCallerSuppliedFlueIdentity(c.req.raw.headers)
  ) {
    return c.json(flueCommandFailure(
      "invalid_request",
      "Scalius request headers are invalid.",
      false,
    ), 400);
  }
  try {
    const input = await parseAdminAssistantJson(
      c.req.raw,
      adminAssistantFlueCommandSchema,
    );
    const response = await executeAdminFlueCommand(c, input);
    return c.json(response, response.success ? 200 : 400);
  } catch (error) {
    const [status, code, message, retryable] = commandError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/flue/computer-handoff/consume", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure(
      "invalid_request",
      "Scalius request headers are invalid.",
      false,
    ), 400);
  }
  try {
    const input = await parseAdminAssistantJson(
      c.req.raw,
      adminAssistantComputerHandoffConsumeSchema,
    );
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    const result = await consumeAssistantComputerHandoff(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
      requestId: input.requestId,
      programDigest: input.programDigest,
      state: input.state,
      ticketIssuedAtMs: input.ticketIssuedAt,
      ticketExpiresAt: input.ticketExpiresAt,
    });
    if (result.status === "conflict") {
      return c.json(flueCommandFailure(
        "handoff_terminal_conflict",
        "Computer handoff already reached a terminal state.",
        false,
      ), 409);
    }
    if (result.status === "uncertain") {
      return c.json(flueCommandFailure(
        "handoff_dispatch_uncertain",
        "Computer handoff dispatch state is uncertain.",
        false,
      ), 503);
    }
    if (result.status === "stopped") {
      return c.json(flueCommandFailure(
        "handoff_stopped",
        "Computer handoff was stopped.",
        false,
      ), 409);
    }
    return ok(c, result);
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/flue/computer-handoff/begin", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure("invalid_request", "Scalius request headers are invalid.", false), 400);
  }
  try {
    const input = await parseAdminAssistantJson(c.req.raw, adminAssistantComputerHandoffConfirmSchema);
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    const result = await beginAssistantComputerHandoffDispatch(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
      requestId: input.requestId,
      programDigest: input.programDigest,
      dispatchClaimToken: input.dispatchClaimToken,
    });
    if (result.status !== "started") {
      return c.json(flueCommandFailure(
        result.status === "blocked" ? "handoff_stopped" : "handoff_dispatch_uncertain",
        result.status === "blocked" ? "Computer handoff was stopped." : "Computer handoff dispatch state is uncertain.",
        false,
      ), result.status === "blocked" ? 409 : 503);
    }
    return ok(c, result);
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/flue/computer-handoff/fail", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure("invalid_request", "Scalius request headers are invalid.", false), 400);
  }
  try {
    const input = await parseAdminAssistantJson(c.req.raw, adminAssistantComputerHandoffConfirmSchema);
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    return ok(c, await failAssistantComputerHandoffDispatch(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
      requestId: input.requestId,
      programDigest: input.programDigest,
      dispatchClaimToken: input.dispatchClaimToken,
    }));
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/flue/computer-handoff/uncertain", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure("invalid_request", "Scalius request headers are invalid.", false), 400);
  }
  try {
    const input = await parseAdminAssistantJson(c.req.raw, adminAssistantComputerHandoffConfirmSchema);
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    return ok(c, await markAssistantComputerHandoffDispatchUncertain(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
      requestId: input.requestId,
      programDigest: input.programDigest,
      dispatchClaimToken: input.dispatchClaimToken,
    }));
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/flue/admission/begin", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure("invalid_request", "Scalius request headers are invalid.", false), 400);
  }
  try {
    const input = await parseAdminAssistantJson(c.req.raw, adminAssistantAgentInstanceSchema);
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    const result = await beginAssistantAgentAdmission(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
    });
    if (result.status !== "started") {
      return c.json(flueCommandFailure(
        result.status === "stopping" ? "assistant_stopping" : "assistant_busy",
        result.status === "stopping" ? "Assistant Stop is in progress." : "Assistant admission is already active.",
        true,
      ), 409);
    }
    return ok(c, result);
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/flue/admission/finish", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure("invalid_request", "Scalius request headers are invalid.", false), 400);
  }
  try {
    const input = await parseAdminAssistantJson(c.req.raw, adminAssistantAdmissionFinishSchema);
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    return ok(c, await finishAssistantAgentAdmission(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
      admissionId: input.admissionId,
      admissionClaimToken: input.admissionClaimToken,
    }));
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

for (const [path, operation] of [
  ["/flue/stop/begin", "begin"],
  ["/flue/stop/status", "status"],
  ["/flue/stop/finish", "finish"],
] as const) {
  app.post(path, async (c) => {
    if (hasInvalidFlueServiceHeaders(c.req.raw)) {
      return c.json(flueCommandFailure("invalid_request", "Scalius request headers are invalid.", false), 400);
    }
    try {
      const input = await parseAdminAssistantJson(c.req.raw, adminAssistantAgentInstanceSchema);
      const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
      if (operation === "begin") {
        return ok(c, await recordAssistantComputerStopBarrier(c.get("db"), {
          sessionId: authority.session.id,
          agentInstanceId: input.instanceId,
        }));
      }
      if (operation === "status") {
        return ok(c, await readAssistantComputerStopBarrier(c.get("db"), {
          sessionId: authority.session.id,
          agentInstanceId: input.instanceId,
        }));
      }
      return ok(c, await finishAssistantComputerStopBarrier(c.get("db"), {
        sessionId: authority.session.id,
        agentInstanceId: input.instanceId,
      }));
    } catch (error) {
      const [status, code, message, retryable] = handoffError(error);
      return c.json(flueCommandFailure(code, message, retryable), status);
    }
  });
}

app.post("/flue/computer-handoff/confirm", async (c) => {
  if (hasInvalidFlueServiceHeaders(c.req.raw)) {
    return c.json(flueCommandFailure(
      "invalid_request",
      "Scalius request headers are invalid.",
      false,
    ), 400);
  }
  try {
    const input = await parseAdminAssistantJson(
      c.req.raw,
      adminAssistantComputerHandoffConfirmSchema,
    );
    const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
    const result = await confirmAssistantComputerHandoffDispatch(c.get("db"), {
      sessionId: authority.session.id,
      agentInstanceId: input.instanceId,
      requestId: input.requestId,
      programDigest: input.programDigest,
      dispatchClaimToken: input.dispatchClaimToken,
    });
    return ok(c, result);
  } catch (error) {
    const [status, code, message, retryable] = handoffError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.post("/workflows/create", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  const input = await parseAdminAssistantJson(
    c.req.raw,
    adminAssistantWorkflowCreateSchema,
  );
  const authority = await resolveAdminAssistantAuthorityContext(c);
  const session = await requireCurrentAdminAssistantSession(
    c,
    credential,
    authority,
  );
  const descriptor = requireAuthorizedAdminCapability(
    input.capabilityId,
    authority.permissions,
  );
  const result = await createAssistantWorkflow(c.get("db"), {
    sessionId: session.id,
    clientRequestId: input.clientRequestId,
    intent: descriptor.id,
    riskClass: assistantRiskForCapability(descriptor),
    permissionSnapshotHash: authority.permissionSnapshotHash,
    safePlan: safeWorkflowPlanForCapability(descriptor),
    parentWorkflowId: input.parentWorkflowId ?? null,
  });

  return ok(c, {
    workflow: compactAssistantWorkflow(result.workflow),
    replayed: result.replayed,
    capability: compactAdminCapability(descriptor),
  });
});

app.post("/events/list", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  const input = await parseAdminAssistantJson(
    c.req.raw,
    adminAssistantEventListSchema,
  );
  const authority = await resolveAdminAssistantAuthorityContext(c);
  const currentSession = await requireCurrentAdminAssistantSession(
    c,
    credential,
    authority,
  );
  const result = await listAssistantEvents(c.get("db"), {
    credential,
    expectedSurface: "admin",
    expectedSessionId: currentSession.id,
    expectedActorId: authority.actorId,
    expectedConversationKey: currentSession.conversationKey,
    expectedPermissionSnapshotHash: authority.permissionSnapshotHash,
    expectedSafeMetadata: adminAssistantSessionMetadata(authority),
    afterSequence: input.afterSequence,
    limit: input.limit,
  });
  assertCurrentAdminAssistantSession(result.session, authority);

  return ok(c, {
    events: result.events,
    cursor: result.cursor,
  });
});

app.post("/capabilities/search", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  const input = await parseAdminAssistantJson(
    c.req.raw,
    adminAssistantCapabilitySearchSchema,
  );
  const authority = await resolveAdminAssistantAuthorityContext(c);
  await requireCurrentAdminAssistantSession(c, credential, authority);
  const capabilities = searchAuthorizedAdminCapabilities(
    input,
    authority.permissions,
  );

  return ok(c, {
    capabilities,
    count: capabilities.length,
    commandPolicyDigest: ADMIN_COMMAND_POLICY_DIGEST,
  });
});

app.post("/capabilities/describe", async (c) => {
  const credential = readAdminAssistantSessionCredential(c.req.raw);
  const input = await parseAdminAssistantJson(
    c.req.raw,
    adminAssistantCapabilityDescribeSchema,
  );
  const authority = await resolveAdminAssistantAuthorityContext(c);
  await requireCurrentAdminAssistantSession(c, credential, authority);
  const descriptor = requireAuthorizedAdminCapability(
    input.capabilityId,
    authority.permissions,
  );

  return ok(c, {
    capability: compactAdminCapability(descriptor),
    commandPolicyDigest: ADMIN_COMMAND_POLICY_DIGEST,
  });
});

app.all("*", (c) =>
  c.json({ success: false, error: "not_found" }, 404)
);

export { app as adminAssistantAuthorityRoutes };
export { ADMIN_ASSISTANT_AUTHORITY_BASE_PATH };

function commandError(
  error: unknown,
): [400 | 401 | 403 | 404 | 503, string, string, boolean] {
  if (error instanceof UnauthorizedError) {
    return [401, "access_unavailable", "Assistant access is unavailable.", false];
  }
  if (error instanceof ForbiddenError) {
    return [403, "capability_forbidden", "That capability is not available.", false];
  }
  if (error instanceof NotFoundError) {
    return [404, "capability_not_found", "That capability is not available.", false];
  }
  if (error instanceof ValidationError) {
    return [400, "invalid_arguments", "Capability arguments are invalid.", false];
  }
  return [503, "scalius_unavailable", "Scalius is temporarily unavailable.", true];
}

function hasInvalidFlueServiceHeaders(request: Request): boolean {
  return request.headers.has("cookie") ||
    hasCallerSuppliedFlueIdentity(request.headers);
}

function handoffError(
  error: unknown,
): [400 | 401 | 403 | 503, string, string, boolean] {
  if (error instanceof UnauthorizedError) {
    return [401, "access_unavailable", "Assistant access is unavailable.", false];
  }
  if (error instanceof ForbiddenError) {
    return [403, "access_forbidden", "Assistant access is unavailable.", false];
  }
  if (error instanceof ValidationError) {
    return [400, "invalid_handoff", "Computer handoff is invalid.", false];
  }
  return [503, "handoff_unavailable", "Computer handoff state is unavailable.", false];
}
