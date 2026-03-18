export {};

declare global {
  interface Window {
    __USER_ID__?: string;
    __USER_PERMISSIONS__?: string[];
    __IS_SUPER_ADMIN__?: boolean;
    __CURRENCY_SYMBOL__?: string;
    __CURRENCY_CODE__?: string;
    __API_BASE_URL__?: string;
    __adminSidebarPageLoadBound__?: boolean;
  }
}
