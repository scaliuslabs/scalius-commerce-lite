// Nothing frames a buyer's own page (a clickjacking or overlay defence). The
// pages the store itself frames are left alone: the cart and checkout shells
// (the theme editor previews the cart), the editor's canvas, and the browser
// continuation relays. One decision feeds both the page policy's
// `frame-ancestors` and the older `X-Frame-Options`, read from the same path.
import { storefrontAppPage } from "@/lib/app-scripts";
import { isUncachedPrivateStorefrontPathname } from "@/lib/cache-policy";
import {
  isBrowserContinuationRelayPathname,
  isFramedBrowserContinuationRelayPathname,
} from "@/lib/browser-continuation-relay";

export function buyerPageForbidsFraming(pathname: string): boolean {
  return (
    isUncachedPrivateStorefrontPathname(pathname) &&
    // The editor's canvas (`/theme-preview/*`) is private for caching only.
    storefrontAppPage(pathname) === "private" &&
    !isBrowserContinuationRelayPathname(pathname) &&
    !isFramedBrowserContinuationRelayPathname(pathname)
  );
}
