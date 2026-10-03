import { describe, expect, it } from "vitest";

import {
  formatMarketSelection,
  hreflangAlternates,
  isCrawlerUserAgent,
  isPresenceServedPath,
  isStorefrontPagePath,
  isTopLevelNavigation,
  parseMarketSelection,
  presenceHref,
  presenceOfPath,
  presencePath,
  readMarketSelectionCookie,
  resolveMarket,
  stripPresencePath,
  type MarketMatrix,
  type PageMarketSignals,
} from "./markets";

const BACKUP = {
  id: "mkt_backup",
  handle: "bangladesh",
  name: "Bangladesh",
  isBackup: true,
  countries: ["BD"],
  presences: [{ value: "", locale: "bn" }],
};
const INDIA = {
  id: "mkt_in",
  handle: "india",
  name: "India",
  isBackup: false,
  countries: ["IN", "NP"],
  presences: [{ value: "en-in", locale: "en" }, { value: "hi-in", locale: "hi" }],
};
const SINGLE: MarketMatrix = { markets: [BACKUP] };
const MATRIX: MarketMatrix = { markets: [BACKUP, INDIA] };
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const page = (pathname: string, extra: Partial<PageMarketSignals> = {}): PageMarketSignals => ({
  surface: "page",
  pathname,
  crawler: false,
  navigation: true,
  ...extra,
});

describe("presence paths", () => {
  it("reads a presence from the path's shape only", () => {
    expect(presenceOfPath("/en-in/products/x")).toBe("en-in");
    expect(presenceOfPath("/en-in")).toBe("en-in");
    expect(presenceOfPath("/products/x")).toBeNull();
    expect(presenceOfPath("/")).toBeNull();
    expect(presenceOfPath("/EN-IN/x")).toBeNull();
    expect(presenceOfPath("/eng-in/x")).toBeNull();
    expect(presenceOfPath("/about-us")).toBeNull();
  });

  it("strips a presence back to the page path", () => {
    expect(stripPresencePath("/en-in/products/x", "en-in")).toBe("/products/x");
    expect(stripPresencePath("/en-in", "en-in")).toBe("/");
    expect(stripPresencePath("/en-in/", "en-in")).toBe("/");
    expect(stripPresencePath("/products/x", null)).toBe("/products/x");
  });

  it("prefixes page paths only, keeping query and fragment, and never twice", () => {
    expect(presencePath("en-in", "/")).toBe("/en-in");
    expect(presencePath("en-in", "/products/x?size=M#reviews")).toBe("/en-in/products/x?size=M#reviews");
    expect(presencePath("en-in", "/?q=1")).toBe("/en-in?q=1");
    expect(presencePath("en-in", "/cart")).toBe("/en-in/cart");
    expect(presencePath("en-in", "/en-in/cart")).toBe("/en-in/cart");
    expect(presencePath("en-in", "/hi-in/cart")).toBe("/hi-in/cart");
    for (const href of ["/localization", "/api/checkout/create-order", "/_astro/a.js", "/media/x.webp", "/robots.txt", "/sitemap.xml", "/favicon.svg",
      "/.well-known/ucp", "/ucp/catalog/search", "/theme-preview", "//cdn.example/x", "https://other.example/x", "#top", "?page=2", "mailto:a@b.c"]) {
      expect(presencePath("en-in", href), href).toBe(href);
    }
    // The root presence and no presence change nothing: today's links stay as they are.
    expect(presencePath("", "/products/x")).toBe("/products/x");
    expect(presencePath(null, "/products/x")).toBe("/products/x");
  });

  it("prefixes same-origin absolute URLs and leaves other origins alone", () => {
    const origin = "https://shop.example";
    expect(presenceHref("en-in", "https://shop.example/products/x", origin)).toBe("https://shop.example/en-in/products/x");
    expect(presenceHref("en-in", "https://shop.example/", origin)).toBe("https://shop.example/en-in");
    expect(presenceHref("en-in", "https://shop.example/api/product-feed.xml", origin)).toBe("https://shop.example/api/product-feed.xml");
    expect(presenceHref("en-in", "https://cdn.example/products/x", origin)).toBe("https://cdn.example/products/x");
    expect(presenceHref("en-in", " /cart ", origin)).toBe("/en-in/cart");
    expect(presenceHref("en-in", "javascript:void(0)", origin)).toBe("javascript:void(0)");
  });

  it("serves pages and its own discovery files under a presence, nothing else", () => {
    expect(isStorefrontPagePath("/")).toBe(true);
    expect(isStorefrontPagePath("/products/x")).toBe(true);
    expect(isStorefrontPagePath("/about-us")).toBe(true);
    expect(isStorefrontPagePath("/blog/feed.xml")).toBe(false);
    expect(isPresenceServedPath("/sitemap.xml")).toBe(true);
    expect(isPresenceServedPath("/sitemap-products.xml")).toBe(true);
    expect(isPresenceServedPath("/api/product-feed.xml")).toBe(true);
    expect(isPresenceServedPath("/api/facebook-feed.xml")).toBe(true);
    expect(isPresenceServedPath("/robots.txt")).toBe(false);
    expect(isPresenceServedPath("/.well-known/ucp")).toBe(false);
    expect(isPresenceServedPath("/api/checkout/create-order")).toBe(false);
  });
});

describe("hreflang", () => {
  it("emits nothing while the store has one presence", () => {
    expect(hreflangAlternates(SINGLE, "/products/x", "https://shop.example")).toEqual([]);
  });

  it("lists every active presence and x-default, reciprocal and self-referencing", () => {
    expect(hreflangAlternates(MATRIX, "/products/x", "https://shop.example/")).toEqual([
      { hreflang: "bn-BD", href: "https://shop.example/products/x" },
      { hreflang: "en-IN", href: "https://shop.example/en-in/products/x" },
      { hreflang: "hi-IN", href: "https://shop.example/hi-in/products/x" },
      { hreflang: "x-default", href: "https://shop.example/products/x" },
    ]);
    expect(hreflangAlternates(MATRIX, "/", "https://shop.example").map((each) => each.href)).toEqual([
      "https://shop.example/", "https://shop.example/en-in", "https://shop.example/hi-in", "https://shop.example/",
    ]);
    expect(hreflangAlternates(MATRIX, "/api/product-feed.xml", "https://shop.example")).toEqual([]);
    expect(hreflangAlternates(MATRIX, "/categories/bags?page=2", "https://shop.example").map((each) => each.href)).toEqual([
      "https://shop.example/categories/bags?page=2", "https://shop.example/en-in/categories/bags?page=2",
      "https://shop.example/hi-in/categories/bags?page=2", "https://shop.example/categories/bags?page=2",
    ]);
  });
});

describe("the selection cookie", () => {
  it("round-trips a country and its presence", () => {
    expect(parseMarketSelection(formatMarketSelection({ country: "IN", presence: "en-in" }))).toEqual({ country: "IN", presence: "en-in" });
    expect(parseMarketSelection("BD:")).toEqual({ country: "BD", presence: "" });
    expect(parseMarketSelection("bd:")).toBeNull();
    expect(parseMarketSelection("IN:/evil")).toBeNull();
    expect(readMarketSelectionCookie("a=1; localization=IN%3Aen-in; b=2")).toEqual({ country: "IN", presence: "en-in" });
    expect(readMarketSelectionCookie("localization=garbage")).toBeNull();
    expect(readMarketSelectionCookie(null)).toBeNull();
  });
});

describe("request signals", () => {
  it("treats bots, previews and requests without a user agent as crawlers", () => {
    for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; bingbot/2.0)", "GPTBot/1.0", "", null]) {
      expect(isCrawlerUserAgent(ua), String(ua)).toBe(true);
    }
    expect(isCrawlerUserAgent(BROWSER)).toBe(false);
  });

  it("redirects only top-level document navigations", () => {
    const request = (headers: Record<string, string>, method = "GET") => ({ method, headers: new Headers(headers) });
    expect(isTopLevelNavigation(request({ "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }))).toBe(true);
    expect(isTopLevelNavigation(request({ Accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isTopLevelNavigation(request({ "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" }))).toBe(false);
    expect(isTopLevelNavigation(request({ "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" }))).toBe(false);
    expect(isTopLevelNavigation(request({ "Sec-Fetch-Mode": "navigate", "Sec-Purpose": "prefetch" }))).toBe(false);
    expect(isTopLevelNavigation(request({ Accept: "text/html" }, "POST"))).toBe(false);
    expect(isTopLevelNavigation(request({ Accept: "application/json" }))).toBe(false);
  });
});

describe("resolveMarket", () => {
  it("renders the root as the backup market and a presence as its market, from the URL alone", () => {
    expect(resolveMarket(MATRIX, page("/products/x"))).toMatchObject({ market: { id: "mkt_backup" }, presence: { value: "" }, reason: "root" });
    expect(resolveMarket(MATRIX, page("/en-in/products/x"))).toMatchObject({ market: { id: "mkt_in" }, presence: { value: "en-in" }, reason: "url_presence" });
    expect(resolveMarket(MATRIX, page("/hi-in"))).toMatchObject({ market: { id: "mkt_in" }, presence: { value: "hi-in", locale: "hi" } });
  });

  it("refuses a presence no active market holds", () => {
    expect(resolveMarket(MATRIX, page("/fr-fr/products/x"))).toEqual({ market: null, presence: null, reason: "unknown_presence", redirect: null, suggestion: null });
    expect(resolveMarket(SINGLE, page("/en-in/products/x")).reason).toBe("unknown_presence");
  });

  it("lets an explicit choice redirect a navigation to the same page under the chosen presence", () => {
    const choice = { country: "IN", presence: "en-in" };
    expect(resolveMarket(MATRIX, page("/products/x", { selection: choice, search: "?size=M" })).redirect)
      .toEqual({ location: "/en-in/products/x?size=M", reason: "buyer_choice" });
    expect(resolveMarket(MATRIX, page("/", { selection: choice })).redirect?.location).toBe("/en-in");
    // Back to the root once the buyer chose Bangladesh.
    expect(resolveMarket(MATRIX, page("/en-in/cart", { selection: { country: "BD", presence: "" } })).redirect?.location).toBe("/cart");
    // Already there: no redirect, and the page is still the URL's.
    expect(resolveMarket(MATRIX, page("/en-in/cart", { selection: choice })).redirect).toBeNull();
    // The second presence of the same market stays where the buyer went.
    expect(resolveMarket(MATRIX, page("/x", { selection: { country: "NP", presence: "hi-in" } })).redirect?.location).toBe("/hi-in/x");
    // A presence that left the market falls back to the market's own.
    expect(resolveMarket(MATRIX, page("/x", { selection: { country: "IN", presence: "ta-in" } })).redirect?.location).toBe("/en-in/x");
    // A country no market sells to is the backup market's.
    expect(resolveMarket(MATRIX, page("/en-in/x", { selection: { country: "US", presence: "" } })).redirect?.location).toBe("/x");
  });

  it("never redirects a crawler, a non-navigation, a discovery file or a missing presence", () => {
    const choice = { country: "IN", presence: "en-in" };
    expect(resolveMarket(MATRIX, page("/products/x", { selection: choice, crawler: true })).redirect).toBeNull();
    expect(resolveMarket(MATRIX, page("/products/x", { selection: choice, navigation: false })).redirect).toBeNull();
    expect(resolveMarket(MATRIX, page("/sitemap.xml", { selection: choice })).redirect).toBeNull();
    expect(resolveMarket(MATRIX, page("/fr-fr/x", { selection: choice })).redirect).toBeNull();
  });

  it("never redirects by location: geo only suggests, and only before the buyer has chosen", () => {
    const fromIndia = resolveMarket(MATRIX, page("/products/x", { geoCountry: "IN" }));
    expect(fromIndia.market?.id).toBe("mkt_backup");
    expect(fromIndia.redirect).toBeNull();
    expect(fromIndia.suggestion).toMatchObject({ market: { id: "mkt_in" }, presence: { value: "en-in" }, reason: "geo_hint" });
    expect(resolveMarket(MATRIX, page("/products/x", { geoCountry: "BD" })).suggestion).toBeNull();
    expect(resolveMarket(MATRIX, page("/products/x", { geoCountry: "US" })).suggestion).toBeNull();
    expect(resolveMarket(MATRIX, page("/products/x", { geoCountry: "XX" })).suggestion).toBeNull();
    expect(resolveMarket(MATRIX, page("/en-in/x", { geoCountry: "BD" })).suggestion?.market.id).toBe("mkt_backup");
    expect(resolveMarket(MATRIX, page("/products/x", { geoCountry: "IN", selection: { country: "BD", presence: "" } })).suggestion).toBeNull();
    expect(resolveMarket(MATRIX, page("/products/x", { geoCountry: "IN", crawler: true })).suggestion).toBeNull();
    // A single-market store never suggests anything.
    expect(resolveMarket(SINGLE, page("/products/x", { geoCountry: "IN" })).suggestion).toBeNull();
  });

  it("places a checkout in the shipping country's market, else the backup market", () => {
    expect(resolveMarket(MATRIX, { surface: "checkout", shippingCountry: "np" })).toMatchObject({ market: { id: "mkt_in" }, reason: "shipping_country" });
    expect(resolveMarket(MATRIX, { surface: "checkout", shippingCountry: "BD" })).toMatchObject({ market: { id: "mkt_backup" }, reason: "shipping_country" });
    expect(resolveMarket(MATRIX, { surface: "checkout", shippingCountry: "US" })).toMatchObject({ market: { id: "mkt_backup" }, reason: "backup" });
    expect(resolveMarket(MATRIX, { surface: "checkout", shippingCountry: null })).toMatchObject({ market: { id: "mkt_backup" }, reason: "backup" });
  });

  it("is deterministic", () => {
    const signals = page("/products/x", { geoCountry: "IN", selection: { country: "IN", presence: "en-in" } });
    expect(resolveMarket(MATRIX, signals)).toEqual(resolveMarket(MATRIX, signals));
  });
});
