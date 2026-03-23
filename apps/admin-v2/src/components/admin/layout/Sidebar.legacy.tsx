import { useState, useEffect, useCallback, useRef } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Store, ExternalLink, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/contexts/PermissionContext";
import {
  getFilteredNavSections,
  type NavItem,
  type NavSubItem,
} from "./AdminNav";
import faviconImg from "@/assets/favicon.png";
import logoDarkImg from "@/assets/logo-dark.png";
import logoLightImg from "@/assets/logo-light.png";

// ---------------------------------------------------------------------------
// Constants — match existing admin exactly
// ---------------------------------------------------------------------------

const SIDEBAR_WIDTH = 240;
const SIDEBAR_COLLAPSED_WIDTH = 60;
const MOBILE_WIDTH = "w-72"; // 288px — matches original
const STORAGE_KEY_COLLAPSED = "sidebar-collapsed";
const STORAGE_KEY_SUBMENUS = "sidebar-submenu-states";
const STORAGE_KEY_SCROLL = "sidebar-scroll-position";

// ---------------------------------------------------------------------------
// Safe localStorage helpers
// ---------------------------------------------------------------------------

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function readCollapsed(): boolean {
  return readStorage(STORAGE_KEY_COLLAPSED) === "true";
}

function readSubmenuStates(): Record<string, boolean> {
  try {
    return JSON.parse(readStorage(STORAGE_KEY_SUBMENUS) || "{}");
  } catch {
    return {};
  }
}

function writeSubmenuStates(states: Record<string, boolean>) {
  writeStorage(STORAGE_KEY_SUBMENUS, JSON.stringify(states));
}

function submenuKey(name: string) {
  return name.toLowerCase().replace(/\s+/g, "-");
}

// ---------------------------------------------------------------------------
// Path matching — matches sidebar-active.ts logic exactly
// ---------------------------------------------------------------------------

function isExactMatch(currentPath: string, href: string) {
  return currentPath === href;
}

/** Prefix match with special case: /admin is exact-only */
function isPrefixMatch(currentPath: string, href: string) {
  if (href === "/admin") return currentPath === href;
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

// ---------------------------------------------------------------------------
// Sidebar Component
// ---------------------------------------------------------------------------

export interface SidebarProps {
  storefrontUrl?: string;
}

export function Sidebar({ storefrontUrl = "/" }: SidebarProps) {
  const { permissions, isSuperAdmin } = usePermissions();
  const location = useLocation();
  const currentPath = location.pathname;

  // Initialize with SSR-safe defaults to prevent hydration mismatches
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openSubmenus, setOpenSubmenus] = useState<Record<string, boolean>>({});

  // Restore from localStorage AFTER hydration
  useEffect(() => {
    setCollapsed(readCollapsed());
    const saved = readSubmenuStates();
    const sections = getFilteredNavSections(permissions, isSuperAdmin);
    for (const section of sections) {
      for (const item of section.items) {
        if (item.subItems?.length) {
          const key = submenuKey(item.name);
          if (isPrefixMatch(currentPath, item.href)) {
            saved[key] = true;
          }
        }
      }
    }
    setOpenSubmenus(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navSections = getFilteredNavSections(permissions, isSuperAdmin);
  const desktopNavRef = useRef<HTMLElement>(null);
  const scrollTimeoutRef = useRef<number | null>(null);

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  // Persist collapse state
  useEffect(() => {
    writeStorage(STORAGE_KEY_COLLAPSED, String(collapsed));
  }, [collapsed]);

  // Persist submenu states
  useEffect(() => {
    writeSubmenuStates(openSubmenus);
  }, [openSubmenus]);

  // Scroll position persistence — debounced save on scroll
  useEffect(() => {
    const nav = desktopNavRef.current;
    if (!nav) return;

    // Restore saved scroll position on mount
    const savedScroll = readStorage(STORAGE_KEY_SCROLL);
    if (savedScroll) {
      nav.scrollTop = parseInt(savedScroll, 10) || 0;
    }

    const onScroll = () => {
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = window.setTimeout(() => {
        writeStorage(STORAGE_KEY_SCROLL, String(nav.scrollTop));
      }, 150);
    };

    nav.addEventListener("scroll", onScroll);
    return () => {
      nav.removeEventListener("scroll", onScroll);
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Save scroll + submenu state before unload
  useEffect(() => {
    const onBeforeUnload = () => {
      const nav = desktopNavRef.current;
      if (nav) {
        writeStorage(STORAGE_KEY_SCROLL, String(nav.scrollTop));
      }
      writeSubmenuStates(openSubmenus);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [openSubmenus]);

  // ---------------------------------------------------------------------------
  // Navigation effects
  // ---------------------------------------------------------------------------

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [currentPath]);

  // Auto-open submenu containing active path on navigation
  useEffect(() => {
    for (const section of navSections) {
      for (const item of section.items) {
        if (item.subItems?.length && isPrefixMatch(currentPath, item.href)) {
          const key = submenuKey(item.name);
          setOpenSubmenus((prev) => {
            if (prev[key]) return prev;
            return { ...prev, [key]: true };
          });
        }
      }
    }
  }, [currentPath, navSections]);

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  // Window events so AdminHeader can trigger toggles
  useEffect(() => {
    const onToggleMobile = () => setMobileOpen((o) => !o);
    const onToggleCollapse = () => setCollapsed((c) => !c);
    window.addEventListener("toggleMobileSidebar", onToggleMobile);
    window.addEventListener("toggleSidebarCollapse", onToggleCollapse);
    return () => {
      window.removeEventListener("toggleMobileSidebar", onToggleMobile);
      window.removeEventListener("toggleSidebarCollapse", onToggleCollapse);
    };
  }, []);

  const toggleSubmenu = useCallback(
    (item: NavItem) => {
      const key = submenuKey(item.name);
      const isSettings = item.name.toLowerCase() === "settings";

      if (collapsed) {
        // Uncollapse first, then open submenu
        setCollapsed(false);
        setOpenSubmenus((prev) => ({ ...prev, [key]: true }));
      } else {
        setOpenSubmenus((prev) => ({ ...prev, [key]: !prev[key] }));
      }

      // Auto-scroll after Settings submenu expand (wait for CSS transition)
      if (isSettings) {
        setTimeout(() => {
          const nav = desktopNavRef.current;
          if (!nav) return;
          // Find the last sub-item in settings and scroll to reveal it
          const settingsSubmenus = nav.querySelectorAll(
            '[data-submenu-key="settings"] + div a:last-child',
          );
          const lastItem = nav.querySelector(
            ".settings-submenu-container a:last-child",
          ) as HTMLElement | null;
          if (lastItem) {
            const navRect = nav.getBoundingClientRect();
            const itemRect = lastItem.getBoundingClientRect();
            if (itemRect.bottom > navRect.bottom - 16) {
              nav.scrollBy({
                top: itemRect.bottom - (navRect.bottom - 16),
                behavior: "smooth",
              });
            }
          }
        }, 360);
      }
    },
    [collapsed],
  );

  // ---------------------------------------------------------------------------
  // Desktop nav item — regular link (no subitems)
  // ---------------------------------------------------------------------------

  function NavItemLink({
    item,
    isMobile,
  }: {
    item: NavItem;
    isMobile: boolean;
  }) {
    const isActive = isPrefixMatch(currentPath, item.href);

    return (
      <Link
        to={item.href}
        data-sidebar-link="true"
        data-sidebar-item-href={item.href}
        className={cn(
          "group flex items-center gap-3 text-sm font-medium rounded-lg border border-transparent",
          "text-sidebar-foreground transition-all duration-200 relative sidebar-nav-item",
          // Desktop styles
          !isMobile && [
            "px-3 py-2.5",
            "hover:scale-[1.02] hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
            collapsed && "justify-center !px-4",
          ],
          // Mobile styles — larger touch targets
          isMobile && [
            "px-3 py-3",
            "hover:bg-accent hover:text-accent-foreground active:bg-accent",
          ],
          isActive &&
            !isMobile &&
            "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-border shadow-[0_1px_2px_0_rgba(0,0,0,0.08)]",
          isActive &&
            isMobile &&
            "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
        aria-current={isActive ? "page" : undefined}
      >
        <item.icon
          className={cn(
            "w-5 h-5 shrink-0 transition-all duration-200",
            !isMobile && [
              "text-muted-foreground sidebar-nav-icon",
              "group-hover:text-sidebar-accent-foreground",
              isActive && "text-sidebar-accent-foreground",
            ],
            isMobile && "text-muted-foreground",
          )}
          strokeWidth={2}
        />
        {(!collapsed || isMobile) && (
          <span className="flex-1">{item.name}</span>
        )}
      </Link>
    );
  }

  // ---------------------------------------------------------------------------
  // Nav item with submenu
  // ---------------------------------------------------------------------------

  function NavItemWithSub({
    item,
    isMobile,
  }: {
    item: NavItem;
    isMobile: boolean;
  }) {
    const key = submenuKey(item.name);
    const isOpen = !!openSubmenus[key];
    const isActive =
      isPrefixMatch(currentPath, item.href) ||
      (item.subItems?.some((sub) => isExactMatch(currentPath, sub.href)) ??
        false);

    return (
      <div className="nav-item-container relative">
        <button
          type="button"
          onClick={() => toggleSubmenu(item)}
          data-toggle-submenu="true"
          data-sidebar-parent="true"
          data-href={item.href}
          data-submenu-key={key}
          data-is-settings={
            item.name.toLowerCase() === "settings" ? "true" : undefined
          }
          aria-expanded={isOpen}
          className={cn(
            "group flex w-full items-center gap-3 rounded-lg border border-transparent bg-transparent",
            "text-left text-sm font-medium text-sidebar-foreground",
            "transition-all duration-200 relative sidebar-nav-item cursor-pointer",
            // Desktop
            !isMobile && [
              "px-3 py-2.5",
              "hover:scale-[1.02] hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
              collapsed && "justify-center !px-4",
              isActive &&
                "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-border shadow-[0_1px_2px_0_rgba(0,0,0,0.08)]",
            ],
            // Mobile — larger touch targets
            isMobile && [
              "px-3 py-3",
              "hover:bg-accent hover:text-accent-foreground active:bg-accent",
              isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
            ],
          )}
        >
          <item.icon
            className={cn(
              "w-5 h-5 shrink-0 transition-all duration-200",
              !isMobile && [
                "text-muted-foreground sidebar-nav-icon",
                "group-hover:text-sidebar-accent-foreground",
                isActive && "text-sidebar-accent-foreground",
              ],
              isMobile && "text-muted-foreground",
            )}
            strokeWidth={2}
          />
          {(!collapsed || isMobile) && (
            <>
              <span className="flex-1 font-medium">{item.name}</span>
              <ChevronDown
                className={cn(
                  "submenu-chevron w-4 h-4 transition-transform",
                  // Desktop: 300ms cubic-bezier chevron
                  !isMobile && [
                    "text-muted-foreground/70 duration-300",
                    isActive && "text-sidebar-accent-foreground",
                  ],
                  // Mobile: 200ms
                  isMobile && "text-muted-foreground duration-200",
                  isOpen && "rotate-180",
                )}
              />
            </>
          )}
        </button>

        {/* Submenu */}
        {(!collapsed || isMobile) && (
          <div
            className={cn(
              "overflow-hidden transition-all duration-300 ease-in-out",
              // Desktop: ml-6 mt-1 space-y-1
              !isMobile && "ml-6 mt-1 space-y-1",
              // Mobile: ml-8 mt-0.5 space-y-0.5
              isMobile && "ml-8 mt-0.5 space-y-0.5",
              // Settings submenu marker for auto-scroll
              item.name.toLowerCase() === "settings" &&
                "settings-submenu-container",
              isOpen ? "max-h-[600px] opacity-100" : "max-h-0 opacity-0",
            )}
          >
            {item.subItems?.map((sub) => (
              <SubNavItem key={sub.href} subItem={sub} isMobile={isMobile} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Sub-navigation item
  // ---------------------------------------------------------------------------

  function SubNavItem({
    subItem,
    isMobile,
  }: {
    subItem: NavSubItem;
    isMobile: boolean;
  }) {
    const isActive = isExactMatch(currentPath, subItem.href);

    return (
      <Link
        to={subItem.href}
        data-sidebar-subitem="true"
        data-sidebar-item-href={subItem.href}
        className={cn(
          "group flex items-center gap-3 text-sm rounded-lg",
          "text-muted-foreground transition-all duration-200 sidebar-subnav-item",
          // Desktop
          !isMobile && [
            "px-3 py-2",
            "hover:scale-[1.01] hover:translate-x-1 hover:bg-sidebar-accent/30 hover:text-sidebar-accent-foreground",
            isActive &&
              "bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-[0_1px_2px_0_rgba(0,0,0,0.08)]",
          ],
          // Mobile — larger touch targets
          isMobile && [
            "px-3 py-2.5",
            "hover:bg-accent hover:text-accent-foreground",
            isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
          ],
        )}
        aria-current={isActive ? "page" : undefined}
      >
        {subItem.icon && (
          <subItem.icon
            className={cn(
              "shrink-0 transition-all duration-200",
              !isMobile && [
                "w-4 h-4 text-muted-foreground sidebar-subnav-icon",
                "group-hover:text-sidebar-accent-foreground",
                isActive && "text-sidebar-accent-foreground",
              ],
              isMobile && "w-4 h-4",
            )}
            strokeWidth={2}
          />
        )}
        <span>{subItem.name}</span>
      </Link>
    );
  }

  // ---------------------------------------------------------------------------
  // Shared sidebar content (used by both desktop and mobile)
  // ---------------------------------------------------------------------------

  function SidebarContent({ isMobile = false }: { isMobile?: boolean }) {
    return (
      <>
        {/* Logo header — h-14 to match AdminHeader height */}
        <div
          className={cn(
            "flex items-center h-14 border-b border-sidebar-border bg-sidebar shrink-0",
            collapsed && !isMobile ? "px-2 justify-center" : "px-6",
            isMobile && "px-4 justify-between",
          )}
        >
          <Link to="/admin" className="flex items-center gap-3 group">
            {/* Collapsed: favicon icon only */}
            {collapsed && !isMobile && (
              <div className="w-8 h-8 bg-sidebar-accent rounded-lg flex items-center justify-center transition-transform group-hover:scale-105">
                <img
                  src={faviconImg}
                  alt="Site icon"
                  className="w-7 h-7 left-1/2 -translate-x-1/2"
                />
              </div>
            )}
            {/* Expanded: full logo, theme-aware */}
            {(!collapsed || isMobile) && (
              <div>
                <img
                  src={logoLightImg}
                  alt="Scalius"
                  className={cn(
                    "w-auto block dark:hidden",
                    isMobile ? "h-7" : "h-8",
                  )}
                />
                <img
                  src={logoDarkImg}
                  alt="Scalius"
                  className={cn(
                    "w-auto hidden dark:block",
                    isMobile ? "h-7" : "h-8",
                  )}
                />
              </div>
            )}
          </Link>
          {isMobile && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(false)}
              aria-label="Close sidebar"
              className="h-9 w-9 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg"
            >
              <X className="w-5 h-5" />
            </Button>
          )}
        </div>

        {/* Navigation */}
        <nav
          ref={!isMobile ? desktopNavRef : undefined}
          id={!isMobile ? "sidebar-nav" : undefined}
          className={cn(
            "flex-1 overflow-y-auto sidebar-nav",
            !isMobile && "px-3 py-4 scrollbar-thin scrollbar-thumb-muted-foreground",
            isMobile && "px-3 py-3",
          )}
        >
          <div
            className={cn(
              "pb-4",
              !isMobile ? "space-y-6" : "space-y-5",
            )}
          >
            {navSections.map((section) => (
              <div key={section.label} className={!isMobile ? "sidebar-section" : undefined}>
                {!collapsed && (
                  <div className={cn(!isMobile ? "px-3 mb-3" : "px-2 mb-2")}>
                    <span
                      className={cn(
                        "font-semibold text-muted-foreground uppercase",
                        !isMobile
                          ? "text-xs tracking-wider sidebar-section-label"
                          : "text-[11px] tracking-widest",
                      )}
                    >
                      {section.label}
                    </span>
                  </div>
                )}
                <div className={!isMobile ? "space-y-1" : "space-y-0.5"}>
                  {section.items.map((item) =>
                    item.subItems?.length ? (
                      <NavItemWithSub
                        key={item.href}
                        item={item}
                        isMobile={isMobile}
                      />
                    ) : (
                      <NavItemLink
                        key={item.href}
                        item={item}
                        isMobile={isMobile}
                      />
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* Store link footer */}
        <div className="px-3 border-t border-sidebar-border bg-sidebar mt-auto shrink-0"
          style={{ paddingTop: isMobile ? "0.75rem" : "1rem", paddingBottom: isMobile ? "0.75rem" : "1rem" }}
        >
          {!isMobile ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className={cn(
                "w-full justify-between text-sidebar-foreground hover:bg-sidebar-accent h-9 px-3 rounded-lg transition-all duration-200 group hover:scale-[1.02]",
                collapsed && "justify-center",
              )}
            >
              <a
                href={storefrontUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(collapsed && "justify-center")}
              >
                <div className="flex items-center gap-3">
                  <Store className="w-4 h-4 text-muted-foreground group-hover:text-sidebar-accent-foreground transition-all duration-200 shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="text-sm">View Store</span>
                      <ExternalLink className="w-3.5 h-3.5 text-muted-foreground group-hover:text-sidebar-accent-foreground transition-all duration-200" />
                    </>
                  )}
                </div>
              </a>
            </Button>
          ) : (
            <a
              href={storefrontUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-3 text-sm font-medium text-muted-foreground rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors duration-150"
            >
              <Store className="w-5 h-5 shrink-0" />
              <span className="flex-1">View Store</span>
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Desktop sidebar — sticky, transition matches sidebar.css exactly */}
      <aside
        className="hidden md:flex md:flex-col bg-sidebar border-r border-sidebar-border sticky top-0 h-screen z-20 sidebar-desktop"
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH,
          minWidth: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH,
          transition: "width 0.35s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease",
          willChange: "width",
        }}
      >
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      <div
        className={cn(
          "fixed inset-0 bg-black/60 z-40 md:hidden transition-opacity duration-300",
          mobileOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none",
        )}
        onClick={() => setMobileOpen(false)}
      />

      {/* Mobile sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 md:hidden flex flex-col shadow-xl",
          "border-r border-sidebar-border",
          "transition-transform duration-300 ease-in-out",
          MOBILE_WIDTH,
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
        style={{
          backgroundColor: "var(--sidebar)",
          color: "var(--sidebar-foreground)",
          borderColor: "var(--sidebar-border)",
        }}
      >
        <SidebarContent isMobile />
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dispatch helpers for external use (AdminHeader)
// ---------------------------------------------------------------------------

export function dispatchToggleMobile() {
  window.dispatchEvent(new CustomEvent("toggleMobileSidebar"));
}

export function dispatchToggleCollapse() {
  window.dispatchEvent(new CustomEvent("toggleSidebarCollapse"));
}
