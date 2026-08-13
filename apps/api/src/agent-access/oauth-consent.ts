import { nanoid } from "nanoid";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { agentAuthorizationRequests, agentGrants } from "@scalius/database/schema";
import { getDb } from "@scalius/database/client";
import {
  encodeEncryptedCredential,
  encryptCredentials,
  readStoredCredentialStrict,
} from "@scalius/core/utils/credential-encryption";
import { buildBatchGuard, safeBatch } from "@scalius/database/client";
import { hmacAgentOpaqueValue } from "./pat";
import { resolveAgentPrincipalFromGrant } from "./principal";
import type {
  AgentOAuthProps,
  AgentResource,
  ClaimedAuthorizationCompletion,
  CompletedAuthorization,
  PendingAuthorization,
  ValidatedAuthorizationRequest,
} from "./types";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const COMPLETION_CLAIM_TTL_MS = 60 * 1000;

function getResourceFromCanonicalUrl(value: string, env: Env): AgentResource {
  const configuredOrigin = env.PUBLIC_API_BASE_URL?.trim();
  if (!configuredOrigin) throw new Error("PUBLIC_API_BASE_URL is required for OAuth authorization");
  const origin = new URL(configuredOrigin).origin;
  if (value === `${origin}/api/v1/mcp/dashboard`) return "dashboard";
  if (value === `${origin}/api/v1/mcp/storefront`) return "storefront";
  throw new Error("OAuth request contains an unsupported protected resource");
}

function getDashboardAuthorizationUrl(requestId: string, env: Env): string {
  const dashboardOrigin = env.BETTER_AUTH_URL?.trim();
  if (!dashboardOrigin) throw new Error("BETTER_AUTH_URL is required for OAuth consent");
  return `${new URL(dashboardOrigin).origin}/admin/settings/agent-access/authorize/${requestId}`;
}

function requireEncryptionKey(env: Env): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required for OAuth consent");
  return key;
}

function requireTokenPepper(env: Env): string {
  const pepper = env.AGENT_TOKEN_PEPPER?.trim();
  if (!pepper) throw new Error("AGENT_TOKEN_PEPPER is required for OAuth completion");
  return pepper;
}

function randomClaimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function beginAgentAuthorization(
  request: ValidatedAuthorizationRequest,
  env: Env,
): Promise<PendingAuthorization> {
  const db = getDb(env);
  const resource = getResourceFromCanonicalUrl(request.resource, env);
  const requestId = `aar_${nanoid(20)}`;
  const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);
  const encryptedRequest = encodeEncryptedCredential(
    await encryptCredentials(JSON.stringify(request), requireEncryptionKey(env)),
  );

  await db.insert(agentAuthorizationRequests).values({
    id: requestId,
    encryptedRequest,
    resource,
    clientId: request.clientId,
    clientName: request.clientName?.slice(0, 160) ?? null,
    redirectUri: request.redirectUri,
    status: "pending",
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    requestId,
    dashboardUrl: getDashboardAuthorizationUrl(requestId, env),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function completeAgentAuthorization(
  requestId: string,
  env: Env,
): Promise<CompletedAuthorization> {
  const db = getDb(env);
  const row = await db
    .select({
      encryptedRequest: agentAuthorizationRequests.encryptedRequest,
      resource: agentAuthorizationRequests.resource,
      grantResource: agentGrants.resource,
      clientName: agentAuthorizationRequests.clientName,
      status: agentAuthorizationRequests.status,
      grantId: agentAuthorizationRequests.grantId,
      expiresAt: agentAuthorizationRequests.expiresAt,
      ownerUserId: agentGrants.ownerUserId,
      permissionsJson: agentGrants.permissionsJson,
      riskCeiling: agentGrants.riskCeiling,
    })
    .from(agentAuthorizationRequests)
    .innerJoin(agentGrants, eq(agentAuthorizationRequests.grantId, agentGrants.id))
    .where(and(
      eq(agentAuthorizationRequests.id, requestId),
      eq(agentAuthorizationRequests.status, "completing"),
      eq(agentGrants.status, "active"),
      gt(agentGrants.expiresAt, new Date()),
    ))
    .get();

  if (
    !row?.grantId ||
    !row.ownerUserId ||
    row.expiresAt <= new Date() ||
    row.resource !== row.grantResource
  ) {
    throw new Error("OAuth authorization request is not approved or has expired");
  }

  const decrypted = await readStoredCredentialStrict(
    row.encryptedRequest,
    requireEncryptionKey(env),
    "OAuth authorization request",
  );
  if (decrypted.error || !decrypted.value) throw new Error(decrypted.error ?? "OAuth request is unreadable");
  const request = JSON.parse(decrypted.value) as ValidatedAuthorizationRequest;
  const principal = await resolveAgentPrincipalFromGrant(db, {
    grantId: row.grantId,
    credentialId: null,
    resource: row.resource as AgentResource,
  });
  if (!principal || principal.ownerUserId !== row.ownerUserId) {
    throw new Error("OAuth authorization owner is no longer eligible");
  }
  const audience = [request.resource];
  const props: AgentOAuthProps = {
    grantId: row.grantId,
    ownerUserId: row.ownerUserId,
    resource: row.resource as AgentResource,
    permissions: [...principal.permissions].sort(),
    riskCeiling: principal.riskCeiling,
    audience,
  };

  return {
    request,
    userId: row.ownerUserId,
    metadata: {
      grantId: row.grantId,
      resource: row.resource as AgentResource,
      clientName: row.clientName,
    },
    scope: ["agent:access"],
    props,
    revokeExistingGrants: false,
  };
}

export async function claimAgentAuthorizationCompletion(
  requestId: string,
  env: Env,
): Promise<ClaimedAuthorizationCompletion> {
  const db = getDb(env);
  const now = new Date();
  const state = await db.select({
    status: agentAuthorizationRequests.status,
    encryptedRequest: agentAuthorizationRequests.encryptedRequest,
    resource: agentAuthorizationRequests.resource,
    expiresAt: agentAuthorizationRequests.expiresAt,
  }).from(agentAuthorizationRequests)
    .where(eq(agentAuthorizationRequests.id, requestId))
    .get();
  if (!state || state.expiresAt <= now) {
    throw new Error("OAuth authorization completion is unavailable");
  }
  const decision = state.status === "approved" || state.status === "completing"
    ? "approved"
    : state.status === "denying"
      ? "denied"
      : null;
  if (!decision) throw new Error("OAuth authorization completion is unavailable");
  const claimToken = randomClaimToken();
  const claimHash = await hmacAgentOpaqueValue(
    "oauth-completion-claim",
    claimToken,
    requireTokenPepper(env),
  );
  const claimExpiresAt = new Date(now.getTime() + COMPLETION_CLAIM_TTL_MS);
  const claimable = decision === "approved"
    ? or(
        eq(agentAuthorizationRequests.status, "approved"),
        and(
          eq(agentAuthorizationRequests.status, "completing"),
          lte(agentAuthorizationRequests.completionClaimExpiresAt, now),
        ),
      )
    : and(
        eq(agentAuthorizationRequests.status, "denying"),
        or(
          isNull(agentAuthorizationRequests.completionClaimHash),
          lte(agentAuthorizationRequests.completionClaimExpiresAt, now),
        ),
      );
  const guard = buildBatchGuard(
    db,
    decision === "approved"
      ? sql`EXISTS (
          SELECT 1 FROM agent_authorization_requests
          WHERE id = ${requestId}
          AND expires_at > unixepoch()
          AND (
            status = 'approved'
            OR (status = 'completing' AND completion_claim_expires_at <= unixepoch())
          )
        )`
      : sql`EXISTS (
          SELECT 1 FROM agent_authorization_requests
          WHERE id = ${requestId}
          AND expires_at > unixepoch()
          AND status = 'denying'
          AND (
            completion_claim_hash IS NULL
            OR completion_claim_expires_at <= unixepoch()
          )
        )`,
    "OAUTH_COMPLETION_NOT_CLAIMABLE",
  );
  await safeBatch(db, [
    guard,
    db.update(agentAuthorizationRequests).set({
      status: decision === "approved" ? "completing" : "denying",
      completionClaimHash: claimHash,
      completionClaimExpiresAt: claimExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(agentAuthorizationRequests.id, requestId),
      gt(agentAuthorizationRequests.expiresAt, now),
      claimable,
    )),
  ]);
  try {
    if (decision === "approved") {
      return {
        kind: "approved",
        claimToken,
        authorization: await completeAgentAuthorization(requestId, env),
      };
    }
    const decrypted = await readStoredCredentialStrict(
      state.encryptedRequest,
      requireEncryptionKey(env),
      "OAuth denied authorization request",
    );
    if (decrypted.error || !decrypted.value) {
      throw new Error(decrypted.error ?? "OAuth denied request is unreadable");
    }
    const request = JSON.parse(decrypted.value) as ValidatedAuthorizationRequest;
    if (getResourceFromCanonicalUrl(request.resource, env) !== state.resource) {
      throw new Error("OAuth denied request resource does not match its audience");
    }
    return { kind: "denied", claimToken, request };
  } catch (error) {
    await releaseAgentAuthorizationCompletion(requestId, claimToken, env).catch(() => undefined);
    throw error;
  }
}

async function claimHashFor(env: Env, claimToken: string): Promise<string> {
  return hmacAgentOpaqueValue(
    "oauth-completion-claim",
    claimToken,
    requireTokenPepper(env),
  );
}

export async function finishAgentAuthorizationCompletion(
  requestId: string,
  claimToken: string,
  env: Env,
): Promise<void> {
  const db = getDb(env);
  const now = new Date();
  const current = await db.select({ status: agentAuthorizationRequests.status })
    .from(agentAuthorizationRequests)
    .where(eq(agentAuthorizationRequests.id, requestId))
    .get();
  const terminalStatus = current?.status === "completing"
    ? "completed"
    : current?.status === "denying"
      ? "denied"
      : null;
  if (!terminalStatus) throw new Error("OAuth completion claim is invalid or expired");
  const updated = await db.update(agentAuthorizationRequests).set({
    status: terminalStatus,
    encryptedRequest: null,
    completionClaimHash: null,
    completionClaimExpiresAt: null,
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentAuthorizationRequests.id, requestId),
    eq(agentAuthorizationRequests.status, current!.status),
    eq(agentAuthorizationRequests.completionClaimHash, await claimHashFor(env, claimToken)),
    gt(agentAuthorizationRequests.completionClaimExpiresAt, now),
  )).returning({ id: agentAuthorizationRequests.id });
  if (!updated[0]) throw new Error("OAuth completion claim is invalid or expired");
}

export async function releaseAgentAuthorizationCompletion(
  requestId: string,
  claimToken: string,
  env: Env,
): Promise<void> {
  const db = getDb(env);
  const now = new Date();
  const current = await db.select({ status: agentAuthorizationRequests.status })
    .from(agentAuthorizationRequests)
    .where(eq(agentAuthorizationRequests.id, requestId))
    .get();
  if (current?.status !== "completing" && current?.status !== "denying") {
    throw new Error("OAuth completion claim is invalid or expired");
  }
  const updated = await db.update(agentAuthorizationRequests).set({
    status: current.status === "completing" ? "approved" : "denying",
    completionClaimHash: null,
    completionClaimExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(agentAuthorizationRequests.id, requestId),
    eq(agentAuthorizationRequests.status, current.status),
    eq(agentAuthorizationRequests.completionClaimHash, await claimHashFor(env, claimToken)),
    gt(agentAuthorizationRequests.completionClaimExpiresAt, now),
  )).returning({ id: agentAuthorizationRequests.id });
  if (!updated[0]) throw new Error("OAuth completion claim is invalid or expired");
}
