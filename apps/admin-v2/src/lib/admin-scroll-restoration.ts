interface AdminScrollLocation {
  pathname: string;
  searchStr: string;
  state: {
    __TSR_key?: string;
    key?: string;
  };
}

/**
 * Settings tabs are addressable workspace states, so returning to a tab should
 * also return to the merchant's previous position in that tab. Other routes
 * retain TanStack Router's browser-history entry behavior.
 */
export function getAdminScrollRestorationKey(
  location: AdminScrollLocation,
): string {
  if (location.pathname.startsWith("/admin/settings")) {
    return `settings:${location.pathname}${location.searchStr}`;
  }

  return (
    location.state.__TSR_key ??
    location.state.key ??
    `${location.pathname}${location.searchStr}`
  );
}
