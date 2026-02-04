// src/components/admin/AccountSettingsWithPermissions.tsx
// Wrapper component that provides PermissionProvider context to AccountSettings
import { PermissionProvider } from "@/contexts/PermissionContext";
import { AccountSettings } from "./AccountSettings";

interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
}

interface AccountSettingsWithPermissionsProps {
  user: User;
  permissions?: string[];
  isSuperAdmin?: boolean;
}

export function AccountSettingsWithPermissions({
  user,
  permissions,
  isSuperAdmin,
}: AccountSettingsWithPermissionsProps) {
  return (
    <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
      <AccountSettings user={user} />
    </PermissionProvider>
  );
}
