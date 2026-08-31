import { nanoid } from "nanoid";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, safeBatch } from "@scalius/database/client";
import { agentArtifactHandles, agentGrants } from "@scalius/database/schema";
import type { AgentPrincipal, AgentResource } from "./types";

const MAX_ARTIFACT_BYTES = 16_777_216;
const ARTIFACT_TTL_MS = 5 * 60 * 1000;
const SAFE_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/json",
  "text/csv",
  "text/html",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

export interface CreateAgentArtifactInput {
  grantId: string;
  credentialId: string | null;
  resource: AgentResource;
  operationId: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  r2Key: string;
  expiresAt?: Date;
}

function canonicalApiOrigin(env: Env): string {
  const value = env.PUBLIC_API_BASE_URL?.trim();
  if (!value) throw new Error("PUBLIC_API_BASE_URL is required for artifact delivery");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("PUBLIC_API_BASE_URL must be HTTPS outside localhost");
  }
  return url.origin;
}

function isSafeArtifactFilename(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e && character !== "/" && character !== "\\";
  });
}

function validateArtifactInput(input: CreateAgentArtifactInput, now: Date) {
  const operationId = input.operationId.trim();
  const r2Key = input.r2Key.trim();
  const mediaType = input.mediaType.trim().toLowerCase();
  const filename = input.filename.trim();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + ARTIFACT_TTL_MS);
  if (!operationId || operationId.length > 240) throw new Error("Artifact operation ID is invalid");
  if (!r2Key || r2Key.length > 240) throw new Error("Artifact object key is invalid");
  if (!SAFE_MEDIA_TYPES.has(mediaType)) throw new Error("Artifact media type is not allowed");
  if (!filename || filename.length > 160 || !isSafeArtifactFilename(filename)) {
    throw new Error("Artifact filename is invalid");
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact size is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("Artifact digest is invalid");
  if (expiresAt <= now || expiresAt.getTime() > now.getTime() + ARTIFACT_TTL_MS) {
    throw new Error("Artifact expiry is invalid");
  }
  return { operationId, r2Key, mediaType, filename, expiresAt };
}

export async function createAgentArtifact(
  db: Database,
  input: CreateAgentArtifactInput,
  env: Env,
): Promise<{ artifactId: string; downloadUrl: string }> {
  const now = new Date();
  const safe = validateArtifactInput(input, now);
  const grant = await db.select({
    kind: agentGrants.kind,
    ownerUserId: agentGrants.ownerUserId,
  }).from(agentGrants).where(and(
    eq(agentGrants.id, input.grantId),
    eq(agentGrants.resource, input.resource),
    eq(agentGrants.status, "active"),
    gt(agentGrants.expiresAt, now),
  )).get();
  if (!grant?.ownerUserId || (grant.kind === "oauth") !== (input.credentialId === null)) {
    throw new Error("Artifact grant binding is invalid");
  }
  const artifactId = `aah_${nanoid(20)}`;
  const guard = buildBatchGuard(
    db,
    input.credentialId === null
      ? sql`EXISTS (
          SELECT 1 FROM agent_grants
          WHERE id = ${input.grantId}
            AND kind = 'oauth'
            AND resource = ${input.resource}
            AND status = 'active'
            AND expires_at > unixepoch()
        )`
      : sql`EXISTS (
          SELECT 1 FROM agent_grants
          INNER JOIN agent_credentials
            ON agent_credentials.grant_id = agent_grants.id
          WHERE agent_grants.id = ${input.grantId}
            AND agent_credentials.id = ${input.credentialId}
            AND agent_grants.kind IN ('pat', 'cli')
            AND agent_grants.resource = ${input.resource}
            AND agent_grants.status = 'active'
            AND agent_grants.expires_at > unixepoch()
            AND agent_credentials.revoked_at IS NULL
            AND agent_credentials.expires_at > unixepoch()
        )`,
    "AGENT_ARTIFACT_AUTHORITY_INACTIVE",
  );
  const insert = db.insert(agentArtifactHandles).values({
    id: artifactId,
    grantId: input.grantId,
    credentialId: input.credentialId,
    resource: input.resource,
    operationId: safe.operationId,
    r2Key: safe.r2Key,
    mediaType: safe.mediaType,
    filename: safe.filename,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    status: "active",
    expiresAt: safe.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  await safeBatch(db, [guard, insert]);
  const downloadPath = input.credentialId === null
    ? `/api/v1/mcp/${input.resource}/artifacts/${artifactId}`
    : `/api/v1/agent-artifacts/${artifactId}`;
  return {
    artifactId,
    downloadUrl: `${canonicalApiOrigin(env)}${downloadPath}`,
  };
}

export async function claimAgentArtifact(
  db: Database,
  artifactId: string,
  principal: AgentPrincipal,
) {
  const now = new Date();
  const claimed = await db.update(agentArtifactHandles).set({
    status: "consumed",
    claimedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentArtifactHandles.id, artifactId),
    eq(agentArtifactHandles.grantId, principal.grantId),
    eq(agentArtifactHandles.resource, principal.resource),
    principal.credentialId === null
      ? isNull(agentArtifactHandles.credentialId)
      : eq(agentArtifactHandles.credentialId, principal.credentialId),
    eq(agentArtifactHandles.status, "active"),
    gt(agentArtifactHandles.expiresAt, now),
    principal.credentialId === null
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
        )`,
  )).returning({
    id: agentArtifactHandles.id,
    operationId: agentArtifactHandles.operationId,
    r2Key: agentArtifactHandles.r2Key,
    mediaType: agentArtifactHandles.mediaType,
    filename: agentArtifactHandles.filename,
    sizeBytes: agentArtifactHandles.sizeBytes,
    sha256: agentArtifactHandles.sha256,
  });
  return claimed[0] ?? null;
}

export async function getAgentArtifactForAuthorization(
  db: Database,
  artifactId: string,
  principal: AgentPrincipal,
) {
  const now = new Date();
  return db.select({
    id: agentArtifactHandles.id,
    operationId: agentArtifactHandles.operationId,
    mediaType: agentArtifactHandles.mediaType,
    sizeBytes: agentArtifactHandles.sizeBytes,
  }).from(agentArtifactHandles).where(and(
    eq(agentArtifactHandles.id, artifactId),
    eq(agentArtifactHandles.grantId, principal.grantId),
    eq(agentArtifactHandles.resource, principal.resource),
    principal.credentialId === null
      ? isNull(agentArtifactHandles.credentialId)
      : eq(agentArtifactHandles.credentialId, principal.credentialId),
    eq(agentArtifactHandles.status, "active"),
    gt(agentArtifactHandles.expiresAt, now),
  )).get();
}

export async function failClaimedAgentArtifact(
  db: Database,
  artifactId: string,
  failureClass: "r2_missing" | "r2_read_failed" | "size_mismatch" | "digest_mismatch",
): Promise<void> {
  await db.update(agentArtifactHandles).set({
    status: "failed",
    failureClass,
    updatedAt: new Date(),
  }).where(and(
    eq(agentArtifactHandles.id, artifactId),
    eq(agentArtifactHandles.status, "consumed"),
  ));
}

export async function listAgentArtifactCleanupCandidates(
  db: Database,
  options: {
    limit?: number;
    after?: { expiresAt: Date; id: string };
  } = {},
) {
  const now = new Date();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const after = options.after;
  return db.select({
    id: agentArtifactHandles.id,
    r2Key: agentArtifactHandles.r2Key,
    expiresAt: agentArtifactHandles.expiresAt,
  }).from(agentArtifactHandles).where(
    and(
      inArray(agentArtifactHandles.status, ["consumed", "expired", "failed"]),
      lte(agentArtifactHandles.expiresAt, now),
      after
        ? or(
            gt(agentArtifactHandles.expiresAt, after.expiresAt),
            and(
              eq(agentArtifactHandles.expiresAt, after.expiresAt),
              gt(agentArtifactHandles.id, after.id),
            ),
          )
        : undefined,
    ),
  ).orderBy(
    asc(agentArtifactHandles.expiresAt),
    asc(agentArtifactHandles.id),
  ).limit(limit);
}

export async function deleteAgentArtifactRecords(
  db: Database,
  artifactIds: string[],
): Promise<number> {
  if (artifactIds.length === 0) return 0;
  if (artifactIds.length > 90) {
    throw new Error("Agent artifact cleanup deletes are limited to 90 IDs");
  }
  const uniqueIds = [...new Set(artifactIds)];
  if (
    uniqueIds.length !== artifactIds.length ||
    uniqueIds.some((id) => !/^aah_[A-Za-z0-9_-]{20}$/.test(id))
  ) {
    throw new Error("Agent artifact cleanup IDs are invalid");
  }
  const deleted = await db.delete(agentArtifactHandles).where(
    and(
      inArray(agentArtifactHandles.id, uniqueIds),
      inArray(agentArtifactHandles.status, ["consumed", "expired", "failed"]),
    ),
  ).returning({ id: agentArtifactHandles.id });
  return deleted.length;
}

export async function expireAgentArtifactHandles(db: Database): Promise<void> {
  const now = new Date();
  await db.update(agentArtifactHandles).set({ status: "expired", updatedAt: now }).where(and(
    eq(agentArtifactHandles.status, "active"),
    lte(agentArtifactHandles.expiresAt, now),
  ));
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAgentArtifactBytes(
  artifact: { sizeBytes: number; sha256: string },
  bytes: ArrayBuffer,
): Promise<"size_mismatch" | "digest_mismatch" | null> {
  if (bytes.byteLength !== artifact.sizeBytes) return "size_mismatch";
  if (await sha256Hex(bytes) !== artifact.sha256) return "digest_mismatch";
  return null;
}
