import type { Context } from "hono";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import {
  constantTimeAssistantHashEqual,
  hashAssistantArguments,
  resolveAssistantSessionByAgentInstance,
  type AssistantSessionView,
} from "@scalius/core/modules/assistant";
import {
  ForbiddenError,
  UnauthorizedError,
} from "@scalius/core/errors";
import {
  session as dashboardSessions,
  user as users,
} from "@scalius/database/schema";
import { retryTransientD1 } from "@scalius/core/utils/transient-d1";

import { ADMIN_COMMAND_POLICY_DIGEST } from "../../modules/assistant";
import {
  assertCurrentStorefrontAssistantSession,
  resolveStorefrontAssistantDeploymentContext,
} from "./storefront-assistant-context";

const ADMIN_SESSION_METADATA_VERSION = 1;
const MAX_ACTIVE_DASHBOARD_SESSIONS = 50;

export interface AdminFlueCommandAuthority {
  session: AssistantSessionView;
  permissions: ReadonlySet<string>;
}

export async function resolveAdminFlueCommandAuthority(
  c: Context<{ Bindings: Env }>,
  instanceId: string,
): Promise<AdminFlueCommandAuthority> {
  const db = c.get("db");
  const assistantSession = await resolveAssistantSessionByAgentInstance(db, {
    agentInstanceId: instanceId,
    expectedSurface: "admin",
  });
  const actorId = assistantSession.actorId?.trim();
  const dashboardSessionHash = readDashboardSessionHash(
    assistantSession.safeMetadata,
  );
  if (
    assistantSession.actorType !== "admin" ||
    !actorId ||
    !dashboardSessionHash ||
    !assistantSession.permissionSnapshotHash
  ) {
    throw new UnauthorizedError("Assistant session is unavailable.");
  }

  const now = new Date();
  const [userRows, sessionRows] = await retryTransientD1(() => db.batch([
    db.select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      banned: users.banned,
      banExpires: users.banExpires,
      twoFactorEnabled: users.twoFactorEnabled,
      mustChangePassword: users.mustChangePassword,
      mustEnrollTwoFactor: users.mustEnrollTwoFactor,
    }).from(users).where(and(
      eq(users.id, actorId),
      sql`(
        ${users.banned} = 0
        OR ${users.banned} IS NULL
        OR (${users.banExpires} IS NOT NULL AND ${users.banExpires} <= unixepoch())
      )`,
    )).limit(1),
    db.select({
      id: dashboardSessions.id,
      twoFactorVerified: dashboardSessions.twoFactorVerified,
    }).from(dashboardSessions).where(and(
      eq(dashboardSessions.userId, actorId),
      gt(dashboardSessions.expiresAt, now),
    )).orderBy(desc(dashboardSessions.updatedAt))
      .limit(MAX_ACTIVE_DASHBOARD_SESSIONS),
  ])) as [
    Array<{
      id: string;
      isSuperAdmin: boolean | null;
      banned: boolean | null;
      banExpires: Date | null;
      twoFactorEnabled: boolean | null;
      mustChangePassword: boolean | null;
      mustEnrollTwoFactor: boolean | null;
    }>,
    Array<{ id: string; twoFactorVerified: boolean | null }>,
  ];
  const user = userRows[0];
  if (!user) throw new UnauthorizedError("Assistant session is unavailable.");

  const matchedSession = await findDashboardSessionByHash(
    sessionRows,
    dashboardSessionHash,
  );
  if (!matchedSession) {
    throw new UnauthorizedError("Assistant session is unavailable.");
  }
  if (truthy(user.mustChangePassword)) {
    throw new ForbiddenError("Dashboard onboarding must be completed.");
  }
  if (truthy(user.mustEnrollTwoFactor) && !truthy(user.twoFactorEnabled)) {
    throw new ForbiddenError("Dashboard onboarding must be completed.");
  }
  if (truthy(user.twoFactorEnabled) && !truthy(matchedSession.twoFactorVerified)) {
    throw new ForbiddenError("Two-factor verification is required.");
  }

  await retryTransientD1(() => autoSeedRbacIfNeeded(db, c.env.CACHE));
  const permissions = await getUserPermissions(
    db,
    actorId,
    c.env.CACHE,
    truthy(user.isSuperAdmin),
  );
  if (permissions.size === 0) {
    throw new ForbiddenError("Admin access is required.");
  }
  const currentPermissionHash = await hashAssistantArguments({
    version: "admin-assistant-permission-snapshot:v1",
    surface: "admin",
    actorId,
    permissions: [...permissions].sort(),
    commandPolicyDigest: ADMIN_COMMAND_POLICY_DIGEST,
  });
  if (!constantTimeAssistantHashEqual(
    assistantSession.permissionSnapshotHash,
    currentPermissionHash,
  )) {
    throw new ForbiddenError("Admin permissions changed; start a new assistant thread.");
  }

  return { session: assistantSession, permissions };
}

export async function resolveStorefrontFlueCommandAuthority(
  c: Context<{ Bindings: Env }>,
  instanceId: string,
): Promise<AssistantSessionView> {
  const [session, deployment] = await Promise.all([
    resolveAssistantSessionByAgentInstance(c.get("db"), {
      agentInstanceId: instanceId,
      expectedSurface: "storefront",
    }),
    resolveStorefrontAssistantDeploymentContext(c),
  ]);
  assertCurrentStorefrontAssistantSession(session, deployment);
  if (
    session.actorType !== "guest" &&
    session.actorType !== "customer"
  ) {
    throw new UnauthorizedError("Assistant session is unavailable.");
  }
  return session;
}

function readDashboardSessionHash(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === ADMIN_SESSION_METADATA_VERSION &&
      typeof record.dashboardSessionHash === "string" &&
      /^[a-f0-9]{64}$/u.test(record.dashboardSessionHash)
    ? record.dashboardSessionHash
    : null;
}

async function findDashboardSessionByHash(
  sessions: readonly { id: string; twoFactorVerified: boolean | null }[],
  expectedHash: string,
) {
  const hashes = await Promise.all(sessions.map((session) =>
    hashAssistantArguments({
      version: "admin-assistant-dashboard-session:v1",
      dashboardSessionId: session.id,
    })));
  const index = hashes.findIndex((hash) =>
    constantTimeAssistantHashEqual(hash, expectedHash));
  return index >= 0 ? sessions[index] ?? null : null;
}

function truthy(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}
