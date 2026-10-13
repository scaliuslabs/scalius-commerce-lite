// Reconciles code-owned permissions and system roles without changing user authority.

import { workerCacheHint, type WorkerCacheHint } from "@scalius/shared/worker-cache-hint";
import { eq, count, inArray } from "drizzle-orm";
import { chunkForD1, type Database } from "@scalius/database/client";
import {
  permissions,
  roles,
  rolePermissions,
} from "@scalius/database/schema";
import { PERMISSIONS } from "./permissions";
import { getAllPermissions } from "./permission-metadata";

// A per-colo Cache API marker (keyed by the Worker version and the seed
// signature) spares the reconciliation reads; it expires, so a manual database
// reset heals within its lifetime. Do not retain an in-flight reconciliation
// Promise or binding-derived state in module scope: Workers may reuse this
// isolate for a later request or after bindings change.
const RBAC_SEED_CACHE_PREFIX = "rbac:seed-current:v5";
const RBAC_SEED_CACHE_TTL_SECONDS = 6 * 60 * 60;

/** The marker store for `autoSeedRbacIfNeeded`; null without the Cache API or a Worker version. */
export function rbacSeedMarker(
  env: { CF_VERSION_METADATA?: { id?: unknown } | null } | null | undefined,
): WorkerCacheHint | null {
  return workerCacheHint(env, "rbac-seed", RBAC_SEED_CACHE_TTL_SECONDS);
}

type SystemRoleSeed = {
  name: string;
  displayName: string;
  description: string;
  permissions: string[];
};

function getSystemRoleSeeds(): SystemRoleSeed[] {
  return [
    {
      name: "super_admin",
      displayName: "Super Admin",
      description: "Full access to all features and settings.",
      permissions: Object.values(PERMISSIONS),
    },
    {
      name: "manager",
      displayName: "Manager",
      description: "Full access except sensitive settings and role management.",
      permissions: Object.values(PERMISSIONS).filter(
        (p) =>
          !p.includes("permanent_delete") &&
          p !== PERMISSIONS.ORDERS_REFUND &&
          p !== PERMISSIONS.GIFT_CARDS_MANAGE &&
          p !== PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT &&
          p !== PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT &&
          p !== PERMISSIONS.TEAM_MANAGE_ROLES &&
          p !== PERMISSIONS.AGENT_ACCESS_VIEW &&
          p !== PERMISSIONS.AGENT_ACCESS_MANAGE &&
          p !== PERMISSIONS.WEBHOOKS_VIEW &&
          p !== PERMISSIONS.WEBHOOKS_MANAGE &&
          // Managers see and use installed apps; approving, configuring and
          // removing them stays with the Super Admin.
          p !== PERMISSIONS.APPS_MANAGE
      ),
    },
    {
      name: "sales_rep",
      displayName: "Sales Representative",
      description: "Access to orders, customers, and product viewing.",
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.PRODUCTS_VIEW,
        PERMISSIONS.CATEGORIES_VIEW,
        PERMISSIONS.COLLECTIONS_VIEW,
        PERMISSIONS.ORDERS_VIEW,
        PERMISSIONS.ORDERS_CREATE,
        PERMISSIONS.ORDERS_EDIT,
        PERMISSIONS.ORDERS_DELETE,
        PERMISSIONS.ORDERS_RESTORE,
        PERMISSIONS.ORDERS_CHANGE_STATUS,
        PERMISSIONS.ORDERS_MANAGE_SHIPMENTS,
        PERMISSIONS.CONVERSATIONS_VIEW,
        PERMISSIONS.CONVERSATIONS_REPLY,
        PERMISSIONS.CUSTOMERS_VIEW,
        PERMISSIONS.CUSTOMERS_CREATE,
        PERMISSIONS.CUSTOMERS_EDIT,
        PERMISSIONS.CUSTOMERS_VIEW_HISTORY,
        PERMISSIONS.DISCOUNTS_VIEW,
      ],
    },
    {
      name: "content_editor",
      displayName: "Content Editor",
      description: "Access to pages, media, and content settings.",
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.PAGES_VIEW,
        PERMISSIONS.PAGES_CREATE,
        PERMISSIONS.PAGES_EDIT,
        PERMISSIONS.PAGES_DELETE,
        PERMISSIONS.PAGES_PUBLISH,
        PERMISSIONS.METAOBJECTS_VIEW,
        PERMISSIONS.METAOBJECTS_EDIT,
        PERMISSIONS.MEDIA_VIEW,
        PERMISSIONS.MEDIA_UPLOAD,
        PERMISSIONS.MEDIA_DELETE,
        PERMISSIONS.MEDIA_MANAGE_FOLDERS,
        PERMISSIONS.COLLECTIONS_VIEW,
        PERMISSIONS.COLLECTIONS_EDIT,
        PERMISSIONS.COLLECTIONS_TOGGLE_STATUS,
        PERMISSIONS.SETTINGS_HEADER_EDIT,
        PERMISSIONS.SETTINGS_FOOTER_EDIT,
        PERMISSIONS.SETTINGS_SEO_EDIT,
      ],
    },
    {
      name: "product_specialist",
      displayName: "Product Specialist",
      description: "Full access to products, categories, collections, and attributes.",
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.PRODUCTS_VIEW,
        PERMISSIONS.PRODUCTS_VIEW_COSTS,
        PERMISSIONS.PRODUCTS_CREATE,
        PERMISSIONS.PRODUCTS_EDIT,
        PERMISSIONS.PRODUCTS_DELETE,
        PERMISSIONS.PRODUCTS_RESTORE,
        PERMISSIONS.PRODUCTS_BULK_OPERATIONS,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.INVENTORY_MANAGE,
        PERMISSIONS.CATEGORIES_VIEW,
        PERMISSIONS.CATEGORIES_CREATE,
        PERMISSIONS.CATEGORIES_EDIT,
        PERMISSIONS.CATEGORIES_DELETE,
        PERMISSIONS.CATEGORIES_RESTORE,
        PERMISSIONS.COLLECTIONS_VIEW,
        PERMISSIONS.COLLECTIONS_CREATE,
        PERMISSIONS.COLLECTIONS_EDIT,
        PERMISSIONS.COLLECTIONS_DELETE,
        PERMISSIONS.COLLECTIONS_RESTORE,
        PERMISSIONS.COLLECTIONS_TOGGLE_STATUS,
        PERMISSIONS.ATTRIBUTES_VIEW,
        PERMISSIONS.ATTRIBUTES_CREATE,
        PERMISSIONS.ATTRIBUTES_EDIT,
        PERMISSIONS.ATTRIBUTES_DELETE,
        PERMISSIONS.MEDIA_VIEW,
        PERMISSIONS.MEDIA_UPLOAD,
      ],
    },
  ];
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getRbacSeedCacheKey(): string {
  const permissionSignature = getAllPermissions()
    .map((permission) => [
      permission.name,
      permission.resource,
      permission.action,
      permission.category,
      permission.isSensitive ? "1" : "0",
    ].join(":"))
    .sort()
    .join("|");
  const roleSignature = getSystemRoleSeeds()
    .map((role) => `${role.name}:${[...role.permissions].sort().join(",")}`)
    .sort()
    .join("|");

  return `${RBAC_SEED_CACHE_PREFIX}:${hashString(`${permissionSignature}::${roleSignature}`)}`;
}

export async function isRbacSeedCacheCurrent(
  marker?: Pick<WorkerCacheHint, "get"> | null,
): Promise<boolean> {
  if (!marker) return false;
  try {
    return (await marker.get(getRbacSeedCacheKey())) === "1";
  } catch (error) {
    console.warn(
      "RBAC: Failed to read seed cache marker:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export async function markRbacSeedCacheCurrent(
  marker?: Pick<WorkerCacheHint, "put"> | null,
): Promise<void> {
  if (!marker) return;
  // A marker that is not written costs one more reconciliation read later.
  await marker.put(getRbacSeedCacheKey(), "1").catch(() => undefined);
}

/**
 * Check if RBAC is already seeded by counting permissions
 */
async function isRbacSeeded(db: Database): Promise<boolean> {
  const result = await db
    .select({ count: count() })
    .from(permissions)
    .get();
  return (result?.count ?? 0) > 0;
}

/**
 * Seed all permissions into the database
 */
async function seedPermissions(db: Database): Promise<void> {
  const allPermissions = getAllPermissions();
  const existingPermissions = await db.select({ name: permissions.name }).from(permissions);
  const existingNames = new Set(existingPermissions.map((permission) => permission.name));

  const missingPermissionInserts = allPermissions
    .filter((permission) => !existingNames.has(permission.name))
    .map((permission) =>
      db.insert(permissions).values({
        id: crypto.randomUUID(),
        name: permission.name,
        displayName: permission.displayName,
        description: permission.description,
        resource: permission.resource,
        action: permission.action,
        category: permission.category,
        isSensitive: permission.isSensitive,
        createdAt: new Date(),
      }).onConflictDoNothing(),
    );

  if (missingPermissionInserts.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Drizzle D1 batch statements
    await db.batch(missingPermissionInserts as any);
  }
}

/**
 * Seed system roles with their permissions
 */
async function seedRoles(db: Database): Promise<void> {
  const dbPermissions = await db.select({ id: permissions.id, name: permissions.name }).from(permissions);
  const permNameToId = new Map(dbPermissions.map((p) => [p.name, p.id]));
  const systemRoles = getSystemRoleSeeds();
  const systemRoleNames = systemRoles.map((role) => role.name);
  let dbRoles = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(inArray(roles.name, systemRoleNames));
  const existingRoleNames = new Set(dbRoles.map((role) => role.name));
  const missingRoleInserts = systemRoles
    .filter((role) => !existingRoleNames.has(role.name))
    .map((role) =>
      db.insert(roles).values({
        id: crypto.randomUUID(),
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        isSystem: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing(),
    );
  if (missingRoleInserts.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Drizzle D1 batch statements
    await db.batch(missingRoleInserts as any);
    dbRoles = await db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(inArray(roles.name, systemRoleNames));
  }

  const roleIdByName = new Map(dbRoles.map((role) => [role.name, role.id]));
  const roleIds = dbRoles.map((role) => role.id);
  const existingGrantRows = roleIds.length > 0
    ? await db
        .select({
          id: rolePermissions.id,
          roleId: rolePermissions.roleId,
          permissionId: rolePermissions.permissionId,
        })
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const existingGrants = new Set(
    existingGrantRows.map((grant) => `${grant.roleId}:${grant.permissionId}`),
  );
  const desiredGrants = new Set(systemRoles.flatMap((role) => {
    const roleId = roleIdByName.get(role.name);
    if (!roleId) return [];
    return role.permissions.flatMap((permissionName) => {
      const permissionId = permNameToId.get(permissionName);
      return permissionId ? [`${roleId}:${permissionId}`] : [];
    });
  }));
  const staleGrantIds = existingGrantRows
    .filter((grant) => !desiredGrants.has(`${grant.roleId}:${grant.permissionId}`))
    .map((grant) => grant.id);
  for (const chunk of chunkForD1(staleGrantIds)) {
    if (chunk.length > 0) {
      await db.delete(rolePermissions).where(inArray(rolePermissions.id, chunk));
    }
  }
  const missingGrantInserts = systemRoles.flatMap((role) => {
    const roleId = roleIdByName.get(role.name);
    if (!roleId) return [];
    return role.permissions.flatMap((permissionName) => {
      const permissionId = permNameToId.get(permissionName);
      if (!permissionId || existingGrants.has(`${roleId}:${permissionId}`)) return [];
      return [
        db.insert(rolePermissions).values({
          id: crypto.randomUUID(),
          roleId,
          permissionId,
          createdAt: new Date(),
        }).onConflictDoNothing(),
      ];
    });
  });
  if (missingGrantInserts.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Drizzle D1 batch statements
    await db.batch(missingGrantInserts as any);
  }
}

async function isRbacSeedCurrent(db: Database): Promise<boolean> {
  const allPermissions = getAllPermissions();
  const systemRoles = getSystemRoleSeeds();
  const systemRoleNames = systemRoles.map((role) => role.name);

  const [permissionRows, roleRows, grantRows] = await db.batch([
    db.select({ name: permissions.name }).from(permissions),
    db.select({ name: roles.name })
      .from(roles)
      .where(inArray(roles.name, systemRoleNames)),
    db.select({ roleName: roles.name, permissionName: permissions.name })
      .from(roles)
      .innerJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(inArray(roles.name, systemRoleNames)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
  ] as any) as [
    { name: string }[],
    { name: string }[],
    { roleName: string; permissionName: string }[],
  ];

  const permissionNames = new Set(permissionRows.map((permission) => permission.name));
  if (!allPermissions.every((permission) => permissionNames.has(permission.name))) {
    return false;
  }

  const roleNames = new Set(roleRows.map((role) => role.name));
  if (!systemRoles.every((role) => roleNames.has(role.name))) {
    return false;
  }

  const grants = new Set(
    grantRows.map((grant) => `${grant.roleName}:${grant.permissionName}`),
  );
  const expectedGrants = new Set(systemRoles.flatMap((role) =>
    role.permissions.map((permission) => `${role.name}:${permission}`),
  ));
  return grants.size === expectedGrants.size &&
    [...expectedGrants].every((grant) => grants.has(grant));
}

/**
 * Auto-seed RBAC if not already seeded
 * Called from middleware on admin route access
 * Safe to call multiple times - only seeds once
 */
async function runRbacSeedReconciliation(
  db: Database,
  kv?: Pick<WorkerCacheHint, "get" | "put"> | null,
): Promise<void> {
  try {
    if (await isRbacSeedCacheCurrent(kv)) {
      return;
    }

    const seeded = await isRbacSeeded(db);
    if (seeded && await isRbacSeedCurrent(db)) {
      await markRbacSeedCacheCurrent(kv);
      return;
    }

    if (!seeded) {
      console.log("RBAC: Auto-seeding permissions and roles...");
    } else {
      console.log("RBAC: Syncing missing permissions and system role grants...");
    }

    await seedPermissions(db);
    await seedRoles(db);

    if (!seeded) {
      console.log("RBAC: Auto-seeding complete.");
    } else {
      console.log("RBAC: Permission sync complete.");
    }

    await markRbacSeedCacheCurrent(kv);
  } catch (error: unknown) {
    console.error("RBAC: Auto-seeding failed:", error);
    // The missing marker makes a later request retry reconciliation.
  }
}

export async function autoSeedRbacIfNeeded(
  db: Database,
  kv?: Pick<WorkerCacheHint, "get" | "put"> | null,
): Promise<void> {
  await runRbacSeedReconciliation(db, kv);
}
