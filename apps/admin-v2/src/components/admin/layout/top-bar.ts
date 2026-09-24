import { useMediaQuery } from "~/hooks/use-media-query";

/** Icon and avatar buttons on the near-black top bar: instant hover fill, 44px on phones. */
export const TOP_BAR_BUTTON =
  "flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-1.5 text-topbar-foreground outline-none hover:bg-topbar-hover focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-w-9";

/**
 * `sideOffset` for menus opened from the top bar, so every one starts 8px
 * below the 56px bar: its buttons are 44px tall on phones and 36px from `md`,
 * centred, so they end 6px or 10px above the bar's edge.
 */
export function useTopBarMenuOffset(): number {
  return useMediaQuery("(min-width: 768px)") ? 18 : 14;
}
