import { useEffect } from "react";
import {
  KeyRound,
  MonitorSmartphone,
  Shield,
  ShieldPlus,
  Users,
} from "lucide-react";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { RolesManagement } from "../RolesManagement";
import { ProfileHeader } from "./ProfileHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { TwoFactorSetup } from "./TwoFactorSetup";
import { AdminUsersManager } from "./AdminUsersManager";
import { AccountSessions } from "./AccountSessions";
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

  const personalSections = [
    { value: "security" as const, label: "Two-factor", icon: Shield },
    { value: "password" as const, label: "Password", icon: KeyRound },
    { value: "sessions" as const, label: "Sessions", icon: MonitorSmartphone },
  ];
  const storeSections = [
    ...(canViewTeam
      ? [{ value: "team" as const, label: "Administrators", icon: Users }]
      : []),
    ...(canManageRoles
      ? [{ value: "roles" as const, label: "Roles", icon: ShieldPlus }]
      : []),
  ];

  const renderSection = () => {
    if (activeSection === "password") return <ChangePasswordForm />;
    if (activeSection === "sessions") return <AccountSessions />;
    if (activeSection === "team" && canViewTeam) {
      return <AdminUsersManager currentUserId={user.id} />;
    }
    if (activeSection === "roles" && canManageRoles) return <RolesManagement />;
    return <TwoFactorSetup user={user} />;
  };

  const renderNavigationItem = ({
    value,
    label,
    icon: Icon,
  }: (typeof personalSections)[number] | (typeof storeSections)[number]) => {
    const active = value === activeSection;

    return (
      <button
        key={value}
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSectionChange(value)}
        className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:w-full lg:justify-start ${
          active
            ? "bg-foreground text-background"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-4 pb-8">
      <ProfileHeader user={user} />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
        <nav
          aria-label="Account settings"
          className="min-w-0 rounded-xl border bg-card p-2 lg:sticky lg:top-4"
        >
          <div className="overflow-x-auto pb-1 lg:overflow-visible lg:pb-0">
            <div className="flex min-w-max gap-1 lg:min-w-0 lg:flex-col">
              <p className="flex items-center px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground lg:block lg:px-3 lg:pb-1 lg:pt-2 lg:text-[11px]">
                Personal
              </p>
              {personalSections.map(renderNavigationItem)}
              {storeSections.length > 0 && (
                <div
                  className="mx-1 w-px shrink-0 bg-border lg:my-2 lg:h-px lg:w-auto"
                  aria-hidden="true"
                />
              )}
              {storeSections.length > 0 && (
                <p className="flex items-center px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground lg:block lg:px-3 lg:pb-1 lg:pt-1 lg:text-[11px]">
                  Store access
                </p>
              )}
              {storeSections.map(renderNavigationItem)}
            </div>
          </div>
        </nav>

        <section className="min-w-0" aria-live="polite">
          {renderSection()}
        </section>
      </div>
    </div>
  );
}
