import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  deleteApiV1AdminAuthUsersById,
  getApiV1AdminAuthUsers,
  postApiV1AdminAuthUsers,
  postApiV1AdminAuthUsersByIdResendSetup,
  postApiV1AdminAuthUsersByIdSuspension,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "~/lib/api";
import { getRbacRoles } from "~/lib/api-query-options/rbac";

export type AdminUser = ApiResult<typeof getApiV1AdminAuthUsers>["users"][number];

/** Every administrator; the API pages this list in small pages. */
async function getAdminUsers(): Promise<AdminUser[]> {
  const users: AdminUser[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const result = await apiData(getApiV1AdminAuthUsers({ query: { page, limit: 2 } }));
    users.push(...result.users);
    if (!result.pagination.hasMore) return users;
  }
  throw new Error("Administrator list exceeded the supported page limit");
}

export interface Role {
  id: string;
  name: string;
  displayName: string;
  description?: string | null;
  isSystem: boolean;
}

export function useAdminUsers() {
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [availableRoles, setAvailableRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingRoles, setIsLoadingRoles] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);

  const fetchAdminUsers = useCallback(async () => {
    setIsLoading(true);
    setUsersError(null);
    try {
      setAdminUsers(await getAdminUsers());
    } catch (error) {
      setUsersError(getServerFnError(error, "Administrators could not be loaded."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchRoles = useCallback(async () => {
    setIsLoadingRoles(true);
    setRolesError(null);
    try {
      const result = await getRbacRoles();
      setAvailableRoles(result.roles.filter((r: Role) => r.name !== "super_admin"));
    } catch (error) {
      setRolesError(getServerFnError(error, "Roles could not be loaded."));
    } finally {
      setIsLoadingRoles(false);
    }
  }, []);

  useEffect(() => {
    void fetchAdminUsers();
    void fetchRoles();
  }, [fetchAdminUsers, fetchRoles]);

  const addUser = async (name: string, email: string, roleId: string): Promise<boolean> => {
    try {
      const result = await apiData(postApiV1AdminAuthUsers({
        body: {
          name,
          email,
          roleId: roleId || undefined,
        },
      }));

      if (result.emailFailed) {
        toast.warning(result.message);
      } else {
        toast.success(result.message);
      }
      await fetchAdminUsers();
      return true;
    } catch (err: unknown) {
      throw new Error(getServerFnError(err, "Failed to create admin user"));
    }
  };

  const deleteUser = async (userId: string) => {
    try {
      const result = await apiData(deleteApiV1AdminAuthUsersById({ path: { id: userId } }));
      toast.success(result.message);
      await fetchAdminUsers();
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to delete admin user"));
    }
  };

  const resendSetup = async (userId: string) => {
    try {
      const result = await apiData(postApiV1AdminAuthUsersByIdResendSetup({ path: { id: userId } }));
      toast.success(result.message);
    } catch (err) {
      throw new Error(getServerFnError(err, "Could not resend the setup email"));
    } finally {
      await fetchAdminUsers();
    }
  };

  const updateSuspension = async (userId: string, suspended: boolean) => {
    try {
      const result = await apiData(postApiV1AdminAuthUsersByIdSuspension({ path: { id: userId }, body: { suspended } }));
      toast.success(result.message);
      await fetchAdminUsers();
    } catch (err) {
      throw new Error(
        getServerFnError(
          err,
          suspended
            ? "Could not suspend this administrator"
            : "Could not restore this administrator",
        ),
      );
    }
  };

  return {
    adminUsers,
    availableRoles,
    isLoading,
    isLoadingRoles,
    usersError,
    rolesError,
    addUser,
    deleteUser,
    resendSetup,
    updateSuspension,
    refetch: fetchAdminUsers,
    refetchRoles: fetchRoles,
  };
}
