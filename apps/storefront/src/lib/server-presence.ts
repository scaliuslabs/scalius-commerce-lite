/**
 * Page URLs under the request's presence on the server (docs/MARKETS-DESIGN.md
 * D4): absolute SEO URLs, sitemaps, feeds and inline scripts the HTML
 * rewriter cannot reach. The presence comes from the header only the gateway
 * sets; a root request has none and every path is returned unchanged.
 */
import { presencePath } from "@scalius/shared/markets";
import { getRuntimePresence } from "@/lib/api/runtime";

export function serverPagePath(href: string): string {
  return presencePath(getRuntimePresence(), href);
}
