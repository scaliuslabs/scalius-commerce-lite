// src/lib/rbac/types.ts
import type { PERMISSIONS } from "./permissions";

// Permission string type derived from PERMISSIONS constant
export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Permission metadata for UI display and categorization
export interface PermissionMetadata {
  name: PermissionName;
  displayName: string;
  description: string;
  resource: string;
  action: string;
  category: string;
  isSensitive: boolean;
}

// Role with its permissions for API responses
export interface RoleWithPermissions {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionName[];
  createdAt: Date;
  updatedAt: Date;
}

// User permission override
export interface UserPermissionOverride {
  permissionId: string;
  permissionName: PermissionName;
  granted: boolean;
  assignedBy: string | null;
  createdAt: Date;
}

// User's complete permission context
export interface UserPermissionContext {
  userId: string;
  isSuperAdmin: boolean;
  roles: {
    id: string;
    name: string;
    displayName: string;
  }[];
  // All effective permissions (after role + override resolution)
  effectivePermissions: Set<PermissionName>;
  // Direct permission overrides
  overrides: {
    grants: PermissionName[];
    denials: PermissionName[];
  };
}

// Permission check result
export interface PermissionCheckResult {
  allowed: boolean;
  reason:
    | "super_admin"
    | "role_permission"
    | "user_grant"
    | "user_denial"
    | "no_permission";
}

// For API route protection
export interface ProtectedRouteConfig {
  permission: PermissionName;
  // Optional: allow if user has any of these permissions
  anyOf?: PermissionName[];
  // Optional: require all of these permissions
  allOf?: PermissionName[];
}

// For seeding/migration
export interface SystemRole {
  name: string;
  displayName: string;
  description: string;
  isSystem: boolean;
  permissions: PermissionName[];
}

// Permission categories for UI grouping
export type PermissionCategory =
  | "Products"
  | "Categories"
  | "Collections"
  | "Orders"
  | "Customers"
  | "Discounts"
  | "Pages"
  | "Widgets"
  | "Media"
  | "Attributes"
  | "Analytics"
  | "Settings"
  | "Team"
  | "Dashboard";

// Grouped permissions for UI display
export interface PermissionGroup {
  category: PermissionCategory;
  permissions: PermissionMetadata[];
}
