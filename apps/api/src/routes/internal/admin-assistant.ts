import { OpenAPIHono } from "@hono/zod-openapi";
import {
  createAssistantSession,
  createAssistantWorkflow,
  listAssistantEvents,
  revokeAssistantSession,
} from "@scalius/core/modules/assistant";
import { cookieOriginGuardMiddleware } from "../../middleware/cookie-origin-guard";
import { adminAuthMiddleware } from "../../middleware/admin-auth";
import { ADMIN_COMMAND_POLICY_DIGEST } from "../../modules/assistant";
import { ok } from "../../utils/api-response";
import {
  ADMIN_ASSISTANT_AUTHORITY_BASE_PATH,
  adminAssistantCapabilityDescribeSchema,
  adminAssistantCapabilitySearchSchema,
  adminAssistantEmptyBodySchema,
  adminAssistantEventListSchema,
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

const ADMIN_ASSISTANT_SESSION_TTL_SECONDS = 8 * 60 * 60;

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
app.use("*", adminAuthMiddleware);

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
