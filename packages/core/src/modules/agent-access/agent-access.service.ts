import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, safeBatch } from "@scalius/database/client";
import {
  agentAuditEvents,
  agentAuthorizationRequests,
  agentCredentials,
  agentDeviceAuthorizations,
  agentGrants,
  user,
} from "@scalius/database/schema";
import { getAllPermissionNames, isSensitivePermission } from "../../auth/rbac/permissions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors";

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

export interface IssuedCredentialRecord {
  id: string;
  grantId: string;
  kind: "pat" | "cli";
  tokenHash: string;
  tokenHint: string;
  expiresAt: Date;
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
  const requested = input.permissions === undefined ? caller : canonicalPermissions(input.permissions);
  if (requested.some((permission) => !caller.includes(permission))) {
    throw new ForbiddenError("A connection cannot receive permissions its owner lacks");
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
    label: input.label?.trim().slice(0, 120) || (kind === "cli" ? "Scalius CLI" : "Agent connection"),
    resource: input.resource,
    preset: input.preset,
    permissions,
    riskCeiling,
    expiresAt: new Date(Date.now() + requestedDays * 86_400_000),
  };
}

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
    status: "active",
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
        "AGENT_PARENT_AUTHORITY_INACTIVE",
      )
    : null;
  await safeBatch(db, [
    ...(parentGuard ? [parentGuard] : []),
    grantInsert,
    credentialInsert,
  ]);
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

export async function listAgentConnections(
  db: Database,
  input: {
    page: number;
    limit: number;
    status?: string;
    resource?: AgentResource;
    kind?: string;
    ownerUserId?: string;
  },
) {
  const now = new Date();
  const filters = [
    input.status && input.status !== "expired" ? eq(agentGrants.status, input.status as "pending" | "active" | "revoked") : undefined,
    input.status && input.status !== "expired" && input.status !== "revoked"
      ? gt(agentGrants.expiresAt, now)
      : undefined,
    input.resource ? eq(agentGrants.resource, input.resource) : undefined,
    input.kind ? eq(agentGrants.kind, input.kind as "oauth" | "pat" | "cli") : undefined,
    input.status === "expired"
      ? and(inArray(agentGrants.status, ["pending", "active"]), sql`${agentGrants.expiresAt} <= unixepoch()`)
      : undefined,
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
      createdAt: agentGrants.createdAt,
      updatedAt: agentGrants.updatedAt,
    }).from(agentGrants).leftJoin(user, eq(agentGrants.ownerUserId, user.id))
      .where(where).orderBy(desc(agentGrants.createdAt))
      .limit(input.limit).offset((input.page - 1) * input.limit);
  const grantIds = grants.map((grant) => grant.id);
  const credentials = grantIds.length
    ? await db.select().from(agentCredentials).where(inArray(agentCredentials.grantId, grantIds))
    : [];
  return {
    connections: grants.map((grant) => ({
      ...grant,
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
    permissions: safeJsonArray(permissionsJson),
    status: statusFor(grant),
    credentials,
  };
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
      metadata: (() => { try { return JSON.parse(row.metadataJson) as Record<string, unknown>; } catch { return {}; } })(),
      resourceIdsJson: undefined,
      metadataJson: undefined,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function revokeAgentGrant(
  db: Database,
  grantId: string,
  actorUserId: string,
  reason?: string,
) {
  const now = new Date();
  const results = await safeBatch(db, [
    db.update(agentGrants).set({
      status: "revoked",
      revokedByUserId: actorUserId,
      revokedReason: reason?.trim().slice(0, 240) || "Revoked by administrator",
      revokedAt: now,
      updatedAt: now,
    }).where(and(eq(agentGrants.id, grantId), eq(agentGrants.status, "active"))).returning({ id: agentGrants.id }),
    db.update(agentCredentials).set({ revokedAt: now, updatedAt: now })
      .where(and(eq(agentCredentials.grantId, grantId), isNull(agentCredentials.revokedAt))),
  ]);
  const updated = results[0] as { id: string }[] | undefined;
  if (!updated?.[0]) throw new NotFoundError("Active agent connection not found");
  return { status: "revoked" as const, grantId };
}

export async function revokeAllAgentGrants(
  db: Database,
  actorUserId: string,
  resource?: AgentResource,
  reason?: string,
) {
  const now = new Date();
  const resourcePredicate = resource ? sql`AND resource = ${resource}` : sql``;
  const results = await safeBatch(db, [
    db.update(agentCredentials).set({ revokedAt: now, updatedAt: now }).where(and(
      isNull(agentCredentials.revokedAt),
      sql`${agentCredentials.grantId} IN (SELECT id FROM agent_grants WHERE status = 'active' ${resourcePredicate})`,
    )).returning({ id: agentCredentials.id }),
    db.update(agentGrants).set({
      status: "revoked",
      revokedByUserId: actorUserId,
      revokedReason: reason?.trim().slice(0, 240) || "Revoked by administrator",
      revokedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentGrants.status, "active"),
      resource ? eq(agentGrants.resource, resource) : undefined,
    )).returning({ id: agentGrants.id }),
  ]);
  const grantRows = results[1] as { id: string }[] | undefined;
  return { status: "revoked" as const, count: grantRows?.length ?? 0 };
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
  return { ...row, status, requestedPermissions: [] as string[] };
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
    "AGENT_AUTHORIZATION_NOT_PENDING",
  );
  await safeBatch(db, [
    guard,
    db.insert(agentGrants).values({
      id: grantId,
      kind: "oauth",
      ownerUserId: input.actorUserId,
      resource: request.resource,
      label: input.selection.label,
      oauthClientId: request.clientId,
      oauthClientName: request.clientName,
      oauthRedirectUrisJson: JSON.stringify([request.redirectUri]),
      preset: input.selection.preset,
      permissionsJson: JSON.stringify(input.selection.permissions),
      riskCeiling: input.selection.riskCeiling,
      status: "active",
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
    label: input.label?.trim().slice(0, 120) || current.label,
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
    throw new ConflictError("AGENT_GRANT_AUTHORITY_CHANGED");
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
    "AGENT_CREDENTIAL_NOT_ACTIVE",
  );
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
    eq(agentDeviceAuthorizations.status, "pending"),
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
    "AGENT_DEVICE_NOT_PENDING",
  );
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
      status: "active",
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
      status: "approved",
      approvedByUserId: input.actorUserId,
      decidedAt: now,
      grantId,
      credentialId: input.credentialId,
      encryptedDeliveryEnvelope: input.encryptedDeliveryEnvelope,
      updatedAt: now,
    }).where(and(
      eq(agentDeviceAuthorizations.id, input.deviceId),
      eq(agentDeviceAuthorizations.status, "pending"),
    )),
  ]);
  return { status: "approved" as const, grantId, credentialId: input.credentialId };
}

export async function denyDeviceAuthorization(
  db: Database,
  deviceId: string,
  actorUserId: string,
) {
  const rows = await db.update(agentDeviceAuthorizations).set({
    status: "denied",
    approvedByUserId: actorUserId,
    decidedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(agentDeviceAuthorizations.id, deviceId),
    eq(agentDeviceAuthorizations.status, "pending"),
    gt(agentDeviceAuthorizations.expiresAt, new Date()),
  )).returning({ id: agentDeviceAuthorizations.id });
  if (!rows[0]) throw new NotFoundError("Pending device authorization not found");
  return { status: "denied" as const };
}
