import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { agentCredentials, agentGrants, user } from "@scalius/database/schema";
import { getFreshUserPermissionsFromD1 } from "@scalius/core/auth/rbac/helpers";
import { getAllPermissionNames } from "@scalius/core/auth/rbac/permissions";
import { getBearerToken, parseAgentCredential, verifyAgentCredentialHash } from "./pat";
import type {
  AgentGrantKind,
  AgentGrantPreset,
  AgentPrincipal,
  AgentResource,
  AgentRisk,
} from "./types";

interface PrincipalLookup {
  grantId: string;
  credentialId: string | null;
  resource: AgentResource;
}

interface GrantAuthorityRow {
  grantId: string;
  credentialId: string | null;
  credentialKind: "pat" | "cli" | null;
  tokenHash: string | null;
  ownerUserId: string | null;
  resource: AgentResource;
  grantKind: AgentGrantKind;
  preset: AgentGrantPreset;
  permissionsJson: string;
  riskCeiling: AgentRisk;
  authorityRevision: number;
  grantExpiresAt: Date;
  credentialExpiresAt: Date | null;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  mustEnrollTwoFactor: boolean;
  twoFactorEnabled: boolean;
}

function parsePermissionSnapshot(value: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return null;
    const knownPermissions = new Set(getAllPermissionNames());
    return new Set(parsed.filter((permission) => knownPermissions.has(permission)));
  } catch {
    return null;
  }
}

async function getLiveGrantAuthority(
  db: Database,
  lookup: PrincipalLookup,
): Promise<GrantAuthorityRow | null> {
  const now = new Date();
  const row = await db
    .select({
      grantId: agentGrants.id,
      credentialId: agentCredentials.id,
      credentialKind: agentCredentials.kind,
      tokenHash: agentCredentials.tokenHash,
      ownerUserId: agentGrants.ownerUserId,
      resource: agentGrants.resource,
      grantKind: agentGrants.kind,
      preset: agentGrants.preset,
      permissionsJson: agentGrants.permissionsJson,
      riskCeiling: agentGrants.riskCeiling,
      authorityRevision: agentGrants.authorityRevision,
      grantExpiresAt: agentGrants.expiresAt,
      credentialExpiresAt: agentCredentials.expiresAt,
      isSuperAdmin: user.isSuperAdmin,
      mustChangePassword: user.mustChangePassword,
      mustEnrollTwoFactor: user.mustEnrollTwoFactor,
      twoFactorEnabled: user.twoFactorEnabled,
    })
    .from(agentGrants)
    .innerJoin(user, eq(agentGrants.ownerUserId, user.id))
    .leftJoin(agentCredentials, lookup.credentialId
      ? and(
          eq(agentCredentials.grantId, agentGrants.id),
          eq(agentCredentials.id, lookup.credentialId),
          isNull(agentCredentials.revokedAt),
          gt(agentCredentials.expiresAt, now),
        )
      : eq(agentCredentials.id, "__oauth_has_no_credential__"))
    .where(and(
      eq(agentGrants.id, lookup.grantId),
      eq(agentGrants.resource, lookup.resource),
      eq(agentGrants.status, "active"),
      gt(agentGrants.expiresAt, now),
      or(
        eq(user.banned, false),
        isNull(user.banned),
        and(eq(user.banned, true), lte(user.banExpires, now)),
      ),
      eq(user.mustChangePassword, false),
      eq(user.mustEnrollTwoFactor, false),
    ))
    .get();

  if (!row || (lookup.credentialId && row.credentialId !== lookup.credentialId)) return null;
  if (row.twoFactorEnabled !== true) return null;
  return row as GrantAuthorityRow;
}

export async function resolveAgentPrincipalFromGrant(
  db: Database,
  lookup: PrincipalLookup,
): Promise<AgentPrincipal | null> {
  const row = await getLiveGrantAuthority(db, lookup);
  if (!row?.ownerUserId) return null;
  const snapshot = parsePermissionSnapshot(row.permissionsJson);
  if (!snapshot) return null;
  const live = await getFreshUserPermissionsFromD1(db, row.ownerUserId);
  // A user with no live administrative authority is no longer an eligible
  // merchant grant owner, including for storefront agentGrant operations.
  if (live.size === 0) return null;
  const permissions = new Set([...snapshot].filter((permission) => live.has(permission)));
  const expiresAt = row.credentialExpiresAt && row.credentialExpiresAt < row.grantExpiresAt
    ? row.credentialExpiresAt
    : row.grantExpiresAt;

  return {
    kind: "agent",
    grantId: row.grantId,
    credentialId: row.credentialId,
    ownerUserId: row.ownerUserId,
    isSuperAdmin: row.isSuperAdmin,
    resource: row.resource,
    grantKind: row.grantKind,
    preset: row.preset,
    permissions,
    riskCeiling: row.riskCeiling,
    authorityRevision: row.authorityRevision,
    expiresAt,
  };
}

export async function resolveAgentPrincipalFromBearer(
  db: Database,
  tokenOrAuthorization: string,
  pepper: string | null | undefined,
): Promise<AgentPrincipal | null> {
  const token = getBearerToken(tokenOrAuthorization) ?? tokenOrAuthorization.trim();
  const parsed = parseAgentCredential(token);
  const normalizedPepper = pepper?.trim();
  if (!parsed || !normalizedPepper) return null;

  const credential = await db
    .select({
      id: agentCredentials.id,
      grantId: agentCredentials.grantId,
      kind: agentCredentials.kind,
      tokenHash: agentCredentials.tokenHash,
      resource: agentGrants.resource,
    })
    .from(agentCredentials)
    .innerJoin(agentGrants, eq(agentCredentials.grantId, agentGrants.id))
    .where(and(
      eq(agentCredentials.id, parsed.credentialId),
      eq(agentCredentials.kind, parsed.kind),
      isNull(agentCredentials.revokedAt),
      gt(agentCredentials.expiresAt, new Date()),
    ))
    .get();
  if (!credential) return null;
  if (!await verifyAgentCredentialHash(parsed, credential.tokenHash, normalizedPepper)) return null;

  return resolveAgentPrincipalFromGrant(db, {
    grantId: credential.grantId,
    credentialId: credential.id,
    resource: credential.resource,
  });
}
