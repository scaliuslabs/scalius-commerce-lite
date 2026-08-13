import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  agentCredentials,
  agentDeviceAuthorizations,
  agentGrants,
} from "@scalius/database/schema";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ServiceUnavailableError, UnauthorizedError, ValidationError } from "../utils/api-error";
import { getBearerToken, hmacAgentOpaqueValue, parseAgentCredential } from "../agent-access/pat";
import { resolveAgentPrincipalFromBearer } from "../agent-access/principal";
import { enforceAgentRateLimit } from "../middleware/agent-request-boundary";
import { writeAgentAuditEvent } from "../agent-access/audit";

const app = new OpenAPIHono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  try {
    await next();
  } finally {
    c.header("Cache-Control", "private, no-store");
  }
});
const DEVICE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function noStore(c: { header(name: string, value: string): void }) {
  c.header("Cache-Control", "private, no-store");
}

function requirePepper(env: Env): string {
  const pepper = env.AGENT_TOKEN_PEPPER?.trim();
  if (!pepper) throw new ValidationError("Agent pairing is not configured");
  return pepper;
}

function requireEncryptionKey(env: Env): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!key) throw new ValidationError("Agent pairing is not configured");
  return key;
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomUserCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(random, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

function verificationUri(env: Env): string {
  const configured = env.BETTER_AUTH_URL?.trim();
  if (!configured) throw new ValidationError("Dashboard pairing URL is not configured");
  return `${new URL(configured).origin}/connect`;
}

async function enforceUnauthenticatedAuthRate(c: { env: Env; req: { header(name: string): string | undefined } }, endpoint: string) {
  const limiter = c.env.AGENT_RATE_LIMITER;
  if (!limiter) throw new ServiceUnavailableError("Agent authentication rate limiting is unavailable");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const result = await limiter.limit({ key: `agent-auth:${endpoint}:${ip}` });
  if (!result.success) throw new RateLimitError("Agent authentication rate limit exceeded");
}

const startRoute = createRoute({
  method: "post", path: "/device/start", tags: ["Agent Authentication"],
  operationId: "system.agent_auth.device_start",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    clientName: z.string().trim().min(1).max(80),
    profileName: z.string().trim().min(1).max(80).optional(),
  }).strict() } } } },
  responses: { 200: { description: "Pairing started", content: { "application/json": { schema: z.object({
    deviceCode: z.string(), userCode: z.string(), verificationUri: z.string().url(),
    intervalSeconds: z.number(), expiresInSeconds: z.number(),
  }) } } } },
});
app.openapi(startRoute, async (c) => {
  await enforceUnauthenticatedAuthRate(c, "device-start");
  const body = c.req.valid("json");
  const deviceCode = randomBase64Url(32);
  const userCode = randomUserCode();
  const pepper = requirePepper(c.env);
  const now = new Date();
  await c.get("db").insert(agentDeviceAuthorizations).values({
    id: `ada_${nanoid(20)}`,
    deviceCodeHash: await hmacAgentOpaqueValue("device-code", deviceCode, pepper),
    userCodeHmac: await hmacAgentOpaqueValue("device-user-code", userCode, pepper),
    clientName: body.clientName,
    profileName: body.profileName ?? null,
    requestedResource: "dashboard",
    requestedPreset: "full",
    requestedPermissionsJson: "[]",
    status: "pending",
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    expiresAt: new Date(now.getTime() + DEVICE_TTL_SECONDS * 1000),
    createdAt: now,
    updatedAt: now,
  });
  noStore(c);
  return c.json({
    deviceCode,
    userCode,
    verificationUri: verificationUri(c.env),
    intervalSeconds: POLL_INTERVAL_SECONDS,
    expiresInSeconds: DEVICE_TTL_SECONDS,
  });
});

const deviceCodeBody = z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const tokenRoute = createRoute({
  method: "post", path: "/device/token", tags: ["Agent Authentication"],
  operationId: "system.agent_auth.device_token",
  request: { body: { required: true, content: { "application/json": { schema: deviceCodeBody } } } },
  responses: {
    200: { description: "Credential delivered", content: { "application/json": { schema: z.object({ status: z.literal("approved"), token: z.string(), credentialId: z.string(), expiresAt: z.string() }) } } },
    202: { description: "Approval pending", content: { "application/json": { schema: z.object({ status: z.literal("pending"), intervalSeconds: z.number() }) } } },
    400: { description: "Pairing denied" },
    410: { description: "Pairing expired" },
    429: { description: "Polling too quickly" },
  },
});
app.openapi(tokenRoute, async (c) => {
  await enforceUnauthenticatedAuthRate(c, "device-token");
  const now = new Date();
  const hash = await hmacAgentOpaqueValue("device-code", c.req.valid("json").deviceCode, requirePepper(c.env));
  const device = await c.get("db").select().from(agentDeviceAuthorizations)
    .where(eq(agentDeviceAuthorizations.deviceCodeHash, hash)).get();
  if (!device) throw new NotFoundError("Pairing request not found");

  if (device.expiresAt <= now || device.status === "expired") {
    if (device.status === "approved" && device.grantId && device.credentialId) {
      await c.get("db").batch([
        c.get("db").update(agentCredentials).set({ revokedAt: now, updatedAt: now }).where(eq(agentCredentials.id, device.credentialId)),
        c.get("db").update(agentGrants).set({ status: "revoked", revokedAt: now, revokedReason: "Unacknowledged CLI pairing expired", updatedAt: now }).where(eq(agentGrants.id, device.grantId)),
        c.get("db").update(agentDeviceAuthorizations).set({ status: "expired", grantId: null, credentialId: null, encryptedDeliveryEnvelope: null, decidedAt: now, updatedAt: now }).where(eq(agentDeviceAuthorizations.id, device.id)),
      ]);
    } else if (device.status === "pending") {
      await c.get("db").update(agentDeviceAuthorizations).set({ status: "expired", decidedAt: now, updatedAt: now }).where(eq(agentDeviceAuthorizations.id, device.id));
    }
    return c.json({ code: "pairing_expired", message: "Dashboard pairing expired" }, 410);
  }
  if (device.status === "denied") {
    return c.json({ code: "pairing_denied", message: "Dashboard pairing was denied" }, 400);
  }
  if (device.status === "consumed") {
    return c.json({ code: "pairing_consumed", message: "Dashboard pairing was already consumed" }, 400);
  }
  if (device.status === "pending") {
    if (device.lastPolledAt && now.getTime() - device.lastPolledAt.getTime() < device.pollIntervalSeconds * 1000) {
      throw new RateLimitError("Polling too quickly");
    }
    await c.get("db").update(agentDeviceAuthorizations).set({ lastPolledAt: now, updatedAt: now }).where(and(
      eq(agentDeviceAuthorizations.id, device.id),
      eq(agentDeviceAuthorizations.status, "pending"),
    ));
    noStore(c);
    return c.json({ status: "pending" as const, intervalSeconds: device.pollIntervalSeconds }, 202);
  }
  if (!device.credentialId || !device.encryptedDeliveryEnvelope) {
    throw new ConflictError("Approved pairing has no deliverable credential");
  }
  const credential = await c.get("db").select({ expiresAt: agentCredentials.expiresAt })
    .from(agentCredentials).where(and(
      eq(agentCredentials.id, device.credentialId),
      isNull(agentCredentials.revokedAt),
      gt(agentCredentials.expiresAt, now),
    )).get();
  if (!credential) throw new UnauthorizedError("Paired credential is no longer active");
  const decrypted = await readStoredCredentialStrict(
    device.encryptedDeliveryEnvelope,
    requireEncryptionKey(c.env),
    "CLI pairing envelope",
  );
  if (decrypted.error || !decrypted.value) throw new ConflictError(decrypted.error ?? "CLI pairing envelope is unreadable");
  noStore(c);
  return c.json({
    status: "approved" as const,
    token: decrypted.value,
    credentialId: device.credentialId,
    expiresAt: credential.expiresAt.toISOString(),
  });
});

const ackRoute = createRoute({
  method: "post", path: "/device/ack", tags: ["Agent Authentication"],
  operationId: "system.agent_auth.device_ack",
  request: { body: { required: true, content: { "application/json": { schema: deviceCodeBody } } } },
  responses: { 200: { description: "Credential acknowledged", content: { "application/json": { schema: z.object({ status: z.literal("acknowledged") }) } } } },
});
app.openapi(ackRoute, async (c) => {
  await enforceUnauthenticatedAuthRate(c, "device-ack");
  const hash = await hmacAgentOpaqueValue("device-code", c.req.valid("json").deviceCode, requirePepper(c.env));
  const now = new Date();
  const existing = await c.get("db").select({
    id: agentDeviceAuthorizations.id,
    status: agentDeviceAuthorizations.status,
    expiresAt: agentDeviceAuthorizations.expiresAt,
  }).from(agentDeviceAuthorizations).where(eq(agentDeviceAuthorizations.deviceCodeHash, hash)).get();
  if (existing?.status === "consumed" && existing.expiresAt > now) {
    noStore(c);
    return c.json({ status: "acknowledged" as const });
  }
  const updated = await c.get("db").update(agentDeviceAuthorizations).set({
    status: "consumed",
    encryptedDeliveryEnvelope: null,
    acknowledgedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentDeviceAuthorizations.deviceCodeHash, hash),
    eq(agentDeviceAuthorizations.status, "approved"),
    gt(agentDeviceAuthorizations.expiresAt, now),
  )).returning({ id: agentDeviceAuthorizations.id });
  if (!updated[0]) throw new ConflictError("Pairing is not ready for acknowledgement");
  noStore(c);
  return c.json({ status: "acknowledged" as const });
});

const revokeRoute = createRoute({
  method: "post", path: "/revoke", tags: ["Agent Authentication"],
  operationId: "system.agent_auth.revoke",
  request: { body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: { 200: { description: "Current connection revoked", content: { "application/json": { schema: z.object({ status: z.literal("revoked") }) } } } },
});
app.openapi(revokeRoute, async (c) => {
  if (c.req.header("Cookie")?.trim()) {
    throw new ForbiddenError("Cookie and agent credentials cannot be combined");
  }
  const token = getBearerToken(c.req.header("Authorization"));
  if (!token || !parseAgentCredential(token)) throw new UnauthorizedError("A current agent credential is required");
  const principal = await resolveAgentPrincipalFromBearer(c.get("db"), token, c.env.AGENT_TOKEN_PEPPER);
  if (!principal?.credentialId) throw new UnauthorizedError("Agent credential is invalid, expired, or revoked");
  await enforceAgentRateLimit(c, principal);
  const now = new Date();
  await c.get("db").batch([
    c.get("db").update(agentCredentials).set({ revokedAt: now, updatedAt: now }).where(and(eq(agentCredentials.id, principal.credentialId), isNull(agentCredentials.revokedAt))),
    c.get("db").update(agentGrants).set({ status: "revoked", revokedAt: now, revokedReason: "Revoked by credential owner", updatedAt: now }).where(and(eq(agentGrants.id, principal.grantId), eq(agentGrants.status, "active"))),
  ]);
  try {
    await writeAgentAuditEvent(c.get("db"), {
      grantId: principal.grantId,
      credentialId: principal.credentialId,
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
      operationId: "system.agent_auth.revoke",
      risk: "security",
      outcome: "success",
      httpStatus: 200,
      requestId: c.req.header("X-Request-Id") ?? null,
    });
  } catch {
    // Revocation is authoritative even if its safe audit write is unavailable.
  }
  noStore(c);
  return c.json({ status: "revoked" as const });
});

export const agentAuthRoutes = app;
