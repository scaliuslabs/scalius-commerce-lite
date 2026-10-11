// src/lib/rbac/helpers.ts
import { eq, and, desc, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import { deleteKvHint, putKvHint } from "@scalius/shared/kv-hints";
import { planLimits } from "@scalius/shared/plan-limits";
import { getRbacSeedCacheKey } from "./auto-seed";
import {
  user,
  permissions,
  roles,
  rolePermissions,
  userRoles,
  userPermissions,
} from "@scalius/database/schema";
import type { PermissionName, UserPermissionContext } from "./types";
import { getAllPermissionNames, withPrerequisites, withoutUnmetPrerequisites } from "./permissions";

// Every role or assignment mutation clears the affected entries, so the TTL is
// only a backstop; a long window keeps admin sessions from re-writing KV every
// five minutes.
const CACHE_TTL = 3600;
const PERMISSION_CACHE_VERSION = getRbacSeedCacheKey();

interface D1PermissionResolution {
  userFound: boolean;
  permissions: Set<string>;
}

/**
 * Get the cache key for a user's permissions
 */
function getPermCacheKey(userId: string): string {
  return `rbac:perms:${userId}:${PERMISSION_CACHE_VERSION}`;
}

/**
 * Clear the shared permission cache for a specific user.
 */
export async function clearPermissionCache(userId: string, kv?: KVNamespace): Promise<void> {
  if (!kv) return;
  if (planLimits().kv.permissionCache) {
    // Authoritative invalidation: a revoked grant must not outlive its entry.
    await kv.delete(getPermCacheKey(userId));
  } else {
    // Nothing reads the snapshot here, but a store that left a plan that
    // cached it may still have one: sweep it, and never fail the mutation.
    await deleteKvHint(kv, getPermCacheKey(userId));
  }
}

/**
 * Clear cached effective permissions for every user assigned to a role.
 */
export async function clearPermissionCacheForRole(
  db: Database,
  roleId: string,
  kv?: KVNamespace
): Promise<void> {
  const assignedUsers = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId));

  await Promise.all(
    assignedUsers.map(({ userId }) => clearPermissionCache(userId, kv))
  );
}

/**
 * Resolve a user's effective permissions directly from D1.
 *
 * Security-sensitive authority rechecks use this path so a revoked role grant
 * or a new explicit denial takes effect without waiting for local/KV caches to
 * expire. This function never reads from or writes to either permission cache.
 */
export async function getFreshUserPermissionsFromD1(
  db: Database,
  userId: string,
): Promise<Set<string>> {
  return (await resolveUserPermissionsFromD1(db, userId)).permissions;
}

/** A payload with no narrower resource contract is visible only to super-admins. */
export type StaffPermissionRequirement = PermissionName | "super_admin";

/**
 * Fresh set-based recipient authority: the same grants, explicit denials and
 * prerequisite closure as the resolver, plus current session ban semantics.
 * Kept in SQL so device fan-out needs no per-user permission/cache reads.
 */
export function staffPermissionSql(ownerId: SQLWrapper, required: StaffPermissionRequirement): SQL {
  const staff = alias(user, "recipient_staff");
  const effective = required === "super_admin" ? sql`1 = 0` : sql.join(
    [...withPrerequisites([required])].map((name) => sql`EXISTS (
      SELECT 1 FROM ${permissions}
      WHERE ${permissions.name} = ${name}
        AND NOT EXISTS (SELECT 1 FROM ${userPermissions}
          WHERE ${userPermissions.userId} = ${staff.id}
            AND ${userPermissions.permissionId} = ${permissions.id}
            AND ${userPermissions.granted} = 0)
        AND (EXISTS (SELECT 1 FROM ${userPermissions}
          WHERE ${userPermissions.userId} = ${staff.id}
            AND ${userPermissions.permissionId} = ${permissions.id}
            AND ${userPermissions.granted} = 1)
          OR EXISTS (SELECT 1 FROM ${userRoles}
            INNER JOIN ${rolePermissions} ON ${rolePermissions.roleId} = ${userRoles.roleId}
            WHERE ${userRoles.userId} = ${staff.id}
              AND ${rolePermissions.permissionId} = ${permissions.id}))
    )`), sql` AND `,
  );
  return sql`EXISTS (SELECT 1 FROM ${user} AS ${sql.identifier("recipient_staff")}
    WHERE ${staff.id} = ${ownerId}
      AND (${staff.banned} = 0 OR ${staff.banned} IS NULL
        OR (${staff.banExpires} IS NOT NULL AND ${staff.banExpires} <= unixepoch()))
      AND (${staff.isSuperAdmin} = 1 OR (${effective})))`;
}

/**
 * Get all effective permissions for a user
 * Resolution order:
 * 1. Super admin -> all permissions
 * 2. User-level denials (explicit deny overrides)
 * 3. User-level grants (explicit grant overrides)
 * 4. Role-based permissions (union of all assigned roles)
 */
export async function getUserPermissions(
  db: Database,
  userId: string,
  kv?: KVNamespace,
  knownIsSuperAdmin = false,
): Promise<Set<string>> {
  // Route middleware already loaded this flag from authoritative D1 session
  // state. Do not let a lagging seeded permission row or cached role snapshot
  // make the API disagree with the Admin shell about super-admin authority.
  if (knownIsSuperAdmin) {
    return new Set(getAllPermissionNames());
  }

  // KV is the cross-isolate source of truth. If a mutation deletes the KV
  // entry, this isolate must not keep serving its stale local memory value.
  // Where the plan profile turns the snapshot off (Workers Free: 1,000 KV
  // writes a day) every check resolves from D1, one batch, which is the
  // authority anyway.
  const cached = Boolean(kv) && planLimits().kv.permissionCache;
  if (kv && cached) {
    const kvCached = await kv.get<string[]>(getPermCacheKey(userId), "json");
    if (kvCached) {
      return new Set(kvCached);
    }
  }

  const resolution = await resolveUserPermissionsFromD1(db, userId);
  if (!resolution.userFound) {
    return new Set();
  }
  const effectivePermissions = resolution.permissions;

  // Cache the result in KV for other isolates.
  if (kv && cached) {
    await putKvHint(kv, getPermCacheKey(userId), JSON.stringify(Array.from(effectivePermissions)), { expirationTtl: CACHE_TTL });
  }

  return effectivePermissions;
}

async function resolveUserPermissionsFromD1(
  db: Database,
  userId: string,
): Promise<D1PermissionResolution> {
  // Keep the user/super-admin row, role grants, and user overrides in one D1
  // batch so every result comes from the same authoritative recheck.
  const [userResult, rolePerms, overrides] = await db.batch([
    db.select({ id: user.id, isSuperAdmin: user.isSuperAdmin })
      .from(user).where(eq(user.id, userId)).limit(1),
    db.select({ permissionName: permissions.name })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(userRoles.userId, userId)),
    db.select({ permissionName: permissions.name, granted: userPermissions.granted })
      .from(userPermissions)
      .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
      .where(eq(userPermissions.userId, userId)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
  ] as any) as [
    { id: string; isSuperAdmin: boolean | null }[],
    { permissionName: string }[],
    { permissionName: string; granted: boolean }[],
  ];

  const userData = userResult[0];
  if (!userData) {
    return { userFound: false, permissions: new Set() };
  }

  if (userData.isSuperAdmin) {
    return {
      userFound: true,
      permissions: new Set(getAllPermissionNames()),
    };
  }

  const effectivePermissions = new Set<string>(
    rolePerms.map((rolePermission) => rolePermission.permissionName),
  );
  for (const override of overrides) {
    if (override.granted) {
      effectivePermissions.add(override.permissionName);
    } else {
      effectivePermissions.delete(override.permissionName);
    }
  }

  // "Edit products" without "View products" grants nothing: a denied or
  // missing prerequisite takes its dependents with it.
  return { userFound: true, permissions: withoutUnmetPrerequisites(effectivePermissions) };
}

/**
 * Check if a user has a specific permission
 */
export async function hasPermission(
  db: Database,
  userId: string,
  permission: PermissionName | string,
  kv?: KVNamespace
): Promise<boolean> {
  const permissions = await getUserPermissions(db, userId, kv);
  return permissions.has(permission);
}

/**
 * Check if a user has any of the specified permissions
 */
export async function hasAnyPermission(
  db: Database,
  userId: string,
  permissionList: (PermissionName | string)[],
  kv?: KVNamespace
): Promise<boolean> {
  const permissions = await getUserPermissions(db, userId, kv);
  return permissionList.some((p) => permissions.has(p));
}

/**
 * Check if a user has all of the specified permissions
 */
export async function hasAllPermissions(
  db: Database,
  userId: string,
  permissionList: (PermissionName | string)[],
  kv?: KVNamespace
): Promise<boolean> {
  const permissions = await getUserPermissions(db, userId, kv);
  return permissionList.every((p) => permissions.has(p));
}

/**
 * Get full permission context for a user (for frontend use)
 */
export async function getUserPermissionContext(
  db: Database,
  userId: string,
  kv?: KVNamespace
): Promise<UserPermissionContext | null> {
  // Get user details
  const userResult = await db
    .select({
      id: user.id,
      isSuperAdmin: user.isSuperAdmin,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (userResult.length === 0) {
    return null;
  }

  const userData = userResult[0];
  if (!userData) return null;

  // Get assigned roles
  const userRoleData = await db
    .select({
      id: roles.id,
      name: roles.name,
      displayName: roles.displayName,
    })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));

  // Get user permission overrides
  const overrides = await db
    .select({
      permissionName: permissions.name,
      granted: userPermissions.granted,
    })
    .from(userPermissions)
    .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
    .where(eq(userPermissions.userId, userId));

  const grants: PermissionName[] = [];
  const denials: PermissionName[] = [];

  for (const override of overrides) {
    if (override.granted) {
      grants.push(override.permissionName as PermissionName);
    } else {
      denials.push(override.permissionName as PermissionName);
    }
  }

  // Get effective permissions
  const effectivePermissions = await getUserPermissions(db, userId, kv);

  return {
    userId,
    isSuperAdmin: userData.isSuperAdmin ?? false,
    roles: userRoleData,
    effectivePermissions: effectivePermissions as Set<PermissionName>,
    overrides: {
      grants,
      denials,
    },
  };
}

/**
 * Check if a user is super admin
 */
export async function isSuperAdmin(
  db: Database,
  userId: string
): Promise<boolean> {
  const result = await db
    .select({ isSuperAdmin: user.isSuperAdmin })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return result.length > 0 && result[0]?.isSuperAdmin === true;
}

/**
 * Get all roles with their permissions
 */
export async function getAllRolesWithPermissions(
  db: Database,
  options: { limit?: number; offset?: number } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 51));
  const offset = Math.max(0, options.offset ?? 0);
  const allRoles = await db
    .select()
    .from(roles)
    .orderBy(desc(roles.createdAt), desc(roles.id))
    .limit(limit)
    .offset(offset);
  const permissionRows = allRoles.length === 0
    ? []
    : await db
      .select({
        roleId: rolePermissions.roleId,
        name: permissions.name,
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(inArray(rolePermissions.roleId, allRoles.map(({ id }) => id)));
  const permissionNamesByRoleId = new Map<string, string[]>();
  for (const row of permissionRows) {
    const names = permissionNamesByRoleId.get(row.roleId) ?? [];
    names.push(row.name);
    permissionNamesByRoleId.set(row.roleId, names);
  }

  return allRoles.map((role) => ({
    id: role.id.slice(0, 100),
    name: role.name.slice(0, 50),
    displayName: role.displayName.slice(0, 100),
    description: role.description?.slice(0, 500) ?? null,
    isSystem: role.isSystem,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
    permissions: (permissionNamesByRoleId.get(role.id) ?? [])
      .slice(0, 200)
      .map((name) => name.slice(0, 150)),
    permissionsTruncated: (permissionNamesByRoleId.get(role.id)?.length ?? 0) > 200,
  }));
}

/**
 * Get permissions for a specific role
 */
export async function getRolePermissions(
  db: Database,
  roleId: string
): Promise<string[]> {
  const perms = await db
    .select({ name: permissions.name })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  return perms.map((p) => p.name);
}

/**
 * Assign a role to a user
 */
export async function assignRoleToUser(
  db: Database,
  userId: string,
  roleId: string,
  assignedBy?: string,
  kv?: KVNamespace
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(userRoles).values({
    id,
    userId,
    roleId,
    assignedBy: assignedBy ?? null,
    createdAt: new Date(),
  });

  // Clear cache in KV
  await clearPermissionCache(userId, kv);
}

/**
 * Remove a role from a user
 */
export async function removeRoleFromUser(
  db: Database,
  userId: string,
  roleId: string,
  kv?: KVNamespace
): Promise<void> {
  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)));

  // Clear cache in KV
  await clearPermissionCache(userId, kv);
}

/**
 * Set a permission override for a user
 */
export async function setUserPermissionOverride(
  db: Database,
  userId: string,
  permissionName: string,
  granted: boolean,
  assignedBy?: string,
  kv?: KVNamespace
): Promise<void> {
  // Get permission ID
  const permResult = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, permissionName))
    .limit(1);

  if (permResult.length === 0) {
    throw new NotFoundError(`Permission "${permissionName}" not found`);
  }

  const permissionId = permResult[0]?.id;
  if (!permissionId) {
    throw new NotFoundError(`Permission "${permissionName}" not found`);
  }

  // Check if override already exists
  const existing = await db
    .select({ id: userPermissions.id })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.permissionId, permissionId)
      )
    )
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    // Update existing override
    await db
      .update(userPermissions)
      .set({ granted, assignedBy: assignedBy ?? null })
      .where(eq(userPermissions.id, existing[0].id));
  } else {
    // Create new override
    const id = crypto.randomUUID();
    await db.insert(userPermissions).values({
      id,
      userId,
      permissionId,
      granted,
      assignedBy: assignedBy ?? null,
      createdAt: new Date(),
    });
  }

  // Clear cache in KV
  await clearPermissionCache(userId, kv);
}

/**
 * Remove a permission override for a user
 */
export async function removeUserPermissionOverride(
  db: Database,
  userId: string,
  permissionName: string,
  kv?: KVNamespace
): Promise<void> {
  // Get permission ID
  const permResult = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, permissionName))
    .limit(1);

  if (permResult.length === 0) {
    return; // Permission doesn't exist, nothing to remove
  }

  const permId = permResult[0]?.id;
  if (!permId) return;

  await db
    .delete(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.permissionId, permId)
      )
    );

  // Clear cache in KV
  await clearPermissionCache(userId, kv);
}

/**
 * Check if user has admin access (at least one permission or is super admin)
 */
export async function hasAdminAccess(
  db: Database,
  userId: string,
  kv?: KVNamespace
): Promise<boolean> {
  // Check if super admin
  const userResult = await db
    .select({ isSuperAdmin: user.isSuperAdmin })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (userResult.length === 0) {
    return false;
  }

  if (userResult[0]?.isSuperAdmin) {
    return true;
  }

  // Check if user has any permissions (through roles or overrides)
  const permissions = await getUserPermissions(db, userId, kv);
  return permissions.size > 0;
}
