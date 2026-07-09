export const ADMIN_NAVIGATION_CANCELLED_EVENT =
  "scalius:admin-navigation-cancelled";

export function dispatchAdminNavigationCancelled(): void {
  window.dispatchEvent(new Event(ADMIN_NAVIGATION_CANCELLED_EVENT));
}
