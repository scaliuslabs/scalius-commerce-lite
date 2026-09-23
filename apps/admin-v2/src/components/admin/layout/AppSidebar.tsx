import { Link, useLocation } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { SETTINGS_ITEM, isSectionActive, matchesPath, type VisibleNavItem } from "./AdminNav";

const ICON = "size-4 shrink-0";

/**
 * The store sidebar under the top bar. A section's sub-pages show only while
 * the section is active; Settings is pinned at the bottom.
 */
export function AppSidebar({ nav, showSettings }: { nav: VisibleNavItem[]; showSettings: boolean }) {
  const t = useMessages(shellMessages);
  const path = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { storefrontUrl } = useStorefrontUrl();
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar aria-label={t("mainNavigation")}>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {nav.map((item) => {
              const open = isSectionActive(path, item);
              const activeChild = item.children.find((child) => matchesPath(path, child.to));
              return (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton asChild isActive={open && !activeChild}>
                    <Link to={item.to} preload="intent" onClick={close}>
                      <item.icon className={ICON} aria-hidden />
                      <span className={open ? "font-semibold" : undefined}>{t(item.key)}</span>
                    </Link>
                  </SidebarMenuButton>
                  {open && item.children.length > 0 ? (
                    <SidebarMenuSub>
                      {item.children.map((child) => (
                        <SidebarMenuSubItem key={child.key}>
                          <SidebarMenuSubButton asChild isActive={child === activeChild}>
                            <Link to={child.to} preload="intent" onClick={close}>
                              {t(child.key)}
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {storefrontUrl ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <a href={storefrontUrl} target="_blank" rel="noopener noreferrer" onClick={close}>
                  <ExternalLink className={ICON} aria-hidden />
                  <span>{t("viewStore")}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {showSettings ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link to={SETTINGS_ITEM.to} onClick={close}>
                  <SETTINGS_ITEM.icon className={ICON} aria-hidden />
                  <span>{t("settings")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
