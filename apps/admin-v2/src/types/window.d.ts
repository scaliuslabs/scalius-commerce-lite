export {};

declare global {
  interface Window {
    __USER_ID__?: string;
__CURRENCY_SYMBOL__?: string;
    __CURRENCY_CODE__?: string;
    __API_BASE_URL__?: string;
    __adminSidebarPageLoadBound__?: boolean;
    __adminNavProgressBound__?: boolean;
    __adminPendingDestination__?: string | null;
    __adminSidebarState?: import("@/components/admin/admin-layout/sidebar/sidebar-state").SidebarState;
  }
}
