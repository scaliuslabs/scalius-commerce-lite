import { useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
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

/**
 * The store sidebar (Shopify's): sections with their sub-pages shown only
 * while the section is open, "Sales channels" as a collapsible group, and
 * Settings pinned at the bottom. Geometry, states and the tree connector come
 * from the Sidebar primitive.
 */
export function AppSidebar({ nav, showSettings }: { nav: VisibleNavItem[]; showSettings: boolean }) {
  const t = useMessages(shellMessages);
  const path = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { storefrontUrl } = useStorefrontUrl();
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  const ungrouped = nav.filter((item) => !item.group);
  const groups = [...new Set(nav.flatMap((item) => (item.group ? [item.group] : [])))];

  const renderItem = (item: VisibleNavItem) => {
    const open = isSectionActive(path, item);
    const activeChild = item.children.find((child) => matchesPath(path, child.to));
    return (
      <SidebarMenuItem key={item.key}>
        <SidebarMenuButton asChild isOpen={open} isActive={open && !activeChild}>
          <Link to={item.to} preload="intent" activeOptions={{ exact: true }} onClick={close}>
            <item.icon aria-hidden />
            <span>{t(item.key)}</span>
          </Link>
        </SidebarMenuButton>
        {open && item.children.length > 0 ? (
          <SidebarMenuSub>
            {item.children.map((child) => (
              <SidebarMenuSubItem key={child.key}>
                <SidebarMenuSubButton asChild isActive={child === activeChild}>
                  <Link to={child.to} preload="intent" activeOptions={{ exact: true }} onClick={close}>
                    <span>{t(child.key)}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar aria-label={t("mainNavigation")} closeLabel={t("closeMenu")}>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>{ungrouped.map(renderItem)}</SidebarMenu>
        </SidebarGroup>
        {groups.map((group) => {
          const items = nav.filter((item) => item.group === group);
          // A group holding the current page never hides it.
          const open = !closedGroups.has(group) || items.some((item) => isSectionActive(path, item));
          return (
            <SidebarGroup key={group}>
              <SidebarGroupLabel
                open={open}
                onOpenChange={(next) =>
                  setClosedGroups((current) => {
                    const updated = new Set(current);
                    if (next) updated.delete(group);
                    else updated.add(group);
                    return updated;
                  })
                }
              >
                {t(group)}
              </SidebarGroupLabel>
              {open ? <SidebarMenu className="mt-0.5">{items.map(renderItem)}</SidebarMenu> : null}
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {storefrontUrl ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <a href={storefrontUrl} target="_blank" rel="noopener noreferrer" onClick={close}>
                  <ExternalLink aria-hidden />
                  <span>{t("viewStore")}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {showSettings ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link to={SETTINGS_ITEM.to} onClick={close}>
                  <SETTINGS_ITEM.icon aria-hidden />
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
