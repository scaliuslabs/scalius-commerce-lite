/**
 * Icon buttons on the near-black navigation (rail items, collapse, Back):
 * 44px on phones, 28px from md, 16px icons, instant hover fill, the current
 * page (or an open menu) on the pill.
 */
export const NAV_ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground md:size-8 [&>svg]:size-4";

/** Navigation rows (Shopify's density): 44px on phones, 28px from md, 13px labels, 16px icons, 8px radius. */
export const NAV_ROW =
  "flex h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-nav text-sidebar-foreground outline-none hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold aria-[current=page]:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent md:h-7 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground aria-[current=page]:[&>svg]:text-sidebar-accent-foreground";

/** Icon and store buttons on the near-black top bar: 44px on phones, 32px from md. */
export const TOP_BAR_BUTTON =
  "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-topbar-foreground outline-none hover:bg-topbar-hover focus-visible:ring-2 focus-visible:ring-topbar-progress data-[state=open]:bg-topbar-hover md:h-8 md:min-w-8 [&>svg]:size-5 md:[&>svg]:size-4";
