import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import {
  KeyRound,
  MonitorSmartphone,
  Shield,
  ShieldPlus,
  UserRound,
  Users,
} from "lucide-react";
import {
  PageHeader,
  PageTabs,
  type PageHeaderLinkProps,
  type PageTabItem,
} from "~/components/admin/shell";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { RolesManagement } from "../RolesManagement";
import { ProfileHeader } from "./ProfileHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { TwoFactorSetup } from "./TwoFactorSetup";
import { AdminUsersManager } from "./AdminUsersManager";
import { AccountSessions } from "./AccountSessions";
import { normalizeAccountSection, type AccountSection } from "./account-sections";

const ACCOUNT_PANEL_ID = "account-settings-panel";

export interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
}

function BreadcrumbLink({ href, className, onClick, children }: PageHeaderLinkProps) {
  return (
    <Link to={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
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
      ? "profile"
      : section;

  useEffect(() => {
    if (activeSection !== section) {
      onSectionChange(activeSection, { replace: true });
    }
  }, [activeSection, onSectionChange, section]);

  // Personal settings first, then the ones that administer the store. They are
  // one tab strip, not a second left column: inside SettingsLayout the page
  // already sits beside the settings navigation, and a third column left the
  // administrators table about 330px wide.
  const personalSections: readonly (PageTabItem & { value: AccountSection })[] = [
    { value: "profile", label: "Profile", icon: UserRound },
    { value: "security", label: "Two-factor", icon: Shield },
    { value: "password", label: "Password", icon: KeyRound },
    { value: "sessions", label: "Sessions", icon: MonitorSmartphone },
  ];
  const storeSections: readonly (PageTabItem & { value: AccountSection })[] = [
    ...(canViewTeam
      ? [{ value: "team" as const, label: "Administrators", icon: Users }]
      : []),
    ...(canManageRoles
      ? [{ value: "roles" as const, label: "Roles", icon: ShieldPlus }]
      : []),
  ];
  const tabs = [...personalSections, ...storeSections];
  const activeTab = tabs.find((tab) => tab.value === activeSection) ?? tabs[0];

  const renderSection = () => {
    if (activeSection === "profile") return <ProfileHeader user={user} />;
    if (activeSection === "password") return <ChangePasswordForm />;
    if (activeSection === "sessions") return <AccountSessions />;
    if (activeSection === "team" && canViewTeam) {
      return <AdminUsersManager currentUserId={user.id} />;
    }
    if (activeSection === "roles" && canManageRoles) return <RolesManagement />;
    return <TwoFactorSetup user={user} />;
  };

  return (
    <div className="space-y-4 pb-8">
      <PageHeader
        title="Account"
        subtitle="Your identity, sign-in security, and who else can administer this store."
        breadcrumbs={[
          { label: "Settings", href: "/admin/settings" },
          { label: "Account" },
        ]}
        linkComponent={BreadcrumbLink}
      />

      <PageTabs
        tabs={tabs}
        value={activeSection}
        onChange={(value) => onSectionChange(normalizeAccountSection(value))}
        label="Account settings section"
        panelId={ACCOUNT_PANEL_ID}
      />

      <section
        id={ACCOUNT_PANEL_ID}
        role="tabpanel"
        aria-label={activeTab.label}
        className="min-w-0"
      >
        {renderSection()}
      </section>
    </div>
  );
}
