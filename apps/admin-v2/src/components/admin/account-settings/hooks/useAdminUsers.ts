import { useState, useEffect } from "react";
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

  const fetchAdminUsers = async () => {
    try {
      const result = await getAdminUsers();
      setAdminUsers(result.users);
    } catch {
      if (import.meta.env.DEV) console.error("Failed to fetch admin users");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchRoles = async () => {
    try {
      const result = await getRbacRoles();
      setAvailableRoles(result.roles.filter((r: Role) => r.name !== "super_admin"));
    } catch {
      if (import.meta.env.DEV) console.error("Failed to fetch roles");
    }
  };

  useEffect(() => {
    fetchAdminUsers();
    fetchRoles();
  }, []);

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
      fetchAdminUsers();
      return true;
    } catch (err: unknown) {
      throw new Error(getServerFnError(err, "Failed to create admin user"));
    }
  };

  const deleteUser = async (userId: string) => {
    try {
      await deleteAdminUser({ data: { userId } });
      toast.success("Admin user deleted successfully");
      fetchAdminUsers();
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to delete admin user"));
    }
  };

  return {
    adminUsers,
    availableRoles,
    isLoading,
    addUser,
    deleteUser,
    refetch: fetchAdminUsers,
  };
}
