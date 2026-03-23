import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PermissionName } from "@scalius/core/auth/rbac/types";

interface PermissionContextValue {
  permissions: Set<string>;
  isSuperAdmin: boolean;
  hasPermission: (permission: PermissionName | string) => boolean;
  hasAnyPermission: (permissions: (PermissionName | string)[]) => boolean;
  hasAllPermissions: (permissions: (PermissionName | string)[]) => boolean;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

const EMPTY_CONTEXT: PermissionContextValue = {
  permissions: new Set(),
  isSuperAdmin: false,
  hasPermission: () => false,
  hasAnyPermission: () => false,
  hasAllPermissions: () => false,
};

interface PermissionProviderProps {
  children: ReactNode;
  permissions?: string[];
  isSuperAdmin?: boolean;
}

export function PermissionProvider({
  children,
  permissions: permissionsList = [],
  isSuperAdmin = false,
}: PermissionProviderProps) {
  // Serialize the permissions list to a stable string key so the memo
  // only re-computes when the actual permission values change, not on
  // every render due to a new array reference.
  const permissionsKey = permissionsList.join(",");

  const value = useMemo(() => {
    const permissionsSet = new Set(permissionsList);

    return {
      permissions: permissionsSet,
      isSuperAdmin,
      hasPermission: (permission: PermissionName | string) => {
        if (isSuperAdmin) return true;
        return permissionsSet.has(permission);
      },
      hasAnyPermission: (permissions: (PermissionName | string)[]) => {
        if (isSuperAdmin) return true;
        return permissions.some((p) => permissionsSet.has(p));
      },
      hasAllPermissions: (permissions: (PermissionName | string)[]) => {
        if (isSuperAdmin) return true;
        return permissions.every((p) => permissionsSet.has(p));
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsKey, isSuperAdmin]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions(): PermissionContextValue {
  const context = useContext(PermissionContext);
  return context ?? EMPTY_CONTEXT;
}

export function useHasPermission(permission: PermissionName | string): boolean {
  const { hasPermission } = usePermissions();
  return hasPermission(permission);
}

export function useHasAnyPermission(permissions: (PermissionName | string)[]): boolean {
  const { hasAnyPermission } = usePermissions();
  return hasAnyPermission(permissions);
}
