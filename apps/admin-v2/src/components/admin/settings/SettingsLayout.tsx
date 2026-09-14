import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "@scalius/shared/utils";
import { PageHeader, type PageHeaderAction } from "../shell";
import { usePermissions } from "~/contexts/PermissionContext";
import { SettingsNav, type SettingsNavLinkProps } from "./SettingsNav";
import {
  getVisibleSettingsNavGroups,
  SETTINGS_INDEX_PATH,
} from "./settings-navigation";
import type { GeneralSettingsSection } from "./general-settings-sections";

function RouterLink({ href, children, ...rest }: SettingsNavLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

export interface SettingsLayoutProps {
  /** Current pathname, so the navigation can highlight this destination. */
  pathname: string;
  /**
   * Page title. Omit when the page component already renders its own
   * `PageHeader` (checkout, account, agent access), so the title is not shown
   * twice.
   */
  title?: string;
  description?: ReactNode;
  primaryAction?: PageHeaderAction;
  secondaryActions?: readonly PageHeaderAction[];
  /** Extra header content, e.g. a `StatusBadge`. */
  headerChildren?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * The frame every standalone settings route shares: the settings area's own
 * navigation on the left from `lg` up, the page on the right, and a link back
 * to the settings index on narrow widths where the navigation is a list page
 * of its own.
 */
export function SettingsLayout({
  pathname,
  title,
  description,
  primaryAction,
  secondaryActions,
  headerChildren,
  children,
  className,
}: SettingsLayoutProps) {
  const { permissions, isSuperAdmin } = usePermissions();
  const navigate = useNavigate();
  const groups = useMemo(
    () => getVisibleSettingsNavGroups(permissions, isSuperAdmin),
    [permissions, isSuperAdmin],
  );

  function openSection(section: GeneralSettingsSection) {
    void navigate({
      to: SETTINGS_INDEX_PATH,
      search: { section } as never,
    });
  }

  return (
    <div className={cn("mx-auto max-w-6xl", className)}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="hidden min-w-0 lg:block">
          <p className="mb-2 text-xl font-semibold tracking-tight">Settings</p>
          <SettingsNav
            groups={groups}
            location={{ pathname }}
            onSelectSection={(item) => openSection(item.section)}
            linkComponent={RouterLink}
            variant="sidebar"
            className="lg:sticky lg:top-16 lg:self-start"
          />
        </div>

        <div className="min-w-0">
          <Link
            to={SETTINGS_INDEX_PATH}
            search={{} as never}
            className="mb-2 -ml-1 inline-flex min-h-11 items-center gap-1 rounded-sm px-1 text-sm font-medium text-muted-foreground hover:text-foreground lg:hidden"
          >
            <ChevronLeft className="size-4" aria-hidden />
            All settings
          </Link>

          {title ? (
            <PageHeader
              title={title}
              subtitle={description}
              primaryAction={primaryAction}
              secondaryActions={secondaryActions}
              className="mb-4"
            >
              {headerChildren}
            </PageHeader>
          ) : null}

          {children}
        </div>
      </div>
    </div>
  );
}

export default SettingsLayout;
