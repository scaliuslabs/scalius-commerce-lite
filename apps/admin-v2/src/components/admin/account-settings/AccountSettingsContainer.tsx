import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Shield, KeyRound, Users, ShieldPlus } from "lucide-react";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { RolesManagement } from "../RolesManagement";
import { ProfileHeader } from "./ProfileHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { TwoFactorSetup } from "./TwoFactorSetup";
import { AdminUsersManager } from "./AdminUsersManager";

export interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
}

interface AccountSettingsProps {
  user: User;
}

export function AccountSettings({ user }: AccountSettingsProps) {
  const { hasPermission } = usePermissions();
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);
  const canViewTeam =
    hasPermission(PERMISSIONS.TEAM_VIEW) ||
    hasPermission(PERMISSIONS.TEAM_MANAGE) ||
    canManageRoles;

  return (
    <div className="space-y-6">
      <ProfileHeader user={user} />

      <Tabs defaultValue="security" className="space-y-6">
        <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent p-0 h-auto gap-0">
          <TabsTrigger value="security" className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
          <TabsTrigger value="password" className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Password
          </TabsTrigger>
          {canViewTeam && (
            <TabsTrigger value="team" className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Team
            </TabsTrigger>
          )}
          {canManageRoles && (
            <TabsTrigger value="roles" className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground flex items-center gap-2">
              <ShieldPlus className="h-4 w-4" />
              Roles
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="security" className="space-y-6">
          <TwoFactorSetup user={user} />
        </TabsContent>

        <TabsContent value="password" className="space-y-6">
          <ChangePasswordForm />
        </TabsContent>

        {canViewTeam && (
          <TabsContent value="team" className="space-y-6">
            <AdminUsersManager currentUserId={user.id} />
          </TabsContent>
        )}

        {canManageRoles && (
          <TabsContent value="roles" className="space-y-6">
            <RolesManagement />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
