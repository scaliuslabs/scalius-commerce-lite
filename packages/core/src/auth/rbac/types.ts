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

// Permission categories for UI grouping
export type PermissionCategory =
  | "Products"
  | "Categories"
  | "Collections"
  | "Orders"
  | "Customers"
  | "Discounts"
  | "Pages"
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
