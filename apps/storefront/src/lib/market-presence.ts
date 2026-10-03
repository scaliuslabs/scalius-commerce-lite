/**
 * Subfolder presences at the storefront edge (docs/MARKETS-DESIGN.md D4,
 * "Step 2 implemented"). One route tree serves every presence:
 *
 * - The gateway strips the presence (`/en-in/products/x` renders
 *   `/products/x`) and tells the render which presence it is in through a
 *   header only the gateway sets (`PRESENCE_HEADER`); the page cache key
 *   keeps the presence, so each presence has its own entries.
 * - The rendered response is localized once, before it is stored: every
 *   same-origin page link and form action (merchant menus, rich text, theme
 *   sections and app output included) and every redirect `Location` stay
 *   inside the presence. Root responses are never touched, so a store with
 *   one presence serves exactly today's bytes. Links that name another
 *   presence on purpose (`hreflang`) are left alone.
 * - Client code that builds URLs uses the same rule (`pagePath`,
 *   lib/presence-url.ts).
 * - A buyer's explicit choice (the `localization` cookie) may redirect a
 *   top-level navigation to the same page under the chosen presence. The
 *   presence matrix is read only when the URL's presence differs from the
 *   cookie's, so the steady state costs nothing.
 */
import {
  MARKET_SELECTION_COOKIE,
  isCrawlerUserAgent,
  isMarketSubfolder,
  isPresenceServedPath,
  isTopLevelNavigation,
  presenceHref,
  presenceOfPath,
  readMarketSelectionCookie,
  resolveMarket,
  stripPresencePath,
  type MarketMatrix,
} from "@scalius/shared/markets";

/** The presence of a render request. Only the gateway sets it; an inbound copy is dropped. */
export const PRESENCE_HEADER = "X-Scalius-Presence";

/** The subfolder presence a render request is in, or null for the root. */
export function presenceOfRenderRequest(request: Request): string | null {
  const value = request.headers.get(PRESENCE_HEADER);
  return isMarketSubfolder(value) ? value : null;
}

/** The request without any presence header a client sent. */
export function withoutInboundPresence(request: Request): Request {
  if (!request.headers.has(PRESENCE_HEADER)) return request;
  const next = new Request(request);
  next.headers.delete(PRESENCE_HEADER);
  return next;
}

/** The URL with its presence removed (`/en-in/x?y` → `/x?y`). */
export function logicalUrl(url: URL): URL {
  const presence = presenceOfPath(url.pathname);
  if (!presence) return url;
  const next = new URL(url);
  next.pathname = stripPresencePath(url.pathname, presence);
  return next;
}

/** The path a presence URL keeps for its cache key and links: the raw prefix, for pages and discovery files alike. */
export function withPresencePrefix(presence: string | null, path: string): string {
  if (!presence) return path;
  return `/${presence}${path === "/" ? "" : path.startsWith("/?") ? path.slice(1) : path}`;
}

/**
 * What a presence URL renders: null for a root URL, `not_found` for a path a
 * presence does not serve (assets, APIs, robots, UCP), else the request Astro
 * renders, with the presence header.
 */
export function presenceRenderTarget(request: Request): { presence: string; render: Request } | "not_found" | null {
  const url = new URL(request.url);
  const presence = presenceOfPath(url.pathname);
  if (!presence) return null;
  const pathname = stripPresencePath(url.pathname, presence);
  if (!isPresenceServedPath(pathname)) return "not_found";
  url.pathname = pathname;
  const render = new Request(url.toString(), request);
  render.headers.set(PRESENCE_HEADER, presence);
  return { presence, render };
}

/** The minimum of the Workers HTMLRewriter this module uses. */
export interface PresenceElement {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
}
export interface PresenceRewriter {
  on(selector: string, handlers: { element(element: PresenceElement): void }): PresenceRewriter;
  transform(response: Response): Response;
}

function workersRewriter(): PresenceRewriter {
  const Rewriter = (globalThis as { HTMLRewriter?: new () => PresenceRewriter }).HTMLRewriter;
  if (!Rewriter) throw new Error("HTMLRewriter is not available outside the Workers runtime.");
  return new Rewriter();
}

/** Elements whose link attribute is a navigation the presence keeps. */
const LINK_ATTRIBUTES: ReadonlyArray<readonly [selector: string, attribute: string]> = [
  ["a[href]", "href"],
  ["area[href]", "href"],
  ["form[action]", "action"],
  ["button[formaction]", "formaction"],
  ["input[formaction]", "formaction"],
];

/**
 * The response with every same-origin page link, form action and redirect
 * under the presence. HTML streams through the rewriter; other bodies pass
 * unchanged. `rewriter` is the Workers HTMLRewriter (injected in tests).
 */
export function localizePresenceResponse(
  response: Response,
  presence: string,
  origin: string,
  rewriter: () => PresenceRewriter = workersRewriter,
): Response {
  const headers = new Headers(response.headers);
  const location = headers.get("Location");
  if (location) headers.set("Location", presenceHref(presence, location, origin));
  const link = headers.get("Link");
  if (link) {
    headers.set("Link", link.replace(/<([^>]+)>/g, (_match, target: string) => `<${presenceDiscoveryHref(presence, target, origin)}>`));
  }
  const localized = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  if (!(headers.get("Content-Type") ?? "").toLowerCase().includes("text/html") || !response.body) return localized;
  let html = rewriter();
  for (const [selector, attribute] of LINK_ATTRIBUTES) {
    html = html.on(selector, {
      element(element) {
        // An alternate of another presence names it on purpose.
        if (element.hasAttribute("hreflang")) return;
        const value = element.getAttribute(attribute);
        if (value === null) return;
        const next = presenceHref(presence, value, origin);
        if (next !== value) element.setAttribute(attribute, next);
      },
    });
  }
  return html.transform(localized);
}

/** A same-origin discovery or page URL under the presence (a feed's next page). */
function presenceDiscoveryHref(presence: string, href: string, origin: string): string {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || presenceOfPath(url.pathname) !== null) return href;
    if (!isPresenceServedPath(url.pathname)) return href;
    return `${url.origin}${withPresencePrefix(presence, url.pathname)}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

/**
 * A buyer who chose a market (the `localization` cookie) and navigates to a
 * page of another presence is sent to the same page under the chosen one.
 * Never a crawler, a fetch, a prefetch, a discovery file or a POST; the
 * matrix is read only when the cookie's presence differs from the URL's.
 */
export async function marketChoiceRedirect(
  request: Request,
  readMatrix: () => Promise<MarketMatrix | null>,
): Promise<Response | null> {
  const selection = readMarketSelectionCookie(request.headers.get("Cookie"));
  if (!selection) return null;
  const url = new URL(request.url);
  const urlPresence = presenceOfPath(url.pathname) ?? "";
  if (selection.presence === urlPresence) return null;
  if (!isTopLevelNavigation(request) || isCrawlerUserAgent(request.headers.get("User-Agent"))) return null;
  const matrix = await readMatrix().catch(() => null);
  if (!matrix) return null;
  const resolution = resolveMarket(matrix, {
    surface: "page",
    pathname: url.pathname,
    search: url.search,
    selection,
    crawler: false,
    navigation: true,
  });
  if (!resolution.redirect) return null;
  return new Response(null, {
    status: 302,
    headers: {
      Location: resolution.redirect.location,
      "Cache-Control": "private, no-store",
      "X-Market-Redirect": resolution.redirect.reason,
    },
  });
}

/** The cookie the market selector sets: a country and the presence it resolved to, for a year. */
export function marketSelectionCookieHeader(value: string, secure: boolean): string {
  return `${MARKET_SELECTION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
