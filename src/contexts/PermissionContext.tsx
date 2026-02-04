// src/contexts/PermissionContext.tsx
import React, { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from "react";
import type { PermissionName } from "@/lib/rbac/types";

// Extend Window interface for TypeScript
declare global {
  interface Window {
    __USER_PERMISSIONS__?: string[];
    __IS_SUPER_ADMIN__?: boolean;
  }
}

interface PermissionContextValue {
  permissions: Set<string>;
  isSuperAdmin: boolean;
  hasPermission: (permission: PermissionName | string) => boolean;
  hasAnyPermission: (permissions: (PermissionName | string)[]) => boolean;
  hasAllPermissions: (permissions: (PermissionName | string)[]) => boolean;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

interface PermissionProviderProps {
  children: ReactNode;
  permissions?: string[];
  isSuperAdmin?: boolean;
}

export function PermissionProvider({
  children,
  permissions: permissionsList,
  isSuperAdmin: isSuperAdminProp,
}: PermissionProviderProps) {
  // If permissions are not provided as props, try to get them from window
  const [permsFromWindow, setPermsFromWindow] = useState<string[]>([]);
  const [superAdminFromWindow, setSuperAdminFromWindow] = useState(false);

  useEffect(() => {
    // Get permissions from window if not provided as props
    if (typeof window !== "undefined") {
      if (window.__USER_PERMISSIONS__) {
        setPermsFromWindow(window.__USER_PERMISSIONS__);
      }
      if (window.__IS_SUPER_ADMIN__) {
        setSuperAdminFromWindow(window.__IS_SUPER_ADMIN__);
      }
    }
  }, []);

  const permissions = permissionsList ?? permsFromWindow;
  const isSuperAdmin = isSuperAdminProp ?? superAdminFromWindow;

  const value = useMemo(() => {
    const permissionsSet = new Set(permissions);

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
  }, [permissions, isSuperAdmin]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

/**
 * Hook to get permissions directly from window (for components that can't use context)
 * Uses the same logic as PermissionProvider but without React context
 */
export function useWindowPermissions(): PermissionContextValue {
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (window.__USER_PERMISSIONS__) {
        setPermissions(new Set(window.__USER_PERMISSIONS__));
      }
      if (window.__IS_SUPER_ADMIN__) {
        setIsSuperAdmin(window.__IS_SUPER_ADMIN__);
      }
    }
  }, []);

  return useMemo(
    () => ({
      permissions,
      isSuperAdmin,
      hasPermission: (permission: PermissionName | string) => {
        if (isSuperAdmin) return true;
        return permissions.has(permission);
      },
      hasAnyPermission: (permList: (PermissionName | string)[]) => {
        if (isSuperAdmin) return true;
        return permList.some((p) => permissions.has(p));
      },
      hasAllPermissions: (permList: (PermissionName | string)[]) => {
        if (isSuperAdmin) return true;
        return permList.every((p) => permissions.has(p));
      },
    }),
    [permissions, isSuperAdmin]
  );
}

export function usePermissions(): PermissionContextValue {
  const context = useContext(PermissionContext);
  const windowPerms = useWindowPermissions();

  // If context is available, use it; otherwise fall back to window permissions
  if (context) {
    return context;
  }

  // Return window permissions as fallback (for components not wrapped in provider)
  return windowPerms;
}

// Hook for checking a single permission
export function useHasPermission(permission: PermissionName | string): boolean {
  const { hasPermission } = usePermissions();
  return hasPermission(permission);
}

// Hook for checking any of multiple permissions
export function useHasAnyPermission(permissions: (PermissionName | string)[]): boolean {
  const { hasAnyPermission } = usePermissions();
  return hasAnyPermission(permissions);
}
