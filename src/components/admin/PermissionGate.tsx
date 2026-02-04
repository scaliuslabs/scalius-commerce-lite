// src/components/admin/PermissionGate.tsx
import type { ReactNode } from "react";
import { usePermissions } from "@/contexts/PermissionContext";
import type { PermissionName } from "@/lib/rbac/types";

interface PermissionGateProps {
  children: ReactNode;
  // Single permission to check
  permission?: PermissionName | string;
  // Check if user has ANY of these permissions
  anyOf?: (PermissionName | string)[];
  // Check if user has ALL of these permissions
  allOf?: (PermissionName | string)[];
  // What to render if permission check fails (defaults to null)
  fallback?: ReactNode;
  // Invert the check (render if user does NOT have the permission)
  invert?: boolean;
}

/**
 * PermissionGate - Conditionally render children based on user permissions
 *
 * Usage examples:
 *
 * Single permission:
 * <PermissionGate permission="products.create">
 *   <Button>Create Product</Button>
 * </PermissionGate>
 *
 * Any of multiple permissions:
 * <PermissionGate anyOf={["products.create", "products.edit"]}>
 *   <ProductForm />
 * </PermissionGate>
 *
 * All of multiple permissions:
 * <PermissionGate allOf={["products.view", "products.edit"]}>
 *   <ProductEditor />
 * </PermissionGate>
 *
 * With fallback:
 * <PermissionGate permission="discounts.view" fallback={<p>Access denied</p>}>
 *   <DiscountsList />
 * </PermissionGate>
 *
 * Inverted (render if user does NOT have permission):
 * <PermissionGate permission="products.delete" invert>
 *   <p>Contact admin to delete products</p>
 * </PermissionGate>
 */
export function PermissionGate({
  children,
  permission,
  anyOf,
  allOf,
  fallback = null,
  invert = false,
}: PermissionGateProps) {
  const { hasPermission, hasAnyPermission, hasAllPermissions, isSuperAdmin } = usePermissions();

  let allowed = false;

  // Super admin always has access (unless inverted)
  if (isSuperAdmin && !invert) {
    return <>{children}</>;
  }

  // Check permissions
  if (permission) {
    allowed = hasPermission(permission);
  } else if (anyOf && anyOf.length > 0) {
    allowed = hasAnyPermission(anyOf);
  } else if (allOf && allOf.length > 0) {
    allowed = hasAllPermissions(allOf);
  } else {
    // No permission specified, allow by default
    allowed = true;
  }

  // Invert if needed
  if (invert) {
    allowed = !allowed;
  }

  return allowed ? <>{children}</> : <>{fallback}</>;
}

/**
 * withPermission - Higher-order component for permission-based rendering
 *
 * Usage:
 * const ProtectedButton = withPermission("products.create", Button);
 */
export function withPermission<P extends object>(
  permission: PermissionName | string,
  Component: React.ComponentType<P>,
  fallback?: ReactNode
) {
  return function PermissionWrappedComponent(props: P) {
    return (
      <PermissionGate permission={permission} fallback={fallback}>
        <Component {...props} />
      </PermissionGate>
    );
  };
}
