/**
 * Page URLs under the buyer's presence in the browser (docs/MARKETS-DESIGN.md
 * D4). The gateway localizes every link of a rendered page, React islands'
 * server markup included; code that builds a URL or navigates in the browser
 * uses this one rule so the buyer stays inside `/en-in`.
 *
 * The presence is `<html data-market-presence>`, which Layout.astro writes on
 * presence pages only. Root pages have none, and on the server (where the
 * gateway rewrites the HTML) there is no document, so every helper returns
 * its input unchanged and today's links stay as they are. Server code that
 * builds absolute URLs uses `serverPagePath` (lib/server-presence.ts).
 */
import { presencePath, stripPresencePath } from "@scalius/shared/markets";

/** The subfolder presence of this page, or null at the root (and on the server). */
export function currentPresence(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.dataset.marketPresence || null;
}

/** A root-relative page href under the current presence (`/cart` → `/en-in/cart`). */
export function pagePath(href: string): string {
  return presencePath(currentPresence(), href);
}

/** The page path of a location without its presence, for code that reads which page it is on. */
export function logicalPathname(pathname: string): string {
  return stripPresencePath(pathname, currentPresence());
}
