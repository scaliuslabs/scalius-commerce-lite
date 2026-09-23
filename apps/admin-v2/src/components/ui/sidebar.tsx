import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight } from "lucide-react";

import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@scalius/shared/utils";

const SIDEBAR_KEYBOARD_SHORTCUT = "b";

const SidebarMobileSheet = React.lazy(() =>
  import("./sidebar-mobile-sheet").then((module) => ({ default: module.SidebarMobileSheet })),
);

type SidebarContext = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContext | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

const SidebarProvider = React.forwardRef<HTMLDivElement, React.ComponentProps<"div"> & { defaultOpen?: boolean }>(
  ({ defaultOpen = true, className, children, ...props }, ref) => {
    const isMobile = useIsMobile();
    const [openMobile, setOpenMobile] = React.useState(false);
    const [open, setOpen] = React.useState(defaultOpen);

    const toggleSidebar = React.useCallback(() => {
      if (isMobile) setOpenMobile((value) => !value);
      else setOpen((value) => !value);
    }, [isMobile]);

    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          toggleSidebar();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [toggleSidebar]);

    const contextValue = React.useMemo<SidebarContext>(
      () => ({ state: open ? "expanded" : "collapsed", open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
      [open, isMobile, openMobile, toggleSidebar],
    );

    return (
      <SidebarContext.Provider value={contextValue}>
        <div ref={ref} className={cn("flex min-h-svh w-full", className)} {...props}>
          {children}
        </div>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

/**
 * Shopify's left navigation: a 240px column in the page flow on desktop, below
 * the top bar, its top corner rounded into the near-black frame; a sheet on phones.
 */
const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<"div"> & { side?: "left" | "right" }>(
  ({ side = "left", className, children, ...props }, ref) => {
    const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
    const [hasLoadedMobileSheet, setHasLoadedMobileSheet] = React.useState(false);

    React.useEffect(() => {
      if (openMobile) setHasLoadedMobileSheet(true);
    }, [openMobile]);

    if (isMobile) {
      if (!openMobile && !hasLoadedMobileSheet) return null;

      return (
        <React.Suspense fallback={null}>
          <SidebarMobileSheet open={openMobile} onOpenChange={setOpenMobile} side={side}>
            {children}
          </SidebarMobileSheet>
        </React.Suspense>
      );
    }

    return (
      <div
        ref={ref}
        data-sidebar="sidebar"
        data-state={open ? "expanded" : "collapsed"}
        className={cn(
          "hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex data-[state=collapsed]:md:hidden",
          side === "left" ? "rounded-tl-xl" : "order-last rounded-tr-xl",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
Sidebar.displayName = "Sidebar";

const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => (
  <div ref={ref} data-sidebar="footer" className={cn("flex flex-col px-2.5 py-3", className)} {...props} />
));
SidebarFooter.displayName = "SidebarFooter";

const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="content"
    className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto", className)}
    {...props}
  />
));
SidebarContent.displayName = "SidebarContent";

const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => (
  <div ref={ref} data-sidebar="group" className={cn("relative flex w-full min-w-0 flex-col px-2.5 py-2", className)} {...props} />
));
SidebarGroup.displayName = "SidebarGroup";

/**
 * Shopify's small group label ("Sales channels ›"): 24px, sentence case, a
 * chevron that turns when the group is open; it toggles the group's items.
 */
const SidebarGroupLabel = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<"button">, "onToggle"> & { open: boolean; onOpenChange: (open: boolean) => void }
>(({ open, onOpenChange, className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    data-sidebar="group-label"
    aria-expanded={open}
    onClick={() => onOpenChange(!open)}
    className={cn(
      "flex h-6 w-full items-center gap-1 rounded-lg px-2 text-left text-body text-muted-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-3.5 [&>svg]:shrink-0 aria-expanded:[&>svg]:rotate-90",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight aria-hidden />
  </button>
));
SidebarGroupLabel.displayName = "SidebarGroupLabel";

const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<"ul">>(({ className, ...props }, ref) => (
  <ul ref={ref} data-sidebar="menu" className={cn("flex w-full min-w-0 flex-col gap-0.5", className)} {...props} />
));
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.ComponentProps<"li">>(({ className, ...props }, ref) => (
  <li ref={ref} data-sidebar="menu-item" className={cn("relative", className)} {...props} />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

/**
 * Shopify nav row: 28px (44px on phones), 8px radius, instant hover fill, the
 * current page on a near-white pill with no weight change, 2px focus ring.
 * Icons are "filled" at rest and switch to the outline glyph on the current or
 * open section (global.css, keyed on data-active / data-open).
 */
const menuButtonClassName =
  "flex h-11 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg pl-2 pr-1 text-left text-body text-sidebar-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground md:h-7 [&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0";

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    isActive?: boolean;
    /** The section is open (it or one of its sub-items is the current page). */
    isOpen?: boolean;
  }
>(({ asChild = false, isActive = false, isOpen = false, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      data-sidebar="menu-button"
      data-active={isActive}
      data-open={isOpen || isActive}
      className={cn(menuButtonClassName, className)}
      {...props}
    />
  );
});
SidebarMenuButton.displayName = "SidebarMenuButton";

/** Sub-items: indented 36px, subdued; the tree connector to the active child comes from global.css. */
const SidebarMenuSub = React.forwardRef<HTMLUListElement, React.ComponentProps<"ul">>(({ className, ...props }, ref) => (
  <ul ref={ref} data-sidebar="menu-sub" className={cn("flex min-w-0 flex-col motion-safe:animate-nav-grow", className)} {...props} />
));
SidebarMenuSub.displayName = "SidebarMenuSub";

const SidebarMenuSubItem = React.forwardRef<HTMLLIElement, React.ComponentProps<"li">>((props, ref) => <li ref={ref} {...props} />);
SidebarMenuSubItem.displayName = "SidebarMenuSubItem";

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<"a"> & { asChild?: boolean; isActive?: boolean }
>(({ asChild = false, isActive, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      ref={ref}
      data-sidebar="menu-sub-button"
      data-active={isActive}
      className={cn(menuButtonClassName, "pl-9 text-muted-foreground", className)}
      {...props}
    />
  );
});
SidebarMenuSubButton.displayName = "SidebarMenuSubButton";

export {
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
  SidebarProvider,
  useSidebar,
};
