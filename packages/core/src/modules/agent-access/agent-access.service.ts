import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import {
  agentArtifactHandles,
  agentAuditEvents,
  agentAuthorizationRequests,
  agentBrowserHandoffs,
  agentCredentials,
  agentDeviceAuthorizations,
  agentGrants,
  agentStorefrontContexts,
  agentStorefrontContinuations,
  agentStorefrontOrderGrants,
  user,
} from "@scalius/database/schema";
import { getAllPermissionNames } from "../../auth/rbac/permissions";
import { isSensitivePermission } from "../../auth/rbac/permission-metadata";
import { AgentGrantInactiveError, ConflictError, ForbiddenError, NotFoundError, StateConflictError, ValidationError } from "../../errors";
import { cleanAgentLabel, cleanAgentLabelOrNull } from "@scalius/shared/agent-label";
import { GRANT_MACHINE, PAIRING_MACHINE } from "./lifecycle";

/** The update of a grant's `revoke` move names its source states: a revocation that came first keeps its reason. */
const grantRevocable = () => inArray(agentGrants.status, [...GRANT_MACHINE.moves.revoke.from]);

export type AgentResource = "dashboard" | "storefront";
export type AgentPreset = "read" | "operator" | "full" | "custom";
export type AgentRisk = "read" | "write" | "destructive" | "financial" | "security";

export interface GrantSelection {
  label?: string;
  resource: AgentResource;
  preset: AgentPreset;
  permissions?: string[];
  riskCeiling?: AgentRisk;
  expiresInDays?: number;
}

const RISK_RANK: Record<AgentRisk, number> = {
  read: 0,
  write: 1,
  destructive: 2,
  financial: 3,
  security: 4,
};

const READ_ACTIONS = new Set(["view", "analytics"]);

function canonicalPermissions(permissions: Iterable<string>): string[] {
  const known = new Set(getAllPermissionNames());
  return [...new Set(permissions)].filter((permission) => known.has(permission)).sort();
}

function isReadPermission(permission: string): boolean {
  const action = permission.split(".").at(-1) ?? "";
  return READ_ACTIONS.has(action) || action.startsWith("view_");
}

function isOperatorPermission(permission: string): boolean {
  return !isSensitivePermission(permission) &&
    !permission.includes("delete") &&
    !permission.includes("refund") &&
    permission !== "agent_access.manage" &&
    permission !== "team.manage" &&
    permission !== "team.manage_roles";
}

export function resolveGrantSelection(
  input: GrantSelection,
  callerPermissions: Iterable<string>,
  kind: "oauth" | "pat" | "cli",
): {
  label: string;
  resource: AgentResource;
  preset: AgentPreset;
  permissions: string[];
  riskCeiling: AgentRisk;
  expiresAt: Date;
} {
  const caller = canonicalPermissions(callerPermissions);
  const requested = canonicalPermissions(
    input.preset === "custom"
      ? input.permissions ?? []
      : input.permissions?.length
        ? input.permissions
        : caller,
  );
  if (requested.some((permission) => !caller.includes(permission))) {
    throw new ForbiddenError("A connection cannot receive permissions its owner lacks");
  }
  if (input.preset === "custom" && requested.length === 0) {
    throw new ValidationError("Custom access requires at least one permission");
  }

  let permissions: string[];
  let defaultRisk: AgentRisk;
  switch (input.preset) {
    case "read":
      permissions = requested.filter(isReadPermission);
      defaultRisk = "read";
      break;
    case "operator":
      permissions = requested.filter(isOperatorPermission);
      defaultRisk = "write";
      break;
    case "full":
      permissions = requested;
      defaultRisk = "security";
      break;
    case "custom":
      permissions = requested;
      defaultRisk = input.riskCeiling ?? "read";
      break;
  }
  const riskCeiling = input.riskCeiling ?? defaultRisk;
  if (RISK_RANK[riskCeiling] > RISK_RANK[defaultRisk] && input.preset !== "custom") {
    throw new ValidationError("The selected risk ceiling exceeds the preset");
  }

  const requestedDays = input.expiresInDays ?? (kind === "cli" ? 30 : kind === "oauth" ? 30 : 90);
  const maxDays = kind === "oauth" ? 30 : kind === "cli" ? 90 : riskCeiling === "read" ? 365 : 90;
  if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > maxDays) {
    throw new ValidationError(`Expiry must be between 1 and ${maxDays} days`);
  }

  return {
    // A connection's name, typed or carried from the tool's own: cleaned as it enters.
    label: cleanAgentLabel(input.label) || (kind === "cli" ? "Scalius CLI" : "Agent connection"),
    resource: input.resource,
    preset: input.preset,
    permissions,
    riskCeiling,
    expiresAt: new Date(Date.now() + requestedDays * 86_400_000),
  };
}

const PARENT_AUTHORITY_INACTIVE = "agent_parent_authority_inactive";
const AUTHORIZATION_NOT_PENDING = "agent_authorization_not_pending";
const CREDENTIAL_NOT_ACTIVE = "agent_credential_not_active";
const DEVICE_NOT_PENDING = "agent_device_not_pending";

export async function createCredentialGrant(
  db: Database,
  input: {
    ownerUserId: string;
    kind: "pat" | "cli";
    selection: ReturnType<typeof resolveGrantSelection>;
    issued: { credentialId: string; kind: "pat" | "cli"; tokenHash: string; tokenHint: string };
    rotatedFromId?: string | null;
    parentAuthority?: {
      grantId: string;
      credentialId: string | null;
      ownerUserId: string;
      resource: AgentResource;
      authorityRevision: number;
    };
  },
) {
  const now = new Date();
  const grantId = `agr_${nanoid(20)}`;
  const grantInsert = db.insert(agentGrants).values({
    id: grantId,
    kind: input.kind,
    ownerUserId: input.ownerUserId,
    resource: input.selection.resource,
    label: input.selection.label,
    preset: input.selection.preset,
    permissionsJson: JSON.stringify(input.selection.permissions),
    riskCeiling: input.selection.riskCeiling,
    status: GRANT_MACHINE.initial[0],
    expiresAt: input.selection.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const credentialInsert = db.insert(agentCredentials).values({
    id: input.issued.credentialId,
    grantId,
    kind: input.kind,
    tokenHash: input.issued.tokenHash,
    tokenHint: input.issued.tokenHint,
    expiresAt: input.selection.expiresAt,
    rotatedFromId: input.rotatedFromId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const parentGuard = input.parentAuthority
    ? buildBatchGuard(
        db,
        input.parentAuthority.credentialId
          ? sql`EXISTS (
              SELECT 1
              FROM agent_grants parent_grant
              INNER JOIN agent_credentials parent_credential
                ON parent_credential.grant_id = parent_grant.id
              WHERE parent_grant.id = ${input.parentAuthority.grantId}
                AND parent_credential.id = ${input.parentAuthority.credentialId}
                AND parent_grant.owner_user_id = ${input.parentAuthority.ownerUserId}
                AND parent_grant.resource = ${input.parentAuthority.resource}
                AND parent_grant.authority_revision = ${input.parentAuthority.authorityRevision}
                AND parent_grant.status = 'active'
                AND parent_grant.expires_at > unixepoch()
                AND parent_credential.revoked_at IS NULL
                AND parent_credential.expires_at > unixepoch()
            )`
          : sql`EXISTS (
              SELECT 1 FROM agent_grants parent_grant
              WHERE parent_grant.id = ${input.parentAuthority.grantId}
                AND parent_grant.owner_user_id = ${input.parentAuthority.ownerUserId}
                AND parent_grant.resource = ${input.parentAuthority.resource}
                AND parent_grant.authority_revision = ${input.parentAuthority.authorityRevision}
                AND parent_grant.kind = 'oauth'
                AND parent_grant.status = 'active'
                AND parent_grant.expires_at > unixepoch()
            )`,
        PARENT_AUTHORITY_INACTIVE,
      )
    : null;
  try {
    await safeBatch(db, [
      ...(parentGuard ? [parentGuard] : []),
      grantInsert,
      credentialInsert,
    ]);
  } catch (error) {
    // The connection creating this one was revoked, expired or narrowed since
    // its request was authorized: refused as its own authentication would be.
    if (isBatchGuardError(error, PARENT_AUTHORITY_INACTIVE)) {
      throw new AgentGrantInactiveError();
    }
    throw error;
  }
  return { grantId, credentialId: input.issued.credentialId, expiresAt: input.selection.expiresAt };
}

function statusFor(grant: { status: string; expiresAt: Date }): "pending" | "active" | "revoked" | "expired" {
  return grant.status !== "revoked" && grant.expiresAt <= new Date()
    ? "expired"
    : grant.status as "pending" | "active" | "revoked";
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Connection list status filters. `current` is the dashboard default: every
 * pending or active grant that has not expired yet. `expired` and `revoked`
 * together are exactly the set `purgeRevokedAgentGrants()` deletes.
 */
export type AgentConnectionStatusFilter =
  | "current"
  | "pending"
  | "active"
  | "revoked"
  | "expired"
  | "attention";

/**
 * The platform revoked the connection because one of its refresh tokens was
 * presented twice: a copy was stolen. Such a connection stays on the agent
 * access screen (`attention`), out of "Clear old connections", until staff
 * dismiss it (`SECURITY_REVOCATION_DISMISSED`). Only a revocation with no
 * person as revoker carries it, so no typed reason can pose as one.
 */
export const SECURITY_REVOCATION_REFRESH_REUSE = "security:refresh_token_reused";
export const SECURITY_REVOCATION_DISMISSED = "security:refresh_token_reused:dismissed";
/** The tool disconnected itself (the CLI's sign-out): no person revoked it. */
export const REVOCATION_BY_TOOL = "Revoked by credential owner";
/** A CLI pairing approved but never picked up by the tool before it expired. */
export const REVOCATION_PAIRING_UNFINISHED = "Unacknowledged CLI pairing expired";
/** An OAuth sign-in approved but never completed by the agent before its request expired. */
export const REVOCATION_AUTHORIZATION_UNFINISHED = "Uncompleted OAuth sign-in expired";

/** A security revocation staff have not dismissed yet. */
function awaitingAttention() {
  return and(
    eq(agentGrants.status, "revoked"),
    isNull(agentGrants.revokedByUserId),
    eq(agentGrants.revokedReason, SECURITY_REVOCATION_REFRESH_REUSE),
  )!;
}

/** Everything except an undismissed security revocation (a NULL reason or revoker counts as "not one"). */
function notAwaitingAttention() {
  return sql`NOT (${agentGrants.status} = 'revoked' AND ${agentGrants.revokedByUserId} IS NULL
    AND coalesce(${agentGrants.revokedReason}, '') = ${SECURITY_REVOCATION_REFRESH_REUSE})`;
}

function connectionStatusFilter(status: string | undefined, now: Date) {
  switch (status) {
    case undefined:
    case "":
      return undefined;
    case "current":
      return and(inArray(agentGrants.status, ["pending", "active"]), gt(agentGrants.expiresAt, now));
    case "expired":
      return and(inArray(agentGrants.status, ["pending", "active"]), lte(agentGrants.expiresAt, now));
    case "revoked":
      // What "Clear old connections" deletes: never a security revocation awaiting staff.
      return and(eq(agentGrants.status, "revoked"), notAwaitingAttention());
    case "attention":
      return awaitingAttention();
    default:
      return and(
        eq(agentGrants.status, status as "pending" | "active"),
        gt(agentGrants.expiresAt, now),
      );
  }
}

/** The staff member who disconnected a connection (a second join of `user`). */
const revoker = alias(user, "revoker");

export async function listAgentConnections(
  db: Database,
  input: {
    page: number;
    limit: number;
    status?: AgentConnectionStatusFilter | string;
    resource?: AgentResource;
    kind?: string;
    ownerUserId?: string;
  },
) {
  const now = new Date();
  const filters = [
    connectionStatusFilter(input.status, now),
    input.resource ? eq(agentGrants.resource, input.resource) : undefined,
    input.kind ? eq(agentGrants.kind, input.kind as "oauth" | "pat" | "cli") : undefined,
    input.ownerUserId ? eq(agentGrants.ownerUserId, input.ownerUserId) : undefined,
  ].filter(Boolean);
  const where = filters.length ? and(...filters) : undefined;
  const totalRow = await db.select({ count: count() }).from(agentGrants).where(where);
  const grants = await db.select({
      id: agentGrants.id,
      kind: agentGrants.kind,
      ownerUserId: agentGrants.ownerUserId,
      ownerName: user.name,
      resource: agentGrants.resource,
      label: agentGrants.label,
      clientId: agentGrants.oauthClientId,
      clientName: agentGrants.oauthClientName,
      preset: agentGrants.preset,
      permissionsJson: agentGrants.permissionsJson,
      riskCeiling: agentGrants.riskCeiling,
      status: agentGrants.status,
      expiresAt: agentGrants.expiresAt,
      lastUsedAt: agentGrants.lastUsedAt,
      lastOperationId: agentGrants.lastOperationId,
      revokedAt: agentGrants.revokedAt,
      revokedReason: agentGrants.revokedReason,
      revokedByUserId: agentGrants.revokedByUserId,
      // Who disconnected it, by name (null: the platform or the tool itself did, or the account is gone).
      revokedByName: revoker.name,
      createdAt: agentGrants.createdAt,
      updatedAt: agentGrants.updatedAt,
    }).from(agentGrants).leftJoin(user, eq(agentGrants.ownerUserId, user.id))
      .leftJoin(revoker, eq(agentGrants.revokedByUserId, revoker.id))
      .where(where).orderBy(desc(sql`coalesce(${agentGrants.revokedAt}, ${agentGrants.createdAt})`))
      .limit(input.limit).offset((input.page - 1) * input.limit);
  const grantIds = grants.map((grant) => grant.id);
  const credentials = grantIds.length
    ? await db.select().from(agentCredentials).where(inArray(agentCredentials.grantId, grantIds))
    : [];
  return {
    connections: grants.map((grant) => ({
      ...grant,
      // Names stored before they were cleaned as they enter are cleaned here too.
      label: cleanAgentLabel(grant.label),
      clientName: cleanAgentLabelOrNull(grant.clientName, 160),
      permissions: safeJsonArray(grant.permissionsJson),
      permissionsJson: undefined,
      status: statusFor(grant),
      credentials: credentials.filter((credential) => credential.grantId === grant.id).map((credential) => ({
        id: credential.id,
        kind: credential.kind,
        tokenHint: credential.tokenHint,
        expiresAt: credential.expiresAt,
        lastUsedAt: credential.lastUsedAt,
        revokedAt: credential.revokedAt,
      })),
    })),
    pagination: {
      page: input.page,
      limit: input.limit,
      total: totalRow[0]?.count ?? 0,
      totalPages: Math.ceil((totalRow[0]?.count ?? 0) / input.limit),
    },
  };
}

export async function getAgentConnection(db: Database, grantId: string) {
  const grant = await db.select({
    id: agentGrants.id,
    kind: agentGrants.kind,
    ownerUserId: agentGrants.ownerUserId,
    ownerName: user.name,
    resource: agentGrants.resource,
    label: agentGrants.label,
    clientId: agentGrants.oauthClientId,
    clientName: agentGrants.oauthClientName,
    preset: agentGrants.preset,
    permissionsJson: agentGrants.permissionsJson,
    riskCeiling: agentGrants.riskCeiling,
    status: agentGrants.status,
    expiresAt: agentGrants.expiresAt,
    lastUsedAt: agentGrants.lastUsedAt,
    lastOperationId: agentGrants.lastOperationId,
    createdAt: agentGrants.createdAt,
    updatedAt: agentGrants.updatedAt,
  }).from(agentGrants).leftJoin(user, eq(agentGrants.ownerUserId, user.id))
    .where(eq(agentGrants.id, grantId)).get();
  if (!grant) throw new NotFoundError("Agent connection not found");
  const credentials = await db.select({
    id: agentCredentials.id,
    kind: agentCredentials.kind,
    tokenHint: agentCredentials.tokenHint,
    expiresAt: agentCredentials.expiresAt,
    lastUsedAt: agentCredentials.lastUsedAt,
    revokedAt: agentCredentials.revokedAt,
  }).from(agentCredentials).where(eq(agentCredentials.grantId, grantId));
  const { permissionsJson, ...safeGrant } = grant;
  return {
    ...safeGrant,
    label: cleanAgentLabel(safeGrant.label),
    clientName: cleanAgentLabelOrNull(safeGrant.clientName, 160),
    permissions: safeJsonArray(permissionsJson),
    status: statusFor(grant),
    credentials,
  };
}

/** An audit row's metadata, with the connection and client it names cleaned (rows written before names were cleaned as they enter). */
function auditMetadata(json: string): Record<string, unknown> {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
  for (const key of ["connection", "client"] as const) {
    if (typeof metadata[key] === "string") metadata[key] = cleanAgentLabel(metadata[key] as string);
  }
  return metadata;
}

export async function listAgentAuditEvents(
  db: Database,
  grantId: string,
  page: number,
  limit: number,
) {
  const totalRows = await db.select({ count: count() }).from(agentAuditEvents)
    .where(eq(agentAuditEvents.grantId, grantId));
  const rows = await db.select().from(agentAuditEvents)
    .where(eq(agentAuditEvents.grantId, grantId))
    .orderBy(desc(agentAuditEvents.createdAt)).limit(limit).offset((page - 1) * limit);
  const total = totalRows[0]?.count ?? 0;
  return {
    events: rows.map((row) => ({
      ...row,
      resourceIds: safeJsonArray(row.resourceIdsJson),
      metadata: auditMetadata(row.metadataJson),
      resourceIdsJson: undefined,
      metadataJson: undefined,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** `actorUserId` null: the platform revoked it (a stolen refresh token was presented again). */
export async function revokeAgentGrant(
  db: Database,
  grantId: string,
  actorUserId: string | null,
  reason?: string,
) {
  const now = new Date();
  const results = await safeBatch(db, [
    db.update(agentGrants).set({
      status: GRANT_MACHINE.moves.revoke.to,
      revokedByUserId: actorUserId,
      revokedReason: reason?.trim().slice(0, 240) || "Revoked by administrator",
      revokedAt: now,
      updatedAt: now,
    }).where(and(eq(agentGrants.id, grantId), grantRevocable())).returning({ id: agentGrants.id }),
    db.update(agentCredentials).set({ revokedAt: now, updatedAt: now })
      .where(and(eq(agentCredentials.grantId, grantId), isNull(agentCredentials.revokedAt))),
  ]);
  const updated = results[0] as { id: string }[] | undefined;
  if (!updated?.[0]) {
    const current = await db.select({ status: agentGrants.status }).from(agentGrants).where(eq(agentGrants.id, grantId)).get();
    if (!current) throw new NotFoundError("Agent connection not found");
    throw new StateConflictError(GRANT_MACHINE, current.status, "revoke", "This connection is already disconnected.");
  }
  return { status: GRANT_MACHINE.moves.revoke.to, grantId };
}

export async function revokeAllAgentGrants(
  db: Database,
  actorUserId: string,
  resource?: AgentResource,
  reason?: string,
) {
  const now = new Date();
  const results = await safeBatch(db, [
    db.update(agentCredentials).set({ revokedAt: now, updatedAt: now }).where(and(
      isNull(agentCredentials.revokedAt),
      inArray(agentCredentials.grantId, db.select({ id: agentGrants.id }).from(agentGrants).where(and(
        grantRevocable(),
        resource ? eq(agentGrants.resource, resource) : undefined,
      ))),
    )).returning({ id: agentCredentials.id }),
    db.update(agentGrants).set({
      status: GRANT_MACHINE.moves.revoke.to,
      revokedByUserId: actorUserId,
      revokedReason: reason?.trim().slice(0, 240) || "Revoked by administrator",
      revokedAt: now,
      updatedAt: now,
    }).where(and(
      grantRevocable(),
      resource ? eq(agentGrants.resource, resource) : undefined,
    )).returning({ id: agentGrants.id }),
  ]);
  const grantRows = results[1] as { id: string }[] | undefined;
  return { status: "revoked" as const, count: grantRows?.length ?? 0 };
}

/** D1 allows at most 100 bound parameters per statement; keep ID chunks below that. */
export const AGENT_GRANT_PURGE_CHUNK_SIZE = 90;

export interface PurgeRevokedAgentGrantsOptions {
  resource?: AgentResource;
  now?: Date;
  /**
   * Receives every artifact handle in a chunk before its rows are deleted so
   * the caller can remove the private R2 objects while the relational
   * authority still exists. Object failures must be absorbed by the caller;
   * the purge continues because the grant is already dead and the bucket
   * lifecycle rule remains the secondary safety net.
   */
  onArtifactsPurging?: (
    artifacts: ReadonlyArray<{ id: string; r2Key: string }>,
  ) => Promise<void>;
}

export interface PurgeRevokedAgentGrantsResult {
  status: "purged";
  /** Grants permanently deleted. */
  count: number;
  /** Credentials deleted with those grants. */
  credentials: number;
  /** Artifact handles deleted with those grants. */
  artifacts: number;
}

function purgeableGrantPredicate(now: Date, resource?: AgentResource) {
  return and(
    or(eq(agentGrants.status, "revoked"), lte(agentGrants.expiresAt, now)),
    // A security revocation stays, with its audit history, until staff dismiss it.
    notAwaitingAttention(),
    resource ? eq(agentGrants.resource, resource) : undefined,
  );
}

/**
 * Staff read a security revocation: it leaves the screen's attention list and
 * becomes an ordinary revoked connection "Clear old connections" may delete.
 */
export async function dismissAgentSecurityRevocation(db: Database, grantId: string) {
  const updated = await db.update(agentGrants)
    .set({ revokedReason: SECURITY_REVOCATION_DISMISSED, updatedAt: new Date() })
    .where(and(eq(agentGrants.id, grantId), awaitingAttention()))
    .returning({ id: agentGrants.id });
  if (!updated[0]) throw new NotFoundError("No security notice for this connection");
  return { status: "dismissed" as const, grantId };
}

/**
 * Permanently deletes revoked grants plus every grant whose expiry has passed
 * (regardless of status), together with all dependent rows. Tables whose
 * grant reference is `no action` (artifact handles, browser handoffs) or whose
 * `set null` action would violate a status CHECK (authorization requests,
 * device authorizations) are deleted explicitly, in dependency order, inside
 * the same atomic batch as the grant so no provider relies on FK actions.
 * Audit history for the purged grants is deleted as well; this is the
 * merchant-facing "clear revoked connections" ceremony, not a retention job.
 */
export async function purgeRevokedAgentGrants(
  db: Database,
  options: PurgeRevokedAgentGrantsOptions = {},
): Promise<PurgeRevokedAgentGrantsResult> {
  const now = options.now ?? new Date();
  const candidates = await db.select({ id: agentGrants.id }).from(agentGrants)
    .where(purgeableGrantPredicate(now, options.resource))
    .orderBy(asc(agentGrants.createdAt), asc(agentGrants.id));
  const result: PurgeRevokedAgentGrantsResult = {
    status: "purged",
    count: 0,
    credentials: 0,
    artifacts: 0,
  };
  for (let offset = 0; offset < candidates.length; offset += AGENT_GRANT_PURGE_CHUNK_SIZE) {
    const ids = candidates
      .slice(offset, offset + AGENT_GRANT_PURGE_CHUNK_SIZE)
      .map((row) => row.id);
    if (options.onArtifactsPurging) {
      const artifacts = await db.select({
        id: agentArtifactHandles.id,
        r2Key: agentArtifactHandles.r2Key,
      }).from(agentArtifactHandles).where(inArray(agentArtifactHandles.grantId, ids));
      if (artifacts.length > 0) await options.onArtifactsPurging(artifacts);
    }
    const credentialIds = db.select({ id: agentCredentials.id }).from(agentCredentials)
      .where(inArray(agentCredentials.grantId, ids));
    const contextIds = db.select({ id: agentStorefrontContexts.id }).from(agentStorefrontContexts)
      .where(inArray(agentStorefrontContexts.grantId, ids));
    const results = await safeBatch(db, [
      db.delete(agentAuditEvents).where(inArray(agentAuditEvents.grantId, ids)),
      db.delete(agentAuditEvents).where(inArray(agentAuditEvents.credentialId, credentialIds)),
      db.delete(agentArtifactHandles).where(inArray(agentArtifactHandles.grantId, ids))
        .returning({ id: agentArtifactHandles.id }),
      db.delete(agentBrowserHandoffs).where(inArray(agentBrowserHandoffs.grantId, ids)),
      db.delete(agentAuthorizationRequests).where(inArray(agentAuthorizationRequests.grantId, ids)),
      db.delete(agentDeviceAuthorizations).where(inArray(agentDeviceAuthorizations.grantId, ids)),
      db.delete(agentStorefrontContinuations)
        .where(inArray(agentStorefrontContinuations.contextId, contextIds)),
      db.delete(agentStorefrontOrderGrants)
        .where(inArray(agentStorefrontOrderGrants.contextId, contextIds)),
      db.delete(agentStorefrontContexts).where(inArray(agentStorefrontContexts.grantId, ids)),
      db.delete(agentCredentials).where(inArray(agentCredentials.grantId, ids))
        .returning({ id: agentCredentials.id }),
      db.delete(agentGrants).where(and(
        inArray(agentGrants.id, ids),
        purgeableGrantPredicate(now, options.resource),
      )).returning({ id: agentGrants.id }),
    ]);
    result.artifacts += (results[2] as { id: string }[] | undefined)?.length ?? 0;
    result.credentials += (results[9] as { id: string }[] | undefined)?.length ?? 0;
    result.count += (results[10] as { id: string }[] | undefined)?.length ?? 0;
  }
  return result;
}

export async function getAuthorizationRequest(db: Database, requestId: string) {
  const row = await db.select({
    id: agentAuthorizationRequests.id,
    resource: agentAuthorizationRequests.resource,
    clientId: agentAuthorizationRequests.clientId,
    clientName: agentAuthorizationRequests.clientName,
    redirectUri: agentAuthorizationRequests.redirectUri,
    status: agentAuthorizationRequests.status,
    expiresAt: agentAuthorizationRequests.expiresAt,
  }).from(agentAuthorizationRequests).where(eq(agentAuthorizationRequests.id, requestId)).get();
  if (!row) throw new NotFoundError("Authorization request not found");
  const status = row.expiresAt <= new Date()
    ? "expired" as const
    : row.status === "completing" || row.status === "completed"
      ? "approved" as const
      : row.status === "denying"
        ? "denied" as const
        : row.status;
  return { ...row, clientName: cleanAgentLabelOrNull(row.clientName, 160), status, requestedPermissions: [] as string[] };
}

export async function approveAuthorizationRequest(
  db: Database,
  input: {
    requestId: string;
    actorUserId: string;
    selection: ReturnType<typeof resolveGrantSelection>;
  },
) {
  const request = await db.select().from(agentAuthorizationRequests)
    .where(and(
      eq(agentAuthorizationRequests.id, input.requestId),
      eq(agentAuthorizationRequests.status, "pending"),
      gt(agentAuthorizationRequests.expiresAt, new Date()),
    )).get();
  if (!request || request.resource !== input.selection.resource) {
    throw new NotFoundError("Pending authorization request not found");
  }
  const now = new Date();
  const grantId = `agr_${nanoid(20)}`;
  const guard = buildBatchGuard(
    db,
    sql`EXISTS (SELECT 1 FROM agent_authorization_requests WHERE id = ${input.requestId} AND status = 'pending' AND expires_at > unixepoch())`,
    AUTHORIZATION_NOT_PENDING,
  );
  // A request decided or expired since the read above is refused as that read refuses it.
  try {
    await safeBatch(db, [
      guard,
      db.insert(agentGrants).values({
        id: grantId,
        kind: "oauth",
        ownerUserId: input.actorUserId,
        resource: request.resource,
        label: input.selection.label,
        oauthClientId: request.clientId,
        oauthClientName: cleanAgentLabelOrNull(request.clientName, 160),
        oauthRedirectUrisJson: JSON.stringify([request.redirectUri]),
        preset: input.selection.preset,
        permissionsJson: JSON.stringify(input.selection.permissions),
        riskCeiling: input.selection.riskCeiling,
        status: GRANT_MACHINE.initial[0],
        expiresAt: input.selection.expiresAt,
        createdAt: now,
        updatedAt: now,
      }),
      db.update(agentAuthorizationRequests).set({
        status: "approved",
        decidedByUserId: input.actorUserId,
        decidedAt: now,
        grantId,
        updatedAt: now,
      }).where(and(
        eq(agentAuthorizationRequests.id, input.requestId),
        eq(agentAuthorizationRequests.status, "pending"),
      )),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, AUTHORIZATION_NOT_PENDING)) throw new NotFoundError("Pending authorization request not found");
    throw error;
  }
  return { status: "approved" as const, grantId };
}

export async function denyAuthorizationRequest(
  db: Database,
  requestId: string,
  actorUserId: string,
) {
  const rows = await db.update(agentAuthorizationRequests).set({
    status: "denying",
    decidedByUserId: actorUserId,
    decidedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(agentAuthorizationRequests.id, requestId),
    eq(agentAuthorizationRequests.status, "pending"),
    gt(agentAuthorizationRequests.expiresAt, new Date()),
  )).returning({ id: agentAuthorizationRequests.id });
  if (!rows[0]) throw new NotFoundError("Pending authorization request not found");
  return { status: "denied" as const };
}

export async function getDeviceAuthorizationByUserCodeHmac(db: Database, userCodeHmac: string) {
  const row = await db.select().from(agentDeviceAuthorizations)
    .where(eq(agentDeviceAuthorizations.userCodeHmac, userCodeHmac)).get();
  if (!row) throw new NotFoundError("Device authorization not found");
  return row;
}

export async function updateAgentGrant(
  db: Database,
  grantId: string,
  input: { label?: string; permissions?: string[]; riskCeiling?: AgentRisk; expiresAt?: Date },
) {
  const current = await db.select().from(agentGrants)
    .where(and(eq(agentGrants.id, grantId), eq(agentGrants.status, "active"))).get();
  if (!current) throw new NotFoundError("Active agent connection not found");
  const currentPermissions = safeJsonArray(current.permissionsJson);
  const permissions = input.permissions === undefined
    ? currentPermissions
    : canonicalPermissions(input.permissions);
  if (permissions.some((permission) => !currentPermissions.includes(permission))) {
    throw new ConflictError("Widening a connection requires a new approval");
  }
  const riskCeiling = input.riskCeiling ?? current.riskCeiling;
  if (RISK_RANK[riskCeiling] > RISK_RANK[current.riskCeiling]) {
    throw new ConflictError("Widening a connection requires a new approval");
  }
  const expiresAt = input.expiresAt ?? current.expiresAt;
  if (expiresAt > current.expiresAt || expiresAt <= new Date()) {
    throw new ConflictError("A connection expiry can only be shortened to a future time");
  }
  await commitAgentGrantNarrowing(db, {
    grantId,
    expectedAuthorityRevision: current.authorityRevision,
    label: cleanAgentLabel(input.label) || current.label,
    permissions,
    riskCeiling,
    expiresAt,
  });
  return getAgentConnection(db, grantId);
}

export async function commitAgentGrantNarrowing(
  db: Database,
  input: {
    grantId: string;
    expectedAuthorityRevision: number;
    label: string;
    permissions: string[];
    riskCeiling: AgentRisk;
    expiresAt: Date;
  },
) {
  const updated = await db.update(agentGrants).set({
    label: input.label,
    permissionsJson: JSON.stringify(input.permissions),
    riskCeiling: input.riskCeiling,
    expiresAt: input.expiresAt,
    authorityRevision: sql`${agentGrants.authorityRevision} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(agentGrants.id, input.grantId),
    eq(agentGrants.status, "active"),
    eq(agentGrants.authorityRevision, input.expectedAuthorityRevision),
  )).returning({ id: agentGrants.id });
  if (!updated[0]) {
    throw new ConflictError("agent_grant_authority_changed");
  }
  return { authorityRevision: input.expectedAuthorityRevision + 1 };
}

export async function rotateAgentCredential(
  db: Database,
  input: {
    credentialId: string;
    newCredentialId: string;
    tokenHash: string;
    tokenHint: string;
    expiresAt: Date;
  },
) {
  const current = await db.select({
    id: agentCredentials.id,
    grantId: agentCredentials.grantId,
    kind: agentCredentials.kind,
    grantExpiresAt: agentGrants.expiresAt,
    grantStatus: agentGrants.status,
  }).from(agentCredentials).innerJoin(agentGrants, eq(agentCredentials.grantId, agentGrants.id))
    .where(and(
      eq(agentCredentials.id, input.credentialId),
      isNull(agentCredentials.revokedAt),
      gt(agentCredentials.expiresAt, new Date()),
    )).get();
  if (!current || current.grantStatus !== "active") throw new NotFoundError("Active credential not found");
  if (input.expiresAt > current.grantExpiresAt || input.expiresAt <= new Date()) {
    throw new ValidationError("Rotated credential expiry must remain inside the grant lifetime");
  }
  const now = new Date();
  const guard = buildBatchGuard(
    db,
    sql`EXISTS (SELECT 1 FROM agent_credentials WHERE id = ${input.credentialId} AND revoked_at IS NULL AND expires_at > unixepoch())`,
    CREDENTIAL_NOT_ACTIVE,
  );
  // A credential rotated, revoked or expired since the read above is refused as that read refuses it.
  try {
    await safeBatch(db, [
      guard,
      db.update(agentCredentials).set({ revokedAt: now, rotatedAt: now, updatedAt: now })
        .where(and(eq(agentCredentials.id, input.credentialId), isNull(agentCredentials.revokedAt))),
      db.insert(agentCredentials).values({
        id: input.newCredentialId,
        grantId: current.grantId,
        kind: current.kind,
        tokenHash: input.tokenHash,
        tokenHint: input.tokenHint,
        expiresAt: input.expiresAt,
        rotatedFromId: current.id,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, CREDENTIAL_NOT_ACTIVE)) throw new NotFoundError("Active credential not found");
    throw error;
  }
  return { grantId: current.grantId, credentialId: input.newCredentialId };
}

export async function getActiveAgentCredentialForRotation(
  db: Database,
  credentialId: string,
) {
  const row = await db.select({
    id: agentCredentials.id,
    kind: agentCredentials.kind,
    grantId: agentCredentials.grantId,
    grantExpiresAt: agentGrants.expiresAt,
  }).from(agentCredentials).innerJoin(agentGrants, eq(agentCredentials.grantId, agentGrants.id))
    .where(and(
      eq(agentCredentials.id, credentialId),
      isNull(agentCredentials.revokedAt),
      gt(agentCredentials.expiresAt, new Date()),
      eq(agentGrants.status, "active"),
      gt(agentGrants.expiresAt, new Date()),
    )).get();
  if (!row) throw new NotFoundError("Active credential not found");
  return row;
}

export async function approveDeviceAuthorization(
  db: Database,
  input: {
    deviceId: string;
    actorUserId: string;
    selection: ReturnType<typeof resolveGrantSelection>;
    credentialId: string;
    tokenHash: string;
    tokenHint: string;
    encryptedDeliveryEnvelope: string;
  },
) {
  const device = await db.select().from(agentDeviceAuthorizations).where(and(
    eq(agentDeviceAuthorizations.id, input.deviceId),
    pairingCan("approve"),
    gt(agentDeviceAuthorizations.expiresAt, new Date()),
  )).get();
  if (!device || device.requestedResource !== input.selection.resource) {
    throw new NotFoundError("Pending device authorization not found");
  }
  const now = new Date();
  const grantId = `agr_${nanoid(20)}`;
  const guard = buildBatchGuard(
    db,
    sql`EXISTS (SELECT 1 FROM agent_device_authorizations WHERE id = ${input.deviceId} AND status = 'pending' AND expires_at > unixepoch())`,
    DEVICE_NOT_PENDING,
  );
  // A device authorization decided or expired since the read above is refused as that read refuses it.
  try {
    await safeBatch(db, [
      guard,
      db.insert(agentGrants).values({
        id: grantId,
        kind: "cli",
        ownerUserId: input.actorUserId,
        resource: input.selection.resource,
        label: input.selection.label,
        preset: input.selection.preset,
        permissionsJson: JSON.stringify(input.selection.permissions),
        riskCeiling: input.selection.riskCeiling,
        status: GRANT_MACHINE.initial[0],
        expiresAt: input.selection.expiresAt,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(agentCredentials).values({
        id: input.credentialId,
        grantId,
        kind: "cli",
        tokenHash: input.tokenHash,
        tokenHint: input.tokenHint,
        expiresAt: input.selection.expiresAt,
        createdAt: now,
        updatedAt: now,
      }),
      db.update(agentDeviceAuthorizations).set({
        requestedPreset: input.selection.preset,
        requestedPermissionsJson: JSON.stringify(input.selection.permissions),
        status: PAIRING_MACHINE.moves.approve.to,
        approvedByUserId: input.actorUserId,
        decidedAt: now,
        grantId,
        credentialId: input.credentialId,
        encryptedDeliveryEnvelope: input.encryptedDeliveryEnvelope,
        updatedAt: now,
      }).where(and(
        eq(agentDeviceAuthorizations.id, input.deviceId),
        pairingCan("approve"),
      )),
    ]);
  } catch (error) {
    if (isBatchGuardError(error, DEVICE_NOT_PENDING)) throw new NotFoundError("Pending device authorization not found");
    throw error;
  }
  return { status: "approved" as const, grantId, credentialId: input.credentialId };
}

export async function denyDeviceAuthorization(
  db: Database,
  deviceId: string,
  actorUserId: string,
) {
  const rows = await db.update(agentDeviceAuthorizations).set({
    status: PAIRING_MACHINE.moves.deny.to,
    approvedByUserId: actorUserId,
    decidedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(agentDeviceAuthorizations.id, deviceId),
    pairingCan("deny"),
    gt(agentDeviceAuthorizations.expiresAt, new Date()),
  )).returning({ id: agentDeviceAuthorizations.id });
  if (!rows[0]) throw new NotFoundError("Pending device authorization not found");
  return { status: PAIRING_MACHINE.moves.deny.to };
}

/** A pairing whose state allows `move` (its update names the move's source states). */
export function pairingCan(move: keyof typeof PAIRING_MACHINE.moves) {
  return inArray(agentDeviceAuthorizations.status, [...PAIRING_MACHINE.moves[move].from]);
}

/** A pairing past its window that is still pending or approved. */
const pairingExpiryDue = (now: Date) => and(pairingCan("expire"), lte(agentDeviceAuthorizations.expiresAt, now));

/** An approved OAuth request past its window that nobody completed, or whose completion's claim ran out. */
const authorizationExpiryDue = (now: Date) => and(
  inArray(agentAuthorizationRequests.status, ["approved", "completing"]),
  lte(agentAuthorizationRequests.expiresAt, now),
  or(
    eq(agentAuthorizationRequests.status, "approved"),
    lte(agentAuthorizationRequests.completionClaimExpiresAt, now),
  ),
);

const endedAuthorizationCutoff = (now: Date) => new Date(now.getTime() - ENDED_AGENT_AUTHORIZATION_RETENTION_MS);

const endedRequestDue = (cutoff: Date) => and(
  inArray(agentAuthorizationRequests.status, ["pending", "denying", "denied", "expired"]),
  lte(agentAuthorizationRequests.expiresAt, cutoff),
  isNull(agentAuthorizationRequests.grantId),
);

const endedPairingDue = (cutoff: Date) => and(
  inArray(agentDeviceAuthorizations.status, ["pending", "denied", "expired"]),
  lte(agentDeviceAuthorizations.expiresAt, cutoff),
  isNull(agentDeviceAuthorizations.grantId),
);

/**
 * One-row probes of the three housekeeping steps below, each with its step's
 * own condition, so the maintenance job asks them in one statement and an
 * idle store pays one query for all three instead of four.
 */
export function agentAuthorizationHousekeepingProbes(db: Database, now: Date = new Date()) {
  const cutoff = endedAuthorizationCutoff(now);
  const one = { one: sql<number>`1` };
  return {
    pairingExpiry: [db.select(one).from(agentDeviceAuthorizations).where(pairingExpiryDue(now)).limit(1)],
    authorizationExpiry: [db.select(one).from(agentAuthorizationRequests).where(authorizationExpiryDue(now)).limit(1)],
    purge: [
      db.select(one).from(agentAuthorizationRequests).where(endedRequestDue(cutoff)).limit(1),
      db.select(one).from(agentDeviceAuthorizations).where(endedPairingDue(cutoff)).limit(1),
    ],
  };
}

/** Pairings a sweep run ends at most: three statements of at most this many ids each. */
export const PAIRING_EXPIRY_LIMIT = 50;

/**
 * Ends every pairing past its window that is still pending or approved (or
 * only `deviceId`), whether or not the tool polls again. An approved one the
 * tool never acknowledged loses its connection, revoked as unfinished, and
 * its encrypted token is erased. One batch, each update naming its move's
 * source states: a connection revoked before keeps its own reason, and a
 * pairing acknowledged meanwhile is not touched.
 */
export async function expireAgentDevicePairings(
  db: Database,
  options: { now?: Date; deviceId?: string; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const due = (ids?: string[]) => and(
    ids ? inArray(agentDeviceAuthorizations.id, ids) : undefined,
    options.deviceId ? eq(agentDeviceAuthorizations.id, options.deviceId) : undefined,
    pairingExpiryDue(now),
  );
  const ids = (await db.select({ id: agentDeviceAuthorizations.id }).from(agentDeviceAuthorizations)
    .where(due())
    .orderBy(asc(agentDeviceAuthorizations.status), asc(agentDeviceAuthorizations.expiresAt))
    .limit(options.limit ?? PAIRING_EXPIRY_LIMIT)).map((row) => row.id);
  if (ids.length === 0) return 0;
  // Read inside the batch: what an approved, unacknowledged pairing still holds.
  const unfinished = (column: typeof agentDeviceAuthorizations.grantId | typeof agentDeviceAuthorizations.credentialId) =>
    db.select({ id: column }).from(agentDeviceAuthorizations).where(and(due(ids), eq(agentDeviceAuthorizations.status, "approved")));
  const results = await safeBatch(db, [
    db.update(agentCredentials).set({ revokedAt: now, updatedAt: now }).where(and(
      inArray(agentCredentials.id, unfinished(agentDeviceAuthorizations.credentialId)),
      isNull(agentCredentials.revokedAt),
    )),
    db.update(agentGrants).set({
      status: GRANT_MACHINE.moves.revoke.to,
      revokedAt: now,
      revokedReason: REVOCATION_PAIRING_UNFINISHED,
      updatedAt: now,
    }).where(and(inArray(agentGrants.id, unfinished(agentDeviceAuthorizations.grantId)), grantRevocable())),
    db.update(agentDeviceAuthorizations).set({
      status: PAIRING_MACHINE.moves.expire.to,
      grantId: null,
      credentialId: null,
      encryptedDeliveryEnvelope: null,
      decidedAt: now,
      updatedAt: now,
    }).where(due(ids)).returning({ id: agentDeviceAuthorizations.id }),
  ]);
  return (results[2] as { id: string }[] | undefined)?.length ?? 0;
}

/**
 * Ends every approved OAuth request the agent never completed in its window:
 * no token was issued, so its connection is revoked as unfinished and the
 * stored request erased. A completion still holding its claim is left to
 * finish (its provider may have issued a code). One batch; the grant's update
 * names `active`, so an earlier revocation keeps its reason.
 */
export async function expireAgentAuthorizationRequests(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const due = (ids?: string[]) => and(
    ids ? inArray(agentAuthorizationRequests.id, ids) : undefined,
    authorizationExpiryDue(now),
  );
  const ids = (await db.select({ id: agentAuthorizationRequests.id }).from(agentAuthorizationRequests)
    .where(due())
    .orderBy(asc(agentAuthorizationRequests.status), asc(agentAuthorizationRequests.expiresAt))
    .limit(options.limit ?? PAIRING_EXPIRY_LIMIT)).map((row) => row.id);
  if (ids.length === 0) return 0;
  const results = await safeBatch(db, [
    db.update(agentGrants).set({
      status: GRANT_MACHINE.moves.revoke.to,
      revokedAt: now,
      revokedReason: REVOCATION_AUTHORIZATION_UNFINISHED,
      updatedAt: now,
    }).where(and(
      inArray(agentGrants.id, db.select({ id: agentAuthorizationRequests.grantId }).from(agentAuthorizationRequests).where(due(ids))),
      grantRevocable(),
    )),
    db.update(agentAuthorizationRequests).set({
      status: "expired",
      grantId: null,
      encryptedRequest: null,
      completionClaimHash: null,
      completionClaimExpiresAt: null,
      updatedAt: now,
    }).where(due(ids)).returning({ id: agentAuthorizationRequests.id }),
  ]);
  return (results[1] as { id: string }[] | undefined)?.length ?? 0;
}

/**
 * How long an ended OAuth request or pairing is kept, so a late consent page
 * or poll still reads "expired" rather than "not found".
 */
export const ENDED_AGENT_AUTHORIZATION_RETENTION_MS = 60 * 60 * 1000;
/** Rows a sweep run deletes at most, per table. */
export const ENDED_AGENT_AUTHORIZATION_PURGE_LIMIT = 90;

/**
 * Deletes OAuth requests and CLI pairings that ended without a connection:
 * denied, or never answered or collected in time. One with a connection
 * (approved, completed, consumed) goes with that connection
 * (`purgeRevokedAgentGrants`). Every state named here holds no grant (the
 * tables' checks), and each is past its window, so nothing open is deleted.
 */
export async function purgeEndedAgentAuthorizations(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<{ requests: number; pairings: number }> {
  const cutoff = endedAuthorizationCutoff(options.now ?? new Date());
  const limit = options.limit ?? ENDED_AGENT_AUTHORIZATION_PURGE_LIMIT;
  const endedRequest = endedRequestDue(cutoff);
  const endedPairing = endedPairingDue(cutoff);
  const requestIds = (await db.select({ id: agentAuthorizationRequests.id }).from(agentAuthorizationRequests)
    .where(endedRequest).limit(limit)).map((row) => row.id);
  const pairingIds = (await db.select({ id: agentDeviceAuthorizations.id }).from(agentDeviceAuthorizations)
    .where(endedPairing).limit(limit)).map((row) => row.id);
  const statements = [
    ...(requestIds.length ? [db.delete(agentAuthorizationRequests)
      .where(and(inArray(agentAuthorizationRequests.id, requestIds), endedRequest)).returning({ id: agentAuthorizationRequests.id })] : []),
    ...(pairingIds.length ? [db.delete(agentDeviceAuthorizations)
      .where(and(inArray(agentDeviceAuthorizations.id, pairingIds), endedPairing)).returning({ id: agentDeviceAuthorizations.id })] : []),
  ];
  if (statements.length === 0) return { requests: 0, pairings: 0 };
  const results = await safeBatch(db, statements as [typeof statements[number], ...typeof statements]) as { id: string }[][];
  return {
    requests: requestIds.length ? results[0]!.length : 0,
    pairings: pairingIds.length ? results.at(-1)!.length : 0,
  };
}
