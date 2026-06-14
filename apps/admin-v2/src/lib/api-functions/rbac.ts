import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export interface RbacRole {
  id: string;
  name: string;
  displayName: string;
  description?: string | null;
  isSystem: boolean;
  permissions: string[];
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
}

export interface RbacPermission {
  id: string;
  name: string;
  description: string | null;
  category: string;
}

export interface RbacPermissionMetadata {
  name: string;
  displayName: string;
  description: string;
  resource?: string;
  action?: string;
  category: string;
  isSensitive: boolean;
}

export interface RbacRolesResponse {
  roles: RbacRole[];
}

export interface RbacPermissionsResponse {
  permissions: RbacPermission[];
  grouped: Record<string, RbacPermissionMetadata[]>;
}

export interface CreateRbacRoleInput {
  name: string;
  displayName: string;
  description?: string;
  permissions: string[];
}

export interface UpdateRbacRoleInput {
  roleId: string;
  update: {
    displayName?: string;
    description?: string;
    permissions?: string[];
  };
}

export interface RbacRoleIdInput {
  roleId: string;
}

export interface UserRoleInput {
  userId: string;
  roleId: string;
}

export interface SetUserPermissionOverrideInput {
  userId: string;
  permission: string;
  granted: boolean;
}

export interface RemoveUserPermissionOverrideInput {
  userId: string;
  permission: string;
}

export const getRbacRoles = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<RbacRolesResponse>("/rbac/roles");
  },
);

export const getRbacPermissions = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<RbacPermissionsResponse>("/rbac/permissions");
  },
);

export const createRbacRole = createServerFn({ method: "POST" })
  .validator((data: CreateRbacRoleInput) => data)
  .handler(async ({ data }) => {
    return apiPost<{ role: RbacRole }>("/rbac/roles", data);
  });

export const updateRbacRole = createServerFn({ method: "POST" })
  .validator((data: UpdateRbacRoleInput) => data)
  .handler(async ({ data }) => {
    return apiPut<{ role: RbacRole }>(`/rbac/roles/${data.roleId}`, data.update);
  });

export const deleteRbacRole = createServerFn({ method: "POST" })
  .validator((data: RbacRoleIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<Record<string, never>>(`/rbac/roles/${data.roleId}`);
  });

export const assignUserRole = createServerFn({ method: "POST" })
  .validator((data: UserRoleInput) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, never>>("/rbac/user-roles", data);
  });

export const removeUserRole = createServerFn({ method: "POST" })
  .validator((data: UserRoleInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<Record<string, never>>("/rbac/user-roles", data);
  });

export const assignUserPermission = createServerFn({ method: "POST" })
  .validator((data: SetUserPermissionOverrideInput) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, never>>("/rbac/user-permissions", data);
  });

export const removeUserPermission = createServerFn({ method: "POST" })
  .validator((data: RemoveUserPermissionOverrideInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<Record<string, never>>("/rbac/user-permissions", data);
  });
