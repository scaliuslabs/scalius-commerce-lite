import { lazy, Suspense, useEffect, useRef, useCallback, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Globe } from "lucide-react";
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

const StorefrontFooterLink = lazy(() =>
  import("./StorefrontFooterLink").then((module) => ({
    default: module.StorefrontFooterLink,
  })),
);

type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function isRouteActive(currentPath: string, href: string): boolean {
  if (href === "/admin") return currentPath === href;
  return currentPath === href || currentPath.startsWith(href + "/");
}

function useDeferredSidebarFooter() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };

    const idleWindow = window as IdleSchedulerWindow;
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(markReady, {
        timeout: 2_000,
      });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const timeout = window.setTimeout(markReady, 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  return ready;
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

export function AppSidebar() {
  const { permissions, isSuperAdmin } = usePermissions();
  const location = useLocation();
  const currentPath = location.pathname;
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed";
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const footerReady = useDeferredSidebarFooter();

  const navSections = getFilteredNavSections(permissions, isSuperAdmin);

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

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
        <Link to="/admin" className="flex items-center min-w-0" onClick={closeMobileSidebar}>
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
                      onNavigate={closeMobileSidebar}
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
                        <Link to={item.href} onClick={closeMobileSidebar}>
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

      {/* Footer — storefront link */}
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            {footerReady ? (
              <Suspense fallback={<StorefrontFooterLinkFallback />}>
                <StorefrontFooterLink onNavigate={closeMobileSidebar} />
              </Suspense>
            ) : (
              <StorefrontFooterLinkFallback />
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function StorefrontFooterLinkFallback() {
  return (
    <SidebarMenuButton
      disabled
      tooltip="Visit Storefront"
      className="opacity-70"
    >
      <Globe className="shrink-0" strokeWidth={1.8} />
      <span className="flex-1 truncate">Visit Storefront</span>
    </SidebarMenuButton>
  );
}

function CollapsibleNavItem({
  item,
  currentPath,
  onNavigate,
  onOpenChange,
}: {
  item: NavItem;
  currentPath: string;
  onNavigate?: () => void;
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
                    <Link to={subItem.href} onClick={onNavigate}>
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
