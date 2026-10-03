// @vitest-environment node
/**
 * Subfolder presences at the gateway (docs/MARKETS-DESIGN.md D4): what a
 * presence URL renders, its own page cache key, the buyer-choice redirect
 * (never a crawler, never a fetch, never geo), and the localization of
 * redirects and feed continuations. The HTML rewriter itself runs in workerd
 * (market-presence.workerd.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { MarketMatrix } from "@scalius/shared/markets";
import {
  PRESENCE_HEADER,
  localizePresenceResponse,
  marketChoiceRedirect,
  presenceOfRenderRequest,
  presenceRenderTarget,
  withoutInboundPresence,
  type PresenceElement,
  type PresenceRewriter,
} from "./market-presence";
import { getPublicStorefrontCachePolicy } from "./public-worker-cache";

const ORIGIN = "https://shop.example";
const MATRIX: MarketMatrix = { markets: [
  { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "bn" }] },
  { id: "mkt_in", handle: "india", name: "India", isBackup: false, countries: ["IN"], presences: [{ value: "en-in", locale: "en" }] },
] };
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const navigation = (path: string, cookie?: string, extra: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, {
  headers: { "User-Agent": BROWSER, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", ...(cookie ? { Cookie: cookie } : {}), ...extra },
});

describe("presence render targets", () => {
  it("renders a presence page from the one route tree, with the presence in a gateway-only header", () => {
    expect(presenceRenderTarget(new Request(`${ORIGIN}/products/tee`))).toBeNull();
    const target = presenceRenderTarget(new Request(`${ORIGIN}/en-in/products/tee?size=M`));
    expect(target).not.toBe("not_found");
    const { presence, render } = target as { presence: string; render: Request };
    expect(presence).toBe("en-in");
    expect(render.url).toBe(`${ORIGIN}/products/tee?size=M`);
    expect(presenceOfRenderRequest(render)).toBe("en-in");
    expect((presenceRenderTarget(new Request(`${ORIGIN}/en-in`)) as { render: Request }).render.url).toBe(`${ORIGIN}/`);
    for (const served of ["/en-in/sitemap.xml", "/en-in/sitemap-products.xml?page=2", "/en-in/api/product-feed.xml", "/en-in/api/facebook-feed.xml", "/en-in/cart"]) {
      expect(presenceRenderTarget(new Request(`${ORIGIN}${served}`)), served).not.toBe("not_found");
    }
    for (const refused of ["/en-in/robots.txt", "/en-in/api/checkout/create-order", "/en-in/_astro/app.js", "/en-in/.well-known/ucp", "/en-in/media/x.webp", "/en-in/localization"]) {
      expect(presenceRenderTarget(new Request(`${ORIGIN}${refused}`)), refused).toBe("not_found");
    }
  });

  it("drops a presence header a client sent", () => {
    const forged = new Request(`${ORIGIN}/products/tee`, { headers: { [PRESENCE_HEADER]: "en-in" } });
    expect(presenceOfRenderRequest(withoutInboundPresence(forged))).toBeNull();
    expect(presenceOfRenderRequest(new Request(ORIGIN, { headers: { [PRESENCE_HEADER]: "../x" } }))).toBeNull();
  });
});

describe("presence page cache keys", () => {
  const key = (path: string, init: RequestInit = {}) => getPublicStorefrontCachePolicy(new Request(`${ORIGIN}${path}`, init))?.canonicalUrl ?? null;

  it("keeps the presence in the key and classifies by the page it renders", () => {
    expect(key("/products/tee?utm_source=x")).toBe(`${ORIGIN}/products/tee`);
    expect(key("/en-in/products/tee?utm_source=x")).toBe(`${ORIGIN}/en-in/products/tee`);
    expect(key("/en-in")).toBe(`${ORIGIN}/en-in`);
    expect(key("/en-in/")).toBe(`${ORIGIN}/en-in`);
    expect(key("/en-in/categories/bags?page=1&sortBy=newest")).toBe(key("/en-in/categories/bags"));
    expect(key("/en-in/cart?x=1")).toBe(`${ORIGIN}/en-in/cart`);
    expect(key("/en-in/sitemap-products.xml?page=2")).toBe(`${ORIGIN}/en-in/sitemap-products.xml?page=2`);
    // A variant selection and a checkout are private under a presence too.
    expect(key("/en-in/products/tee?size=M")).toBeNull();
    expect(key("/en-in/checkout")).toBeNull();
    // The market cookie never bypasses the shared cache.
    expect(key("/products/tee", { headers: { Cookie: "localization=IN%3Aen-in" } })).toBe(`${ORIGIN}/products/tee`);
  });
});

describe("the buyer's explicit choice", () => {
  it("redirects a navigation to the same page under the chosen presence, reading the matrix only on a mismatch", async () => {
    const readMatrix = vi.fn(async () => MATRIX);
    expect(await marketChoiceRedirect(navigation("/products/tee"), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(navigation("/en-in/products/tee", "localization=IN%3Aen-in"), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(navigation("/products/tee", "localization=BD%3A"), readMatrix)).toBeNull();
    expect(readMatrix).not.toHaveBeenCalled();

    const redirect = await marketChoiceRedirect(navigation("/products/tee?size=M", "a=1; localization=IN%3Aen-in"), readMatrix);
    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get("Location")).toBe("/en-in/products/tee?size=M");
    expect(redirect?.headers.get("Cache-Control")).toBe("private, no-store");
    const back = await marketChoiceRedirect(navigation("/en-in/cart", "localization=BD%3A"), readMatrix);
    expect(back?.headers.get("Location")).toBe("/cart");
  });

  it("never redirects a crawler, a fetch, a prefetch, a discovery file, a POST or on a failed read", async () => {
    const readMatrix = vi.fn(async () => MATRIX);
    const cookie = "localization=IN%3Aen-in";
    expect(await marketChoiceRedirect(navigation("/products/tee", cookie, { "User-Agent": "Googlebot/2.1" }), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(navigation("/products/tee", cookie, { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" }), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(navigation("/products/tee", cookie, { "Sec-Purpose": "prefetch" }), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(navigation("/sitemap.xml", cookie), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(new Request(`${ORIGIN}/products/tee`, { method: "POST", headers: { Cookie: cookie } }), readMatrix)).toBeNull();
    expect(await marketChoiceRedirect(navigation("/products/tee", cookie), async () => { throw new Error("down"); })).toBeNull();
    expect(await marketChoiceRedirect(navigation("/products/tee", cookie), async () => null)).toBeNull();
  });
});

/** A rewriter double: applies each handler to the given elements, by selector. */
function fakeRewriter(elements: Record<string, FakeElement[]>) {
  return (): PresenceRewriter => {
    const rewriter: PresenceRewriter = {
      on(selector, handlers) {
        for (const element of elements[selector] ?? []) handlers.element(element);
        return rewriter;
      },
      transform: (response) => response,
    };
    return rewriter;
  };
}
class FakeElement implements PresenceElement {
  constructor(readonly attributes: Record<string, string>) {}
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}

describe("presence responses", () => {
  it("keeps redirects and feed continuations inside the presence", () => {
    const redirect = localizePresenceResponse(new Response(null, { status: 303, headers: { Location: "/cart" } }), "en-in", ORIGIN);
    expect(redirect.headers.get("Location")).toBe("/en-in/cart");
    const external = localizePresenceResponse(new Response(null, { status: 302, headers: { Location: "https://pay.example/x" } }), "en-in", ORIGIN);
    expect(external.headers.get("Location")).toBe("https://pay.example/x");
    const feed = localizePresenceResponse(new Response("<rss/>", {
      headers: { "Content-Type": "application/xml", Link: `<${ORIGIN}/api/product-feed.xml?cursor=feed-v1.a.b&limit=100>; rel="next"` },
    }), "en-in", ORIGIN, () => { throw new Error("XML is not rewritten"); });
    expect(feed.headers.get("Link")).toBe(`<${ORIGIN}/en-in/api/product-feed.xml?cursor=feed-v1.a.b&limit=100>; rel="next"`);
  });

  it("rewrites page links and form actions, never assets, other origins or alternates", async () => {
    const elements = {
      "a[href]": [
        new FakeElement({ href: "/products/tee" }),
        new FakeElement({ href: `${ORIGIN}/categories/bags?page=2` }),
        new FakeElement({ href: "/media/x.webp" }),
        new FakeElement({ href: "https://facebook.com/shop" }),
        new FakeElement({ href: "#reviews" }),
        new FakeElement({ href: "/", hreflang: "bn-BD" }),
      ],
      "form[action]": [new FakeElement({ action: "/buy/tee" }), new FakeElement({ action: "/localization" }), new FakeElement({ action: "/api/newsletter/subscribe" })],
      "button[formaction]": [new FakeElement({ formaction: "/search" })],
    };
    const response = localizePresenceResponse(new Response("<p>x</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } }), "en-in", ORIGIN, fakeRewriter(elements));
    expect(await response.text()).toBe("<p>x</p>");
    expect(elements["a[href]"].map((element) => element.attributes.href)).toEqual([
      "/en-in/products/tee", `${ORIGIN}/en-in/categories/bags?page=2`, "/media/x.webp", "https://facebook.com/shop", "#reviews", "/",
    ]);
    expect(elements["form[action]"].map((element) => element.attributes.action)).toEqual(["/en-in/buy/tee", "/localization", "/api/newsletter/subscribe"]);
    expect(elements["button[formaction]"][0]!.attributes.formaction).toBe("/en-in/search");
  });
});
