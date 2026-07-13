import { useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Shield, KeyRound, Users, ShieldPlus } from "lucide-react";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { RolesManagement } from "../RolesManagement";
import { ProfileHeader } from "./ProfileHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { TwoFactorSetup } from "./TwoFactorSetup";
import { AdminUsersManager } from "./AdminUsersManager";
import type { AccountSection } from "./account-sections";

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
  section: AccountSection;
  onSectionChange: (
    section: AccountSection,
    options?: { replace?: boolean },
  ) => void;
}

export function AccountSettings({
  user,
  section,
  onSectionChange,
}: AccountSettingsProps) {
  const { hasPermission } = usePermissions();
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);
  const canViewTeam =
    hasPermission(PERMISSIONS.TEAM_VIEW) ||
    hasPermission(PERMISSIONS.TEAM_MANAGE) ||
    canManageRoles;
  const activeSection =
    (section === "team" && !canViewTeam) ||
    (section === "roles" && !canManageRoles)
      ? "security"
      : section;

  useEffect(() => {
    if (activeSection !== section) {
      onSectionChange(activeSection, { replace: true });
    }
  }, [activeSection, onSectionChange, section]);

  return (
    <div className="space-y-4 pb-8">
      <ProfileHeader user={user} />

      <Tabs
        value={activeSection}
        onValueChange={(value) => onSectionChange(value as AccountSection)}
        className="space-y-4"
      >
        <div className="rounded-xl border bg-card p-2">
          <TabsList
            aria-label="Account settings sections"
            className="grid h-auto w-full grid-cols-1 gap-2 bg-transparent p-0 sm:grid-cols-2"
          >
            <div className="min-w-0 rounded-lg bg-muted/35 p-1" role="presentation">
              <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Personal
              </p>
              <div className="grid grid-cols-2 gap-1" role="presentation">
                <TabsTrigger value="security" className="min-h-11 justify-start gap-2 px-2.5 text-sm data-[state=active]:bg-background data-[state=active]:shadow-none sm:min-h-9">
                  <Shield className="h-4 w-4" />
                  Two-factor
                </TabsTrigger>
                <TabsTrigger value="password" className="min-h-11 justify-start gap-2 px-2.5 text-sm data-[state=active]:bg-background data-[state=active]:shadow-none sm:min-h-9">
                  <KeyRound className="h-4 w-4" />
                  Password
                </TabsTrigger>
              </div>
            </div>
            {(canViewTeam || canManageRoles) && (
              <div className="min-w-0 rounded-lg bg-muted/35 p-1" role="presentation">
                <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Store access
                </p>
                <div className="grid grid-cols-2 gap-1" role="presentation">
                  {canViewTeam && (
                    <TabsTrigger value="team" className="min-h-11 justify-start gap-2 px-2.5 text-sm data-[state=active]:bg-background data-[state=active]:shadow-none sm:min-h-9">
                      <Users className="h-4 w-4" />
                      Administrators
                    </TabsTrigger>
                  )}
                  {canManageRoles && (
                    <TabsTrigger value="roles" className="min-h-11 justify-start gap-2 px-2.5 text-sm data-[state=active]:bg-background data-[state=active]:shadow-none sm:min-h-9">
                      <ShieldPlus className="h-4 w-4" />
                      Roles
                    </TabsTrigger>
                  )}
                </div>
              </div>
            )}
          </TabsList>
        </div>

        <TabsContent value="security" className="mt-0 space-y-4">
          <TwoFactorSetup user={user} />
        </TabsContent>

        <TabsContent value="password" className="mt-0 max-w-3xl space-y-4">
          <ChangePasswordForm />
        </TabsContent>

        {canViewTeam && (
          <TabsContent value="team" className="mt-0 space-y-4">
            <AdminUsersManager currentUserId={user.id} />
          </TabsContent>
        )}

        {canManageRoles && (
          <TabsContent value="roles" className="mt-0 space-y-4">
            <RolesManagement />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
