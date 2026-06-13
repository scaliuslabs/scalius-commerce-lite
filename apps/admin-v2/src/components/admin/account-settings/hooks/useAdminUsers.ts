import { useState, useEffect } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getAdminUsers as getAdminUsersFn,
  createAdminUser,
  deleteAdminUser,
} from "~/lib/api.functions";
import { getRbacRoles } from "~/lib/api-functions/rbac";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  twoFactorEnabled?: boolean | null;
  isSuperAdmin?: boolean | null;
  createdAt: string;
  roles: { id: string; name: string; displayName: string }[];
  overrides: { grants: string[]; denials: string[] };
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

  const fetchAdminUsers = async () => {
    try {
      const result = await getAdminUsersFn() as unknown as { users: AdminUser[] };
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
      await createAdminUser({
        data: {
          name,
          email,
          roleId: roleId || undefined,
        },
      });

      toast.success("Admin user created. An email has been sent with login instructions.");
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
