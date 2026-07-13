import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  createAdminUser,
  deleteAdminUser,
  getAdminUsers,
  type AdminUser,
} from "~/lib/api-functions/auth-management";
import { getRbacRoles } from "~/lib/api-functions/rbac";

export type { AdminUser } from "~/lib/api-functions/auth-management";

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
      const result = await getAdminUsers();
      setAdminUsers(result.users);
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
      const result = await createAdminUser({
        data: {
          name,
          email,
          roleId: roleId || undefined,
        },
      });

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
      await deleteAdminUser({ data: { userId } });
      toast.success("Admin user deleted successfully");
      await fetchAdminUsers();
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to delete admin user"));
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
    refetch: fetchAdminUsers,
    refetchRoles: fetchRoles,
  };
}
