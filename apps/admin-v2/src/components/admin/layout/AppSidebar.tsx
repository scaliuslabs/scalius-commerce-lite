import { useRef, useCallback } from "react";
// useCallback kept for handleCollapsibleOpen
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Store, ExternalLink } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { usePermissions } from "@/contexts/PermissionContext";
import { getFilteredNavSections, type NavItem, type NavSubItem } from "./AdminNav";
import faviconImg from "@/assets/favicon.png";
import logoDarkImg from "@/assets/logo-dark.png";
import logoLightImg from "@/assets/logo-light.png";

interface AppSidebarProps {
  storefrontUrl?: string;
}

function isRouteActive(currentPath: string, href: string): boolean {
  if (href === "/admin") return currentPath === href;
  return currentPath === href || currentPath.startsWith(href + "/");
}

/**
 * Determine which sub-item is active.
 * Uses startsWith matching so nested pages (e.g. /admin/products/abc/edit)
 * keep the parent sub-item (Products) highlighted.
 *
 * When multiple sub-items match via startsWith (e.g. /admin/settings and
 * /admin/settings/theme both match /admin/settings/theme), the longest
 * (most specific) href wins.
 */
function getActiveSubItemHref(
  currentPath: string,
  subItems: NavSubItem[],
): string | null {
  let bestMatch: string | null = null;
  for (const sub of subItems) {
    const href = sub.href.replace(/\/$/, "");
    if (currentPath === href || currentPath.startsWith(href + "/")) {
      if (!bestMatch || href.length > bestMatch.length) {
        bestMatch = href;
      }
    }
  }
  return bestMatch;
}

export function AppSidebar({ storefrontUrl = "/" }: AppSidebarProps) {
  const { permissions, isSuperAdmin } = usePermissions();
  const location = useLocation();
  const currentPath = location.pathname;
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const sidebarContentRef = useRef<HTMLDivElement>(null);

  const navSections = getFilteredNavSections(permissions, isSuperAdmin);

  // Auto-scroll sidebar when a collapsible section is opened
  const handleCollapsibleOpen = useCallback((open: boolean, itemName: string) => {
    if (open && sidebarContentRef.current) {
      // Small delay to let the collapsible animation start
      setTimeout(() => {
        const el = sidebarContentRef.current?.querySelector(
          `[data-nav-item="${itemName}"]`
        );
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 100);
    }
  }, []);

  return (
    <Sidebar collapsible="icon">
      {/* Header — logo, aligned with header bar */}
      <SidebarHeader className="h-14 flex items-center border-b border-sidebar-border px-3 shrink-0">
        <Link to="/admin" className="flex items-center min-w-0">
          {isCollapsed ? (
            <img
              src={faviconImg}
              alt="Scalius"
              className="w-7 h-7 shrink-0 object-contain"
            />
          ) : (
            <>
              <img
                src={logoLightImg}
                alt="Scalius"
                className="h-7 w-auto object-contain block dark:hidden"
              />
              <img
                src={logoDarkImg}
                alt="Scalius"
                className="h-7 w-auto object-contain hidden dark:block"
              />
            </>
          )}
        </Link>
      </SidebarHeader>

      {/* Main navigation — scrollable */}
      <SidebarContent ref={sidebarContentRef}>
        {navSections.map((section, index) => (
          <SidebarGroup key={section.label} className={index > 0 ? "pt-2" : ""}>
            {section.label && (
              <SidebarGroupLabel className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {section.label}
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) =>
                  item.subItems?.length ? (
                    <CollapsibleNavItem
                      key={item.href}
                      item={item}
                      currentPath={currentPath}
                      onOpenChange={(open) => handleCollapsibleOpen(open, item.name)}
                    />
                  ) : (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isRouteActive(currentPath, item.href)}
                        tooltip={item.name}
                        className={isRouteActive(currentPath, item.href) ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] shadow-sm" : ""}
                      >
                        <Link to={item.href}>
                          <item.icon className="shrink-0" strokeWidth={1.8} />
                          <span>{item.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ),
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* Footer — store link only */}
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="View Store">
              <a
                href={storefrontUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Store className="shrink-0" strokeWidth={1.8} />
                <span className="flex-1">View Store</span>
                <ExternalLink className="!size-3.5 text-sidebar-foreground/50" />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function CollapsibleNavItem({
  item,
  currentPath,
  onOpenChange,
}: {
  item: NavItem;
  currentPath: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const normalizedPath = currentPath.replace(/\/$/, ""); // strip trailing slash
  const isParentActive =
    isRouteActive(normalizedPath, item.href) ||
    (item.subItems?.some((sub) => isRouteActive(normalizedPath, sub.href)) ?? false);

  // Determine which sub-item is active (longest/most-specific match wins)
  const activeSubHref = item.subItems
    ? getActiveSubItemHref(normalizedPath, item.subItems)
    : null;

  return (
    <Collapsible
      asChild
      defaultOpen={isParentActive || item.defaultOpen === true}
      className="group/collapsible"
      onOpenChange={(open) => {
        onOpenChange?.(open);
      }}
    >
      <SidebarMenuItem data-nav-item={item.name}>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.name} isActive={isParentActive} className={isParentActive ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] shadow-sm" : ""}>
            <item.icon className="shrink-0" strokeWidth={1.8} />
            <span>{item.name}</span>
            <ChevronDown className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-180" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.subItems?.map((subItem) => {
              const subHref = subItem.href.replace(/\/$/, "");
              const isSubActive = activeSubHref === subHref;
              return (
                <SidebarMenuSubItem key={subItem.href}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={isSubActive}
                    tooltip={subItem.name}
                    className={isSubActive ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] shadow-sm" : ""}
                  >
                    <Link to={subItem.href}>
                      {subItem.icon && (
                        <subItem.icon className="shrink-0" strokeWidth={1.8} />
                      )}
                      <span>{subItem.name}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
