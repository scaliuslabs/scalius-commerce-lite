import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { claimAgentBrowserHandoff } from "../../agent-access/browser-handoffs";
import { loadAgentAccessBackend } from "../../agent-access/backend";
import { resolveAgentOperationById } from "../../agent-access/direct-operation";
import { resolveAgentPrincipalFromGrant } from "../../agent-access/principal";
import {
  approveAuthorizationRequest,
  approveDeviceAuthorization,
  createCredentialGrant,
  denyAuthorizationRequest,
  denyDeviceAuthorization,
  getAgentConnection,
  getAuthorizationRequest,
  getActiveAgentCredentialForRotation,
  getDeviceAuthorizationByUserCodeHmac,
  listAgentAuditEvents,
  listAgentConnections,
  resolveGrantSelection,
  revokeAgentGrant,
  revokeAllAgentGrants,
  rotateAgentCredential,
  updateAgentGrant,
} from "@scalius/core/modules/agent-access/agent-access.service";
import { encodeEncryptedCredential, encryptCredentials } from "@scalius/core/utils/credential-encryption";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../utils/api-error";
import { created, ok } from "../../utils/api-response";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { hmacAgentOpaqueValue, issueAgentCredential } from "../../agent-access/pat";
import type { AgentPrincipal } from "../../agent-access/types";
import { getOAuthCompletionUrl } from "../../agent-access/paths";
import {
  assertAgentConnectionScope,
  assertSubordinateGrantSelection,
  getAgentConnectionListScope,
} from "../../agent-access/management-authority";

const app = new OpenAPIHono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  try {
    await next();
  } finally {
    c.header("Cache-Control", "private, no-store");
  }
});
const resourceSchema = z.enum(["dashboard", "storefront"]);
const presetSchema = z.enum(["read", "operator", "full", "custom"]);
const riskSchema = z.enum(["read", "write", "destructive", "financial", "security"]);
const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const selectionBodySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  preset: presetSchema,
  permissions: z.array(z.string().min(1).max(160)).max(256).optional(),
  riskCeiling: riskSchema.optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
}).strict();
const tokenBodySchema = selectionBodySchema.extend({ resource: resourceSchema });
const passthroughResponse = successEnvelope(z.record(z.string(), z.unknown()));

function assertSuperAdmin(c: {
  get(key: "user"): { id: string; isSuperAdmin?: boolean; twoFactorEnabled?: boolean };
  get(key: "session"): { twoFactorVerified?: boolean | null } | undefined;
  get(key: "agentPrincipal"): AgentPrincipal | undefined;
}) {
  const principal = c.get("agentPrincipal");
  if (principal) {
    // Agent principals are freshly resolved and only exist for owners whose
    // live identity remains Super Admin-eligible and 2FA-enabled.
    if (!principal.isSuperAdmin) {
      throw new ForbiddenError("Agent access management requires a live Super Admin owner");
    }
    return { id: principal.ownerUserId };
  }
  const user = c.get("user");
  const session = c.get("session");
  if (
    user.isSuperAdmin !== true ||
    user.twoFactorEnabled !== true ||
    session?.twoFactorVerified !== true
  ) {
    throw new ForbiddenError(
      "Agent access management requires a 2FA-verified Super Admin session",
    );
  }
  return user;
}

function requirePepper(env: Env): string {
  const pepper = env.AGENT_TOKEN_PEPPER?.trim();
  if (!pepper) throw new ValidationError("Agent credential service is not configured");
  return pepper;
}

function requireEncryptionKey(env: Env): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!key) throw new ValidationError("Agent pairing service is not configured");
  return key;
}

function noStore(c: { header(name: string, value: string): void }) {
  c.header("Cache-Control", "private, no-store");
}

function assertBrowserHandoffSession(c: {
  get(key: "user"): { id: string; twoFactorEnabled?: boolean };
  get(key: "session"): { twoFactorVerified?: boolean | null } | undefined;
  get(key: "agentPrincipal"): AgentPrincipal | undefined;
}): string {
  const user = c.get("user");
  if (
    c.get("agentPrincipal") ||
    user.twoFactorEnabled !== true ||
    c.get("session")?.twoFactorVerified !== true
  ) {
    throw new ForbiddenError(
      "Secure browser handoffs require the same 2FA-verified dashboard session",
    );
  }
  return user.id;
}

export function browserHandoffPage(): Response {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const script = `(() => {
  const button = document.querySelector("button");
  const status = document.querySelector("p");
  const fail = (message) => { status.textContent = message; button.disabled = false; };
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Preparing secure handoff…";
    const popup = window.open("about:blank", "scalius-secure-continuation");
    if (!popup) return fail("Allow popups for this Scalius page, then try again.");
    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "Accept": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json();
      const action = payload && payload.data && payload.data.action;
      const destination = new URL(action && action.url);
      if (!response.ok || action.method !== "POST" || !action.fields ||
          destination.protocol !== "https:" || destination.search || destination.hash) throw new Error();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        try { popup.close(); } catch {}
        fail("The secure handoff expired. Run the operation again.");
      }, 20000);
      const receive = (event) => {
        if (event.source !== popup || event.origin !== destination.origin || !event.data) return;
        if (event.data.type === "scalius-continuation-ready-v1") {
          popup.postMessage({ type: "scalius-continuation-fields-v1", fields: action.fields }, destination.origin);
        } else if (event.data.type === "scalius-continuation-accepted-v1") {
          window.clearTimeout(timeout);
          window.removeEventListener("message", receive);
          status.textContent = "Secure browser step opened.";
        }
      };
      window.addEventListener("message", receive);
      popup.location.replace(destination.toString());
    } catch {
      try { popup.close(); } catch {}
      fail("This handoff is unavailable, expired, or no longer authorized.");
    }
  });
})();`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>Continue securely in Scalius</title></head><body><main><h1>Continue securely in Scalius</h1><p>This one-use step requires your current 2FA-verified dashboard session.</p><button type="button">Continue</button></main><script nonce="${nonce}">${script}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  );
}

const listConnectionsRoute = createRoute({
  method: "get", path: "/connections", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.connections.list",
  summary: "List agent connections",
  description: "Lists bounded agent grants and credentials visible to the current administrator or agent principal.",
  request: { query: pageQuerySchema.extend({
    status: z.enum(["pending", "active", "revoked", "expired"]).optional(),
    resource: resourceSchema.optional(),
    kind: z.enum(["oauth", "pat", "cli"]).optional(),
  }) },
  responses: { 200: { description: "Agent connections", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(listConnectionsRoute, async (c) => {
  const principal = c.get("agentPrincipal");
  return ok(c, await listAgentConnections(c.get("db"), {
    ...c.req.valid("query"),
    ...getAgentConnectionListScope(principal),
  }));
});

const getConnectionRoute = createRoute({
  method: "get", path: "/connections/{grantId}", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.connections.get",
  summary: "Get an agent connection",
  description: "Returns one safe agent grant projection without exposing bearer credentials.",
  request: { params: z.object({ grantId: z.string() }) },
  responses: { 200: { description: "Agent connection", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(getConnectionRoute, async (c) => {
  const connection = await getAgentConnection(c.get("db"), c.req.valid("param").grantId);
  assertAgentConnectionScope(connection, c.get("agentPrincipal"));
  return ok(c, { connection });
});

const listEventsRoute = createRoute({
  method: "get", path: "/connections/{grantId}/events", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.connections.events_list",
  summary: "List agent connection audit events",
  description: "Lists bounded, redacted audit events for one agent grant.",
  request: { params: z.object({ grantId: z.string() }), query: pageQuerySchema },
  responses: { 200: { description: "Safe agent audit events", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(listEventsRoute, async (c) => {
  const query = c.req.valid("query");
  const grantId = c.req.valid("param").grantId;
  const connection = await getAgentConnection(c.get("db"), grantId);
  assertAgentConnectionScope(connection, c.get("agentPrincipal"));
  return ok(c, await listAgentAuditEvents(c.get("db"), grantId, query.page, query.limit));
});

const createTokenRoute = createRoute({
  method: "post", path: "/tokens", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.tokens.create",
  summary: "Create an agent personal access token",
  description: "Creates a scoped subordinate grant and returns its bearer token exactly once.",
  request: { body: { required: true, content: { "application/json": { schema: tokenBodySchema } } } },
  responses: { 201: { description: "PAT created; token is shown once", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(createTokenRoute, async (c) => {
  const principal = c.get("agentPrincipal");
  const user = assertSuperAdmin(c);
  const body = c.req.valid("json");
  if (principal && body.resource !== principal.resource) {
    throw new ForbiddenError("An agent can create connections only for its own resource");
  }
  const selection = resolveGrantSelection(
    body,
    principal?.permissions ?? c.get("adminPermissions"),
    "pat",
  );
  assertSubordinateGrantSelection(selection, principal);
  const credentialId = `agc_${nanoid(20)}`;
  const issued = await issueAgentCredential("pat", credentialId, requirePepper(c.env));
  const result = await createCredentialGrant(c.get("db"), {
    ownerUserId: user.id,
    kind: "pat",
    selection,
    issued,
    ...(principal ? {
      parentAuthority: {
        grantId: principal.grantId,
        credentialId: principal.credentialId,
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        authorityRevision: principal.authorityRevision,
      },
    } : {}),
  });
  noStore(c);
  return created(c, {
    connection: await getAgentConnection(c.get("db"), result.grantId),
    token: issued.token,
  });
});

const rotateRoute = createRoute({
  method: "post", path: "/tokens/{credentialId}/rotate", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.tokens.rotate",
  summary: "Rotate an agent credential",
  description: "Atomically replaces an active credential and returns the replacement bearer token exactly once.",
  request: {
    params: z.object({ credentialId: z.string() }),
    body: { required: true, content: { "application/json": { schema: z.object({ expiresInDays: z.number().int().min(1).max(365).optional() }).strict() } } },
  },
  responses: { 200: { description: "Credential rotated; token is shown once", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(rotateRoute, async (c) => {
  const principal = c.get("agentPrincipal");
  if (principal) {
    if (!principal.credentialId || principal.credentialId !== c.req.valid("param").credentialId) {
      throw new NotFoundError("Active credential not found");
    }
  }
  assertSuperAdmin(c);
  const current = await getActiveAgentCredentialForRotation(
    c.get("db"),
    c.req.valid("param").credentialId,
  );
  if (principal && current.grantId !== principal.grantId) {
    throw new NotFoundError("Active credential not found");
  }
  const credentialId = `agc_${nanoid(20)}`;
  const issued = await issueAgentCredential(current.kind, credentialId, requirePepper(c.env));
  const requestedDays = c.req.valid("json").expiresInDays;
  const requestedExpiry = requestedDays
    ? new Date(Date.now() + requestedDays * 86_400_000)
    : current.grantExpiresAt;
  const expiresAt = requestedExpiry < current.grantExpiresAt
    ? requestedExpiry
    : current.grantExpiresAt;
  const result = await rotateAgentCredential(c.get("db"), {
    credentialId: c.req.valid("param").credentialId,
    newCredentialId: credentialId,
    tokenHash: issued.tokenHash,
    tokenHint: issued.tokenHint,
    expiresAt,
  });
  noStore(c);
  return ok(c, {
    connection: await getAgentConnection(c.get("db"), result.grantId),
    credentialId,
    token: issued.token,
  });
});

const updateGrantRoute = createRoute({
  method: "patch", path: "/grants/{grantId}", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.grants.update",
  summary: "Narrow an agent grant",
  description: "Narrows a grant's label, permissions, risk ceiling, or expiry; widening requires new approval.",
  request: {
    params: z.object({ grantId: z.string() }),
    body: { required: true, content: { "application/json": { schema: z.object({
      label: z.string().trim().min(1).max(120).optional(),
      permissions: z.array(z.string().min(1).max(160)).max(256).optional(),
      riskCeiling: riskSchema.optional(),
      expiresAt: z.string().datetime().optional(),
    }).strict() } } },
  },
  responses: { 200: { description: "Connection narrowed", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses, 409: { description: "Widening requires new approval" } },
});
app.openapi(updateGrantRoute, async (c) => {
  const principal = c.get("agentPrincipal");
  if (principal) {
    if (principal.grantId !== c.req.valid("param").grantId) {
      throw new NotFoundError("Active agent connection not found");
    }
  }
  assertSuperAdmin(c);
  const body = c.req.valid("json");
  const connection = await updateAgentGrant(c.get("db"), c.req.valid("param").grantId, {
    ...body,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
  });
  return ok(c, { connection });
});

const revokeGrantRoute = createRoute({
  method: "delete", path: "/grants/{grantId}", tags: ["Admin - Agent Access"],
  operationId: "dashboard.agent_access.grants.revoke",
  summary: "Revoke an agent grant",
  description: "Revokes one active agent grant and its effective credentials.",
  request: {
    params: z.object({ grantId: z.string() }),
    body: { required: true, content: { "application/json": { schema: z.object({ reason: z.string().trim().max(240).optional() }).strict() } } },
  },
  responses: { 200: { description: "Connection revoked", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(revokeGrantRoute, async (c) => {
  const principal = c.get("agentPrincipal");
  if (principal) {
    if (principal.grantId !== c.req.valid("param").grantId) {
      throw new NotFoundError("Active agent connection not found");
    }
  }
  const user = assertSuperAdmin(c);
  return ok(c, await revokeAgentGrant(c.get("db"), c.req.valid("param").grantId, user.id, c.req.valid("json")?.reason));
});

const revokeAllRoute = createRoute({
  method: "post", path: "/revoke-all", tags: ["Admin - Agent Access"],
  summary: "Revoke all agent grants",
  description: "Emergency browser-only ceremony that revokes all matching agent grants.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ resource: resourceSchema.optional(), reason: z.string().trim().max(240).optional() }).strict() } } } },
  responses: { 200: { description: "Connections revoked", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(revokeAllRoute, async (c) => {
  const user = assertSuperAdmin(c);
  const body = c.req.valid("json");
  return ok(c, await revokeAllAgentGrants(c.get("db"), user.id, body.resource, body.reason));
});

const getAuthorizationRoute = createRoute({
  method: "get", path: "/authorization-requests/{requestId}", tags: ["Admin - Agent Access"],
  summary: "Review an OAuth authorization request",
  description: "Returns the bounded safe details needed for a human OAuth consent decision.",
  request: { params: z.object({ requestId: z.string() }) },
  responses: { 200: { description: "Safe OAuth request", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(getAuthorizationRoute, async (c) => ok(c, { authorizationRequest: await getAuthorizationRequest(c.get("db"), c.req.valid("param").requestId) }));

const approveAuthorizationRoute = createRoute({
  method: "post", path: "/authorization-requests/{requestId}/approve", tags: ["Admin - Agent Access"],
  summary: "Approve an OAuth authorization request",
  description: "Human-only consent ceremony that creates the selected grant and completes OAuth authorization.",
  request: { params: z.object({ requestId: z.string() }), body: { required: true, content: { "application/json": { schema: selectionBodySchema } } } },
  responses: { 200: { description: "OAuth request approved", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(approveAuthorizationRoute, async (c) => {
  const user = assertSuperAdmin(c);
  const requestId = c.req.valid("param").requestId;
  const request = await getAuthorizationRequest(c.get("db"), requestId);
  const selection = resolveGrantSelection({ ...c.req.valid("json"), resource: request.resource }, c.get("adminPermissions"), "oauth");
  const approval = await approveAuthorizationRequest(c.get("db"), { requestId, actorUserId: user.id, selection });
  return ok(c, {
    ...approval,
    completionUrl: getOAuthCompletionUrl(requestId, c.env),
  });
});

const denyAuthorizationRoute = createRoute({
  method: "post", path: "/authorization-requests/{requestId}/deny", tags: ["Admin - Agent Access"],
  summary: "Deny an OAuth authorization request",
  description: "Human-only consent ceremony that denies a pending OAuth authorization request.",
  request: { params: z.object({ requestId: z.string() }), body: { required: true, content: { "application/json": { schema: z.object({ reason: z.string().max(240).optional() }).strict() } } } },
  responses: { 200: { description: "OAuth request denied", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(denyAuthorizationRoute, async (c) => {
  const user = assertSuperAdmin(c);
  const requestId = c.req.valid("param").requestId;
  return ok(c, {
    ...await denyAuthorizationRequest(c.get("db"), requestId, user.id),
    completionUrl: getOAuthCompletionUrl(requestId, c.env),
  });
});

const lookupDeviceRoute = createRoute({
  method: "post", path: "/device-authorizations/lookup", tags: ["Admin - Agent Access"],
  summary: "Look up a CLI device pairing",
  description: "Looks up a short-lived pairing request by the human-entered user code without exposing its device credential.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ userCode: z.string().trim().min(8).max(12) }).strict() } } } },
  responses: { 200: { description: "Safe device authorization", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(lookupDeviceRoute, async (c) => {
  assertSuperAdmin(c);
  const hmac = await hmacAgentOpaqueValue("device-user-code", c.req.valid("json").userCode.toUpperCase(), requirePepper(c.env));
  const row = await getDeviceAuthorizationByUserCodeHmac(c.get("db"), hmac);
  const status = row.expiresAt <= new Date()
    ? "expired"
    : row.status === "consumed"
      ? "acknowledged"
      : row.status;
  return ok(c, { deviceAuthorization: {
    id: row.id,
    clientName: row.clientName,
    profileName: row.profileName,
    resource: row.requestedResource,
    status,
    expiresAt: row.expiresAt,
  } });
});

const approveDeviceRoute = createRoute({
  method: "post", path: "/device-authorizations/{deviceId}/approve", tags: ["Admin - Agent Access"],
  summary: "Approve a CLI device pairing",
  description: "Human-only ceremony that approves a scoped CLI grant and prepares one-time credential delivery.",
  request: { params: z.object({ deviceId: z.string() }), body: { required: true, content: { "application/json": { schema: selectionBodySchema } } } },
  responses: { 200: { description: "Device approved", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(approveDeviceRoute, async (c) => {
  const user = assertSuperAdmin(c);
  const device = await c.get("db").query.agentDeviceAuthorizations.findFirst({ where: (table, { eq }) => eq(table.id, c.req.valid("param").deviceId) });
  if (!device) throw new ConflictError("Device authorization is unavailable");
  const selection = resolveGrantSelection({ ...c.req.valid("json"), resource: device.requestedResource }, c.get("adminPermissions"), "cli");
  const credentialId = `agc_${nanoid(20)}`;
  const issued = await issueAgentCredential("cli", credentialId, requirePepper(c.env));
  const envelope = encodeEncryptedCredential(await encryptCredentials(issued.token, requireEncryptionKey(c.env)));
  return ok(c, await approveDeviceAuthorization(c.get("db"), {
    deviceId: device.id,
    actorUserId: user.id,
    selection,
    credentialId,
    tokenHash: issued.tokenHash,
    tokenHint: issued.tokenHint,
    encryptedDeliveryEnvelope: envelope,
  }));
});

const denyDeviceRoute = createRoute({
  method: "post", path: "/device-authorizations/{deviceId}/deny", tags: ["Admin - Agent Access"],
  summary: "Deny a CLI device pairing",
  description: "Human-only ceremony that denies a pending CLI pairing request.",
  request: { params: z.object({ deviceId: z.string() }), body: { required: true, content: { "application/json": { schema: z.object({ reason: z.string().max(240).optional() }).strict() } } } },
  responses: { 200: { description: "Device denied", content: { "application/json": { schema: passthroughResponse } } }, ...errorResponses },
});
app.openapi(denyDeviceRoute, async (c) => {
  const user = assertSuperAdmin(c);
  return ok(c, await denyDeviceAuthorization(c.get("db"), c.req.valid("param").deviceId, user.id));
});

const browserHandoffParams = z.object({
  handoffId: z.string().regex(/^abh_[A-Za-z0-9_-]{20}$/),
});
const openBrowserHandoffRoute = createRoute({
  method: "get",
  path: "/browser-handoffs/{handoffId}",
  operationId: "dashboard.agent_access.browser_handoff.open",
  tags: ["Admin - Agent Access"],
  summary: "Open a secure agent browser handoff",
  description: "Browser-only page for a one-use continuation bound to the same 2FA-verified administrator.",
  request: { params: browserHandoffParams },
  responses: {
    200: { description: "Private browser handoff page", content: { "text/html": { schema: z.string() } } },
    ...errorResponses,
  },
});
app.openapi(openBrowserHandoffRoute, async (c) => {
  assertBrowserHandoffSession(c);
  return browserHandoffPage();
});

const claimBrowserHandoffRoute = createRoute({
  method: "post",
  path: "/browser-handoffs/{handoffId}",
  operationId: "dashboard.agent_access.browser_handoff.claim",
  tags: ["Admin - Agent Access"],
  summary: "Claim a secure agent browser handoff",
  description: "Browser-only one-use claim; sensitive POST fields remain inside the authenticated browser.",
  request: { params: browserHandoffParams },
  responses: {
    200: {
      description: "Private browser action",
      content: { "application/json": { schema: successEnvelope(z.object({
        action: z.object({
          url: z.url().max(512),
          method: z.literal("POST"),
          fields: z.record(z.string(), z.string().max(512)),
        }),
      })) } },
    },
    ...errorResponses,
  },
});
app.openapi(claimBrowserHandoffRoute, async (c) => {
  const ownerUserId = assertBrowserHandoffSession(c);
  const claimed = await claimAgentBrowserHandoff(
    c.get("db"),
    c.req.valid("param").handoffId,
    ownerUserId,
    c.env,
  );
  if (!claimed) throw new NotFoundError("This secure browser handoff is unavailable or expired");
  const principal = await resolveAgentPrincipalFromGrant(c.get("db"), {
    grantId: claimed.grantId,
    credentialId: claimed.credentialId,
    resource: claimed.resource,
  });
  const operation = resolveAgentOperationById(claimed.operationId);
  if (
    !principal ||
    principal.ownerUserId !== ownerUserId ||
    principal.authorityRevision !== claimed.authorityRevision ||
    !operation ||
    operation.surface !== claimed.resource ||
    operation.exposure !== "continuation" ||
    operation.sensitiveOutput !== true ||
    !await (await loadAgentAccessBackend()).authorizeOperation(principal, operation, c.env)
  ) {
    throw new ForbiddenError("This secure browser handoff is no longer authorized");
  }
  noStore(c);
  return ok(c, { action: claimed.action });
});

export const adminAgentAccessRoutes = app;
