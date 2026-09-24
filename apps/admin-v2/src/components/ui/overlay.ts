/**
 * Floating overlays (popovers, menus, selects, tooltips) keep clear of the
 * 56px dashboard top bar plus an 8px gap, and 12px from the other edges. Radix
 * uses this both to flip sides and to compute the `--radix-*-available-height`
 * that caps each panel, so a panel never covers the top bar or runs off screen.
 */
export const OVERLAY_COLLISION_PADDING = { top: 64, right: 12, bottom: 12, left: 12 };
