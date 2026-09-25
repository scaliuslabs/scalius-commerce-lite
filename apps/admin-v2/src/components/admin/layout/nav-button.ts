/**
 * Icon buttons on the near-black navigation (rail items, bell, collapse):
 * 44px on phones, 32px from md, instant hover fill, the current page (or an
 * open menu) on the pill.
 */
export const NAV_ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground md:size-8";

/** Navigation rows: 44px on phones, 32px from md, 20px icons, 8px radius. */
export const NAV_ROW =
  "flex h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-body text-sidebar-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold aria-[current=page]:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent md:h-8 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground aria-[current=page]:[&>svg]:text-sidebar-accent-foreground";
