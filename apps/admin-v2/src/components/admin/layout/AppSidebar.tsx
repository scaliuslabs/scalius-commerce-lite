import { useRef, useCallback } from "react";
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
import { getFilteredNavSections, type NavItem } from "./AdminNav";
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
  const { state, setOpen } = useSidebar();
  const isCollapsed = state === "collapsed";
  const normalizedPath = currentPath.replace(/\/$/, ""); // strip trailing slash
  const isParentActive =
    isRouteActive(normalizedPath, item.href) ||
    (item.subItems?.some((sub) => isRouteActive(normalizedPath, sub.href)) ?? false);

  // When collapsed, clicking the icon should expand sidebar and open the submenu
  const handleClick = useCallback(() => {
    if (isCollapsed) {
      setOpen(true);
    }
  }, [isCollapsed, setOpen]);

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
          <SidebarMenuButton tooltip={item.name} isActive={isParentActive} onClick={handleClick}>
            <item.icon className="shrink-0" strokeWidth={1.8} />
            <span>{item.name}</span>
            <ChevronDown className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-180" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.subItems?.map((subItem) => (
              <SidebarMenuSubItem key={subItem.href}>
                <SidebarMenuSubButton
                  asChild
                  isActive={normalizedPath === subItem.href.replace(/\/$/, "")}
                >
                  <Link to={subItem.href}>
                    {subItem.icon && (
                      <subItem.icon className="shrink-0" strokeWidth={1.8} />
                    )}
                    <span>{subItem.name}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
