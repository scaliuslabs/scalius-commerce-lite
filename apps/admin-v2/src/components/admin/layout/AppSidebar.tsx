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

  const navSections = getFilteredNavSections(permissions, isSuperAdmin);

  return (
    <Sidebar collapsible="icon">
      {/* Header — logo */}
      <SidebarHeader className="border-b border-sidebar-border flex items-center justify-center px-3 py-3">
        <Link to="/admin" className="flex items-center gap-2">
          {isCollapsed ? (
            <div className="flex items-center justify-center">
              <img
                src={faviconImg}
                alt="Scalius"
                className="w-8 h-8 object-contain"
              />
            </div>
          ) : (
            <>
              <img
                src={logoLightImg}
                alt="Scalius"
                className="h-7 w-auto max-h-7 object-contain block dark:hidden"
              />
              <img
                src={logoDarkImg}
                alt="Scalius"
                className="h-7 w-auto max-h-7 object-contain hidden dark:block"
              />
            </>
          )}
        </Link>
      </SidebarHeader>

      {/* Main navigation */}
      <SidebarContent>
        {navSections.map((section, index) => (
          <SidebarGroup key={section.label} className={index > 0 ? "pt-4" : ""}>
            <SidebarGroupLabel className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
              {section.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) =>
                  item.subItems?.length ? (
                    <CollapsibleNavItem
                      key={item.href}
                      item={item}
                      currentPath={currentPath}
                    />
                  ) : (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isRouteActive(currentPath, item.href)}
                        tooltip={item.name}
                      >
                        <Link to={item.href}>
                          <item.icon className="shrink-0" strokeWidth={2} />
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
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="View Store">
              <a
                href={storefrontUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Store className="shrink-0" strokeWidth={2} />
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
}: {
  item: NavItem;
  currentPath: string;
}) {
  const isParentActive =
    isRouteActive(currentPath, item.href) ||
    (item.subItems?.some((sub) => currentPath === sub.href) ?? false);

  return (
    <Collapsible
      asChild
      defaultOpen={isParentActive}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.name} isActive={isParentActive}>
            <item.icon className="shrink-0" strokeWidth={2} />
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
                  isActive={currentPath === subItem.href}
                >
                  <Link to={subItem.href}>
                    {subItem.icon && (
                      <subItem.icon className="shrink-0" strokeWidth={2} />
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
