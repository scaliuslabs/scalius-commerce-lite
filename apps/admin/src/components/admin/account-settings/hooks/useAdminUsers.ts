import { useState, useEffect } from "react";
import { toast } from "sonner";

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
  description: string | null;
  isSystem: boolean;
}

export function useAdminUsers() {
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [availableRoles, setAvailableRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAdminUsers = async () => {
    try {
      const response = await fetch("/api/v1/admin/auth/users");
      const json = await response.json();
      const result = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      if (response.ok) setAdminUsers(result.users);
    } catch {
      console.error("Failed to fetch admin users");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchRoles = async () => {
    try {
      const response = await fetch("/api/v1/admin/rbac/roles");
      const json2 = await response.json();
      const result = json2.data && typeof json2.data === "object" && !Array.isArray(json2.data) ? json2.data : json2;
      if (response.ok) {
        setAvailableRoles(result.roles.filter((r: Role) => r.name !== "super_admin"));
      }
    } catch {
      console.error("Failed to fetch roles");
    }
  };

  useEffect(() => {
    fetchAdminUsers();
    fetchRoles();
  }, []);

  const addUser = async (name: string, email: string, roleId: string): Promise<boolean> => {
    try {
      const response = await fetch("/api/v1/admin/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          roleId: roleId || undefined,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "Failed to create admin user");
      }

      toast.success("Admin user created. An email has been sent with login instructions.");
      fetchAdminUsers();
      return true;
    } catch (err) {
      throw err;
    }
  };

  const deleteUser = async (userId: string) => {
    try {
      const response = await fetch(`/api/v1/admin/auth/users/${userId}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (!response.ok) {
        toast.error(result.message || "Failed to delete admin user");
        return;
      }

      toast.success("Admin user deleted successfully");
      fetchAdminUsers();
    } catch {
      toast.error("An unexpected error occurred");
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
