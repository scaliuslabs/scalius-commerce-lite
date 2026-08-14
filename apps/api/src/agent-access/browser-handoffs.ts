import { nanoid } from "nanoid";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, safeBatch } from "@scalius/database/client";
import { agentBrowserHandoffs } from "@scalius/database/schema";
import {
  decryptCredentials,
  encodeEncryptedCredential,
  encryptCredentials,
} from "@scalius/core/utils/credential-encryption";
import type { AgentPrincipal } from "./types";

const HANDOFF_TTL_MS = 5 * 60 * 1000;
const MAX_ACTION_BYTES = 4_096;
const CLEANUP_PAGE_SIZE = 2_000;
const DELETE_CHUNK_SIZE = 90;

export interface AgentBrowserAction {
  url: string;
  method: "POST";
  fields: Record<string, string>;
}

function requireEncryptionKey(env: Env): string {
  const key = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!key) throw new Error("Agent browser handoff encryption is unavailable");
  return key;
}

function apiOrigin(env: Env): string {
  const value = env.PUBLIC_API_BASE_URL?.trim();
  if (!value) throw new Error("PUBLIC_API_BASE_URL is required for agent browser handoffs");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("PUBLIC_API_BASE_URL must be HTTPS outside localhost");
  }
  return url.origin;
}

function storefrontOrigin(env: Env): string {
  const value = env.STOREFRONT_URL?.trim();
  if (!value) throw new Error("STOREFRONT_URL is required for agent browser handoffs");
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.hostname !== "localhost") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("STOREFRONT_URL must be a safe origin");
  }
  return url.origin;
}

function validateAction(action: AgentBrowserAction, env: Env): string {
  const url = new URL(action.url);
  if (
    action.method !== "POST" ||
    url.protocol !== "https:" ||
    url.origin !== storefrontOrigin(env) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    Object.keys(action.fields).length < 1 ||
    Object.keys(action.fields).length > 12 ||
    Object.entries(action.fields).some(([name, value]) => (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ||
      typeof value !== "string" ||
      value.length > 512
    ))
  ) {
    throw new Error("Agent browser action is invalid");
  }
  const serialized = JSON.stringify(action);
  if (new TextEncoder().encode(serialized).byteLength > MAX_ACTION_BYTES) {
    throw new Error("Agent browser action is too large");
  }
  return serialized;
}

export async function createAgentBrowserHandoff(
  db: Database,
  principal: AgentPrincipal,
  operationId: string,
  action: AgentBrowserAction,
  env: Env,
): Promise<{ handoffId: string; url: string; expiresAt: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS);
  const serialized = validateAction(action, env);
  const encryptedAction = encodeEncryptedCredential(await encryptCredentials(
    serialized,
    requireEncryptionKey(env),
  ));
  const handoffId = `abh_${nanoid(20)}`;
  const credentialGuard = principal.credentialId === null
    ? sql`EXISTS (
        SELECT 1 FROM agent_grants
        WHERE id = ${principal.grantId}
          AND kind = 'oauth'
          AND owner_user_id = ${principal.ownerUserId}
          AND resource = ${principal.resource}
          AND authority_revision = ${principal.authorityRevision}
          AND status = 'active'
          AND expires_at > unixepoch()
      )`
    : sql`EXISTS (
        SELECT 1 FROM agent_grants
        INNER JOIN agent_credentials
          ON agent_credentials.grant_id = agent_grants.id
        WHERE agent_grants.id = ${principal.grantId}
          AND agent_credentials.id = ${principal.credentialId}
          AND agent_grants.kind IN ('pat', 'cli')
          AND agent_grants.owner_user_id = ${principal.ownerUserId}
          AND agent_grants.resource = ${principal.resource}
          AND agent_grants.authority_revision = ${principal.authorityRevision}
          AND agent_grants.status = 'active'
          AND agent_grants.expires_at > unixepoch()
          AND agent_credentials.revoked_at IS NULL
          AND agent_credentials.expires_at > unixepoch()
      )`;
  await safeBatch(db, [
    buildBatchGuard(db, credentialGuard, "AGENT_BROWSER_HANDOFF_AUTHORITY_INACTIVE"),
    db.insert(agentBrowserHandoffs).values({
      id: handoffId,
      grantId: principal.grantId,
      credentialId: principal.credentialId,
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
      operationId,
      authorityRevision: principal.authorityRevision,
      encryptedAction,
      status: "active",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return {
    handoffId,
    url: `${apiOrigin(env)}/api/v1/admin/agent-access/browser-handoffs/${handoffId}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function claimAgentBrowserHandoff(
  db: Database,
  handoffId: string,
  ownerUserId: string,
  env: Env,
): Promise<{
  action: AgentBrowserAction;
  grantId: string;
  credentialId: string | null;
  resource: "dashboard" | "storefront";
  operationId: string;
  authorityRevision: number;
} | null> {
  const now = new Date();
  const candidate = await db.select({
    grantId: agentBrowserHandoffs.grantId,
    credentialId: agentBrowserHandoffs.credentialId,
    resource: agentBrowserHandoffs.resource,
    operationId: agentBrowserHandoffs.operationId,
    authorityRevision: agentBrowserHandoffs.authorityRevision,
    encryptedAction: agentBrowserHandoffs.encryptedAction,
  }).from(agentBrowserHandoffs).where(and(
    eq(agentBrowserHandoffs.id, handoffId),
    eq(agentBrowserHandoffs.ownerUserId, ownerUserId),
    eq(agentBrowserHandoffs.status, "active"),
    gt(agentBrowserHandoffs.expiresAt, now),
  )).get();
  if (!candidate) return null;

  const authorityGuard = candidate.credentialId === null
    ? sql`EXISTS (
        SELECT 1 FROM agent_grants
        WHERE id = ${candidate.grantId}
          AND kind = 'oauth'
          AND owner_user_id = ${ownerUserId}
          AND resource = ${candidate.resource}
          AND authority_revision = ${candidate.authorityRevision}
          AND status = 'active'
          AND expires_at > unixepoch()
      )`
    : sql`EXISTS (
        SELECT 1 FROM agent_grants
        INNER JOIN agent_credentials
          ON agent_credentials.grant_id = agent_grants.id
        WHERE agent_grants.id = ${candidate.grantId}
          AND agent_credentials.id = ${candidate.credentialId}
          AND agent_grants.kind IN ('pat', 'cli')
          AND agent_grants.owner_user_id = ${ownerUserId}
          AND agent_grants.resource = ${candidate.resource}
          AND agent_grants.authority_revision = ${candidate.authorityRevision}
          AND agent_grants.status = 'active'
          AND agent_grants.expires_at > unixepoch()
          AND agent_credentials.revoked_at IS NULL
          AND agent_credentials.expires_at > unixepoch()
      )`;
  const claimed = await db.update(agentBrowserHandoffs).set({
    status: "consumed",
    consumedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentBrowserHandoffs.id, handoffId),
    eq(agentBrowserHandoffs.ownerUserId, ownerUserId),
    eq(agentBrowserHandoffs.status, "active"),
    gt(agentBrowserHandoffs.expiresAt, now),
    authorityGuard,
  )).returning({ id: agentBrowserHandoffs.id });
  if (claimed.length !== 1) return null;

  const encrypted = candidate.encryptedAction.startsWith("enc:")
    ? candidate.encryptedAction.slice(4)
    : candidate.encryptedAction;
  const action = JSON.parse(await decryptCredentials(
    encrypted,
    requireEncryptionKey(env),
  )) as AgentBrowserAction;
  validateAction(action, env);
  return { ...candidate, action };
}

export async function expireAgentBrowserHandoffs(db: Database): Promise<number> {
  const now = new Date();
  const expired = await db.select({ id: agentBrowserHandoffs.id })
    .from(agentBrowserHandoffs)
    .where(
    lte(agentBrowserHandoffs.expiresAt, now),
    )
    .orderBy(asc(agentBrowserHandoffs.expiresAt), asc(agentBrowserHandoffs.id))
    .limit(CLEANUP_PAGE_SIZE);
  for (let index = 0; index < expired.length; index += DELETE_CHUNK_SIZE) {
    await db.delete(agentBrowserHandoffs).where(inArray(
      agentBrowserHandoffs.id,
      expired.slice(index, index + DELETE_CHUNK_SIZE).map(({ id }) => id),
    ));
  }
  return expired.length;
}
