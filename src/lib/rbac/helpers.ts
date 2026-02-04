// src/lib/rbac/helpers.ts
import { eq, and, inArray } from "drizzle-orm";
import type { Database } from "@/db";
import {
  user,
  permissions,
  roles,
  rolePermissions,
  userRoles,
  userPermissions,
} from "@/db/schema";
import type { PermissionName, UserPermissionContext, PermissionCheckResult } from "./types";

// Simple in-memory cache for user permissions
// In production, consider using Redis or a more robust caching solution
const permissionCache = new Map<
  string,
  { permissions: Set<string>; timestamp: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Clear the permission cache for a specific user
 */
export function clearPermissionCache(userId: string): void {
  permissionCache.delete(userId);
}

/**
 * Clear all permission caches
 */
export function clearAllPermissionCache(): void {
  permissionCache.clear();
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
  userId: string
): Promise<Set<string>> {
  // Check cache first
  const cached = permissionCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.permissions;
  }

  // Get user details including isSuperAdmin
  const userResult = await db
    .select({
      id: user.id,
      isSuperAdmin: user.isSuperAdmin,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (userResult.length === 0) {
    return new Set();
  }

  const userData = userResult[0];

  // Super admin has all permissions
  if (userData.isSuperAdmin) {
    const allPerms = await db.select({ name: permissions.name }).from(permissions);
    const permSet = new Set(allPerms.map((p) => p.name));
    permissionCache.set(userId, { permissions: permSet, timestamp: Date.now() });
    return permSet;
  }

  // Get role-based permissions
  const rolePerms = await db
    .select({ permissionName: permissions.name })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId));

  const effectivePermissions = new Set<string>(rolePerms.map((rp) => rp.permissionName));

  // Get user-level overrides
  const overrides = await db
    .select({
      permissionName: permissions.name,
      granted: userPermissions.granted,
    })
    .from(userPermissions)
    .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
    .where(eq(userPermissions.userId, userId));

  // Apply overrides
  for (const override of overrides) {
    if (override.granted) {
      // Grant: add to effective permissions
      effectivePermissions.add(override.permissionName);
    } else {
      // Denial: remove from effective permissions
      effectivePermissions.delete(override.permissionName);
    }
  }

  // Cache the result
  permissionCache.set(userId, {
    permissions: effectivePermissions,
    timestamp: Date.now(),
  });

  return effectivePermissions;
}

/**
 * Check if a user has a specific permission
 */
export async function hasPermission(
  db: Database,
  userId: string,
  permission: PermissionName | string
): Promise<boolean> {
  const permissions = await getUserPermissions(db, userId);
  return permissions.has(permission);
}

/**
 * Check if a user has any of the specified permissions
 */
export async function hasAnyPermission(
  db: Database,
  userId: string,
  permissionList: (PermissionName | string)[]
): Promise<boolean> {
  const permissions = await getUserPermissions(db, userId);
  return permissionList.some((p) => permissions.has(p));
}

/**
 * Check if a user has all of the specified permissions
 */
export async function hasAllPermissions(
  db: Database,
  userId: string,
  permissionList: (PermissionName | string)[]
): Promise<boolean> {
  const permissions = await getUserPermissions(db, userId);
  return permissionList.every((p) => permissions.has(p));
}

/**
 * Get detailed permission check result with reason
 */
export async function checkPermissionDetailed(
  db: Database,
  userId: string,
  permission: PermissionName | string
): Promise<PermissionCheckResult> {
  // Check if super admin
  const userResult = await db
    .select({ isSuperAdmin: user.isSuperAdmin })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (userResult.length === 0) {
    return { allowed: false, reason: "no_permission" };
  }

  if (userResult[0].isSuperAdmin) {
    return { allowed: true, reason: "super_admin" };
  }

  // Check user-level override first
  const permResult = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, permission))
    .limit(1);

  if (permResult.length === 0) {
    return { allowed: false, reason: "no_permission" };
  }

  const permId = permResult[0].id;

  const override = await db
    .select({ granted: userPermissions.granted })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.permissionId, permId)
      )
    )
    .limit(1);

  if (override.length > 0) {
    if (override[0].granted) {
      return { allowed: true, reason: "user_grant" };
    } else {
      return { allowed: false, reason: "user_denial" };
    }
  }

  // Check role-based permission
  const roleCheck = await db
    .select({ roleId: rolePermissions.roleId })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(rolePermissions.permissionId, permId)
      )
    )
    .limit(1);

  if (roleCheck.length > 0) {
    return { allowed: true, reason: "role_permission" };
  }

  return { allowed: false, reason: "no_permission" };
}

/**
 * Get full permission context for a user (for frontend use)
 */
export async function getUserPermissionContext(
  db: Database,
  userId: string
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
  const effectivePermissions = await getUserPermissions(db, userId);

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

  return result.length > 0 && result[0].isSuperAdmin === true;
}

/**
 * Get all roles with their permissions
 */
export async function getAllRolesWithPermissions(
  db: Database
) {
  const allRoles = await db.select().from(roles);

  const rolesWithPerms = await Promise.all(
    allRoles.map(async (role) => {
      const perms = await db
        .select({ name: permissions.name })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, role.id));

      return {
        ...role,
        permissions: perms.map((p) => p.name),
      };
    })
  );

  return rolesWithPerms;
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
  assignedBy?: string
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(userRoles).values({
    id,
    userId,
    roleId,
    assignedBy: assignedBy ?? null,
    createdAt: new Date(),
  });

  // Clear cache
  clearPermissionCache(userId);
}

/**
 * Remove a role from a user
 */
export async function removeRoleFromUser(
  db: Database,
  userId: string,
  roleId: string
): Promise<void> {
  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)));

  // Clear cache
  clearPermissionCache(userId);
}

/**
 * Set a permission override for a user
 */
export async function setUserPermissionOverride(
  db: Database,
  userId: string,
  permissionName: string,
  granted: boolean,
  assignedBy?: string
): Promise<void> {
  // Get permission ID
  const permResult = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.name, permissionName))
    .limit(1);

  if (permResult.length === 0) {
    throw new Error(`Permission "${permissionName}" not found`);
  }

  const permissionId = permResult[0].id;

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

  if (existing.length > 0) {
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

  // Clear cache
  clearPermissionCache(userId);
}

/**
 * Remove a permission override for a user
 */
export async function removeUserPermissionOverride(
  db: Database,
  userId: string,
  permissionName: string
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

  await db
    .delete(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.permissionId, permResult[0].id)
      )
    );

  // Clear cache
  clearPermissionCache(userId);
}

/**
 * Check if user has admin access (at least one permission or is super admin)
 */
export async function hasAdminAccess(
  db: Database,
  userId: string
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

  if (userResult[0].isSuperAdmin) {
    return true;
  }

  // Check if user has any permissions (through roles or overrides)
  const permissions = await getUserPermissions(db, userId);
  return permissions.size > 0;
}
