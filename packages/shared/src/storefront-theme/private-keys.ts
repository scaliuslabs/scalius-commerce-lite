// What the theme document's `privatePages` schema reads of the private pages
// (private-layout.ts): their keys, each page's host labels and icons, and the
// closed lists a stored arrangement names. The anatomy (private-anatomy.ts)
// takes its pages' labels and icons from here, so the two are one list; the
// parts, styles and layouts stay there, read by the compiler alone. A bundle
// that parses a document (the dashboard's draft check) carries this module,
// never the anatomy's spec table.

/** Rises when a page gains a mandatory part or target or a reading order (a stored arrangement then fills it in on read). */
export const PRIVATE_ANATOMY_VERSION = 5 as const;

/** A host label the theme may change: its own words (at most `max`, figures only where allowed) or one of the host's variants. */
export type PrivateLabelSpec =
  | { readonly max: number; readonly figures?: true; readonly variants?: undefined }
  | { readonly variants: readonly [string, ...string[]]; readonly max?: undefined; readonly figures?: undefined };

/** Each private page's host labels and the host icons a theme may replace with its own image. */
export const PRIVATE_PAGE_WORDS = {
  cart: {
    labels: {
      "cart.heading": { max: 60 },
      // One sentence under the heading; the summary's heading, drawn only when set, among the amounts: words only.
      "cart.intro": { max: 200, figures: true },
      "cart.summaryHeading": { max: 40 },
      "cart.continue": { variants: ["continue-shopping", "keep-shopping", "back-to-store"] },
      "cart.empty": { max: 80 },
      "cart.emptyText": { max: 200, figures: true },
      "cart.subtotal": { variants: ["subtotal", "items-total"] },
      "cart.showSummary": { variants: ["show-summary", "show-cart"] },
      "cart.hideSummary": { variants: ["hide-summary", "hide-cart"] },
      "dialog.goBack": { variants: ["go-back", "cancel"] },
      "dialog.confirm": { variants: ["confirm", "continue-checkout", "agree-and-continue"] },
    },
    icons: ["cart.empty"],
  },
  cartDrawer: {
    labels: {
      "drawer.title": { max: 40 },
      "drawer.checkout": { variants: ["checkout", "proceed-to-checkout"] },
      "drawer.viewCart": { variants: ["view-cart", "go-to-cart"] },
      "drawer.continue": { variants: ["continue-shopping", "keep-shopping"] },
      "drawer.empty": { max: 80 },
      "drawer.startShopping": { variants: ["start-shopping", "browse-products", "continue-shopping"] },
    },
    icons: ["drawer.empty"],
  },
  checkout: { labels: {}, icons: [] },
  receipt: { labels: {}, icons: [] },
  account: { labels: {}, icons: [] },
  // The phone tab bar: its words are the theme's tabs (`blocks.mobileNav`), its look its tokens.
  tabBar: { labels: {}, icons: [] },
} as const satisfies Record<string, { labels: Readonly<Record<string, PrivateLabelSpec>>; icons: readonly string[] }>;

export type PrivatePageKey = keyof typeof PRIVATE_PAGE_WORDS;
/** Every private page, in the anatomy's order. */
export const PRIVATE_PAGE_KEYS = Object.keys(PRIVATE_PAGE_WORDS) as PrivatePageKey[];

/**
 * Which of the buyer's routes each page key's look reaches (the storefront's
 * route patterns), sealed: the pages read it (a page applies the key its
 * route has here), the theme authors' reference prints it, and a test holds
 * every page file of the storefront to it. A key's tokens reach exactly these
 * routes, never more: pointing a key at another route would change what a
 * written theme looks like there. A route that should take a look of its own
 * later takes a new key. The drawer opens over public pages, and the phone
 * tab bar is drawn on every page with the theme's `bottom-tabs` navigation,
 * so neither has a route of its own.
 */
export const PRIVATE_PAGE_ROUTES = {
  cart: ["/cart"],
  cartDrawer: [],
  checkout: ["/checkout"],
  // The confirmation and the order's status view (the theme editor's sample receipt draws the same parts).
  receipt: ["/order-success"],
  // Every page of the account, and the claim thread a guest reaches from the receipt (the account's inbox thread, by its receipt proof).
  account: [
    "/account", "/account/orders/[id]", "/account/profile", "/account/inbox", "/account/inbox/[id]",
    "/account/warranties", "/account/reviews", "/account/gift-cards", "/account/downloads",
    "/warranty-claims/[orderId]/[claimId]",
  ],
  tabBar: [],
} as const satisfies Record<PrivatePageKey, readonly string[]>;

/**
 * The buyer's own routes no page key reaches: they take the store's look (the
 * palette and the store's own markup), and any may gain a page key of its own
 * later. Order tracking is not the receipt: its lookup and code forms are not
 * the receipt's parts, and its status view shows none of the buyer's contact,
 * conversation or actions the receipt's key promises.
 */
export const PRIVATE_STORE_LOOK_ROUTES = [
  "/track-order", "/checkout/quick", "/checkout/continue/[continuationId]", "/agent/continue/[continuationId]", "/cart/recover/[token]",
  "/payment-recovery", "/gift-card-balance", "/newsletter", "/newsletter/confirm", "/newsletter/unsubscribe",
] as const;

/**
 * The account's routes that draw no theme at all (no palette, no fonts, no
 * page key): they show one secret (a licence key, a delivery message) with
 * nothing else on the page, so no theme's or merchant's code or look is
 * beside it.
 */
export const PRIVATE_UNTHEMED_ROUTES = ["/account/licence-key", "/account/delivery-message"] as const;

/** The page key whose look a route takes (`PRIVATE_PAGE_ROUTES`), or null: the store's look, or no theme at all. */
export function privatePageOfRoute(route: string): PrivatePageKey | null {
  for (const page of PRIVATE_PAGE_KEYS) if ((PRIVATE_PAGE_ROUTES[page] as readonly string[]).includes(route)) return page;
  return null;
}

/**
 * The page key a path is served under (a route pattern's `[param]` segments take any one segment): for a renderer
 * that knows the path and not the pattern. The same table, so the same keys.
 */
export function privatePageOfPath(pathname: string): PrivatePageKey | null {
  const segments = pathname.split("/");
  while (segments.length > 2 && segments.at(-1) === "") segments.pop();
  for (const page of PRIVATE_PAGE_KEYS) {
    for (const route of PRIVATE_PAGE_ROUTES[page] as readonly string[]) {
      const pattern = route.split("/");
      if (pattern.length === segments.length && pattern.every((part, index) => (part.startsWith("[") && part.endsWith("]") && segments[index] !== "") || part === segments[index])) return page;
    }
  }
  return null;
}

/** The coverage as lines (`<key> <route>…`), as the theme authors' reference prints it. */
export function privatePageRouteLines(): string[] {
  return [
    ...PRIVATE_PAGE_KEYS.map((page) => `${page} ${PRIVATE_PAGE_ROUTES[page].length > 0 ? PRIVATE_PAGE_ROUTES[page].join(" ") : page === "tabBar" ? "(every page that draws the phone tab bar: no route of its own)" : "(over public pages: no route of its own)"}`),
    `store-look ${PRIVATE_STORE_LOOK_ROUTES.join(" ")}`,
    `no-theme ${PRIVATE_UNTHEMED_ROUTES.join(" ")}`,
  ];
}

/**
 * The host's layout nodes. `stack`: one column. `columns`: one column on
 * phones, side by side from 64rem. `grid`: a grid the theme
 * shapes by its hook's `columns` tokens. `group`: a box with no layout of its own. `fold` (the cart page):
 * on phones its children fold behind a bar that states the total. `scroll`
 * (the drawer): the region that scrolls between the drawer's fixed parts.
 */
export const PRIVATE_LAYOUT_KINDS = ["stack", "columns", "grid", "group", "fold", "scroll"] as const;
export type PrivateLayoutKind = (typeof PRIVATE_LAYOUT_KINDS)[number];

/** The longest theme hook (`data-hook`). */
export const PRIVATE_HOOK_MAX = 40;

/**
 * Where the store's controls sit on a private page (`privatePages.controls`):
 * the light or dark switch (where the theme offers it) and the market and
 * language forms (where the store sells in several), in the store's checkout
 * header (`header`, unset), in a strip at the page's end (`footer`), or not at
 * all (`none`). Each is a host part, its look the `scheme` and `localization`
 * targets' tokens on the `chrome` row.
 */
export const PRIVATE_CONTROL_PLACES = ["header", "footer", "none"] as const;
export type PrivateControlPlace = (typeof PRIVATE_CONTROL_PLACES)[number];

/** Every label key of every page, with its page and its spec. */
export function privateLabelKeys(): Array<{ page: PrivatePageKey; key: string; spec: PrivateLabelSpec }> {
  return PRIVATE_PAGE_KEYS.flatMap((page) => Object.entries(PRIVATE_PAGE_WORDS[page].labels as Readonly<Record<string, PrivateLabelSpec>>).map(([key, spec]) => ({ page, key, spec })));
}

/** Every variant any label offers (core's copy words each, in every language it translates). */
export function privateLabelVariants(): string[] {
  return [...new Set(privateLabelKeys().flatMap((entry) => entry.spec.variants ?? []))].sort();
}

/** Every icon key of every page. */
export function privateIconKeys(): string[] {
  return PRIVATE_PAGE_KEYS.flatMap((page) => [...PRIVATE_PAGE_WORDS[page].icons]);
}
