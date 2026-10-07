// The app page's tabs (Shopify's app details): Overview is the page itself;
// Settings and Permissions have their own address (`?tab=`; the route checks
// it inline).
export const APP_PAGE_TABS = ["overview", "settings", "permissions"] as const;
export type AppPageTab = (typeof APP_PAGE_TABS)[number];

