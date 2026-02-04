// src/lib/rbac/auto-seed.ts
// Auto-seeds permissions, roles, and sets first admin as super admin on first access

import { eq, count, asc } from "drizzle-orm";
import type { Database } from "@/db";
import {
  user,
  permissions,
  roles,
  rolePermissions,
  userRoles,
} from "@/db/schema";
import { PERMISSIONS, getAllPermissions } from "./permissions";

// Track if seeding has been checked this isolate lifecycle
let seedingChecked = false;

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

  for (const perm of allPermissions) {
    try {
      await db.insert(permissions).values({
        id: crypto.randomUUID(),
        name: perm.name,
        displayName: perm.displayName,
        description: perm.description,
        resource: perm.resource,
        action: perm.action,
        category: perm.category,
        isSensitive: perm.isSensitive,
        createdAt: new Date(),
      });
    } catch (error: any) {
      // Skip if already exists (UNIQUE constraint)
      if (!error.message?.includes("UNIQUE constraint failed")) {
        console.error(`Error seeding permission ${perm.name}:`, error.message);
      }
    }
  }
}

/**
 * Seed system roles with their permissions
 */
async function seedRoles(db: Database): Promise<void> {
  // Get all permissions from database
  const dbPermissions = await db.select().from(permissions);
  const permNameToId = new Map(dbPermissions.map((p) => [p.name, p.id]));

  const systemRoles = [
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
          p !== PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT &&
          p !== PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT &&
          p !== PERMISSIONS.TEAM_MANAGE_ROLES
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
      description: "Access to pages, widgets, media, and content settings.",
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.PAGES_VIEW,
        PERMISSIONS.PAGES_CREATE,
        PERMISSIONS.PAGES_EDIT,
        PERMISSIONS.PAGES_DELETE,
        PERMISSIONS.PAGES_PUBLISH,
        PERMISSIONS.WIDGETS_VIEW,
        PERMISSIONS.WIDGETS_CREATE,
        PERMISSIONS.WIDGETS_EDIT,
        PERMISSIONS.WIDGETS_DELETE,
        PERMISSIONS.WIDGETS_TOGGLE_STATUS,
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
        PERMISSIONS.PRODUCTS_CREATE,
        PERMISSIONS.PRODUCTS_EDIT,
        PERMISSIONS.PRODUCTS_DELETE,
        PERMISSIONS.PRODUCTS_RESTORE,
        PERMISSIONS.PRODUCTS_BULK_OPERATIONS,
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

  for (const roleData of systemRoles) {
    try {
      // Check if role already exists
      const existingRole = await db
        .select()
        .from(roles)
        .where(eq(roles.name, roleData.name))
        .limit(1);

      let roleId: string;

      if (existingRole.length > 0) {
        roleId = existingRole[0].id;
      } else {
        roleId = crypto.randomUUID();
        await db.insert(roles).values({
          id: roleId,
          name: roleData.name,
          displayName: roleData.displayName,
          description: roleData.description,
          isSystem: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Add permissions to role
      for (const permName of roleData.permissions) {
        const permId = permNameToId.get(permName);
        if (permId) {
          try {
            await db.insert(rolePermissions).values({
              id: crypto.randomUUID(),
              roleId,
              permissionId: permId,
              createdAt: new Date(),
            });
          } catch {
            // Skip if already exists
          }
        }
      }
    } catch (error: any) {
      console.error(`Error seeding role ${roleData.name}:`, error.message);
    }
  }
}

/**
 * Set the first admin user as super admin
 */
async function setFirstAdminAsSuperAdmin(db: Database): Promise<void> {
  // Get the first admin user by createdAt
  const firstAdmin = await db
    .select()
    .from(user)
    .where(eq(user.role, "admin"))
    .orderBy(asc(user.createdAt))
    .limit(1);

  if (firstAdmin.length > 0 && !firstAdmin[0].isSuperAdmin) {
    await db
      .update(user)
      .set({ isSuperAdmin: true })
      .where(eq(user.id, firstAdmin[0].id));
  }
}

/**
 * Auto-seed RBAC if not already seeded
 * Called from middleware on admin route access
 * Safe to call multiple times - only seeds once
 */
export async function autoSeedRbacIfNeeded(db: Database): Promise<void> {
  // Quick check to avoid repeated DB calls in same isolate
  if (seedingChecked) {
    return;
  }

  try {
    const seeded = await isRbacSeeded(db);

    if (!seeded) {
      console.log("RBAC: Auto-seeding permissions and roles...");
      await seedPermissions(db);
      await seedRoles(db);
      await setFirstAdminAsSuperAdmin(db);
      console.log("RBAC: Auto-seeding complete.");
    } else {
      // Check if first admin needs super admin status
      const firstAdmin = await db
        .select({ id: user.id, isSuperAdmin: user.isSuperAdmin })
        .from(user)
        .where(eq(user.role, "admin"))
        .orderBy(asc(user.createdAt))
        .limit(1);

      if (firstAdmin.length > 0 && !firstAdmin[0].isSuperAdmin) {
        await setFirstAdminAsSuperAdmin(db);
      }
    }

    seedingChecked = true;
  } catch (error) {
    console.error("RBAC: Auto-seeding failed:", error);
    // Don't set seedingChecked so it retries on next request
  }
}
