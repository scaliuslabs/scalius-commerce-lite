// What each permission is called and how it is grouped, for the roles screens
// and database seeding. Apart from permissions.ts: the dashboard checks
// permissions on every page but shows this table only on the roles screens,
// so it never rides in the dashboard's first download.
import type { PermissionMetadata, PermissionCategory } from "./types";
// The table, which the API Worker ships as a Text module.
import { PERMISSION_METADATA } from "#permission-metadata-table";

export { PERMISSION_METADATA };

// Get all permissions grouped by category
export function getPermissionsByCategory(): Record<
  PermissionCategory,
  PermissionMetadata[]
> {
  const grouped: Record<PermissionCategory, PermissionMetadata[]> = {
    Products: [],
    Categories: [],
    Collections: [],
    Orders: [],
    Customers: [],
    Discounts: [],
    Pages: [],
    Media: [],
    Attributes: [],
    Analytics: [],
    Settings: [],
    Team: [],
    Dashboard: [],
  };

  for (const meta of Object.values(PERMISSION_METADATA)) {
    grouped[meta.category as PermissionCategory].push(meta);
  }

  return grouped;
}

// Get all permissions as metadata array
export function getAllPermissions(): PermissionMetadata[] {
  return Object.values(PERMISSION_METADATA);
}

// Check if a permission is sensitive
export function isSensitivePermission(permission: string): boolean {
  const meta = PERMISSION_METADATA[permission as keyof typeof PERMISSION_METADATA];
  return meta?.isSensitive ?? false;
}

