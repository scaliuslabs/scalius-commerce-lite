import { describe, expect, it } from "vitest";
import { serializeJsonLd, type PluginHead } from "@scalius/shared/plugins/storefront";
import { layoutHasAppBlocks, mergeAppHeads, readAppBlocks, readAppHead, readHomepageAppSurfaces, readProductAppBlocks } from "./app-surfaces";
import { appComponentsRenderOn, appScriptOrigins, appScriptsForPage, readAppScripts, storefrontAppPage } from "./app-scripts";
import { setPageCspHeader } from "./middleware-helper/csp-handler";

const head = (meta: Array<["name" | "property", string, string]> = [], jsonLd: unknown[] = []): PluginHead => ({
  meta: meta.map(([attribute, key, content]) => ({ attribute, key, content })),
  jsonLd: jsonLd.map((value) => serializeJsonLd(value)),
});

describe("app surfaces from the API", () => {
  it("keeps the homepage's drawn sections by id and leaves out ones without HTML", () => {
    const surfaces = readHomepageAppSurfaces([
      { sectionId: "greeting", html: "<p>Hello</p>", head: head([["name", "acme-verify", "abc"]]) },
      { sectionId: "empty", html: "   ", head: head() },
      { sectionId: "greeting", html: "<p>Twice</p>", head: head() },
      { sectionId: "Bad Id", html: "<p>x</p>" },
      { html: "<p>no id</p>" },
      "junk",
    ]);
    expect([...surfaces.keys()]).toEqual(["greeting"]);
    expect(surfaces.get("greeting")).toEqual({ sectionId: "greeting", html: "<p>Hello</p>", head: head([["name", "acme-verify", "abc"]]) });
    expect(readHomepageAppSurfaces(undefined).size).toBe(0);
  });

  it("keeps product blocks in order with their placement, and drops malformed ones", () => {
    const blocks = readProductAppBlocks([
      { id: "heart", app: "acme.wishlist/button", placement: "buy-box", html: "<form></form>", head: head() },
      { id: "note", app: "acme.hello/note", placement: "below", html: "<p>Note</p>", head: null },
      { id: "nowhere", app: "acme.hello/note", placement: "sidebar", html: "<p>x</p>" },
      { id: "bad-app", app: "not an app", placement: "below", html: "<p>x</p>" },
      { id: "blank", app: "acme.hello/note", placement: "below", html: "" },
    ]);
    expect(blocks.map((block) => [block.id, block.placement])).toEqual([["heart", "buy-box"], ["note", "below"]]);
    expect(blocks[1]!.head).toEqual({ meta: [], jsonLd: [] });
  });

  it("renders head tags only in the API's shape, and never JSON-LD that could close its script", () => {
    expect(readAppHead({
      meta: [
        { attribute: "name", key: "acme-verify", content: "abc" },
        { attribute: "property", key: "product:brand", content: "Acme" },
        { attribute: "http-equiv", key: "refresh", content: "0;url=https://evil.example" },
        { attribute: "name", key: "Bad Key", content: "x" },
        { attribute: "name", key: "empty", content: "  " },
      ],
      jsonLd: [serializeJsonLd({ "@context": "https://schema.org", "@type": "Thing", name: "</script>" }), '{"a":"</script><script>"}', 42],
    })).toEqual({
      meta: [
        { attribute: "name", key: "acme-verify", content: "abc" },
        { attribute: "property", key: "product:brand", content: "Acme" },
      ],
      jsonLd: [serializeJsonLd({ "@context": "https://schema.org", "@type": "Thing", name: "</script>" })],
    });
  });

  it("merges several surfaces' head tags: each meta once (first wins), each JSON-LD once", () => {
    const thing = { "@context": "https://schema.org", "@type": "Thing", name: "A" };
    expect(mergeAppHeads([
      head([["name", "acme-verify", "first"]], [thing]),
      head([["name", "acme-verify", "second"], ["property", "product:brand", "Acme"]], [thing]),
    ])).toEqual(head([["name", "acme-verify", "first"], ["property", "product:brand", "Acme"]], [thing]));
  });
});

describe("checkout and account app blocks", () => {
  it("keeps blocks with a known target and HTML, each once, in order", () => {
    expect(readAppBlocks([
      { id: "acme.notes/delivery", target: "purchase.checkout.contact.render-after", html: "<p>Ships today</p>" },
      { id: "acme.notes/delivery", target: "purchase.checkout.contact.render-after", html: "<p>Again</p>" },
      { id: "acme.notes/odd", target: "purchase.checkout.header.render", html: "<p>Unknown target</p>" },
      { id: "acme.notes/empty", target: "customer-account.profile.block.render", html: "  " },
      { id: "not a key", target: "customer-account.profile.block.render", html: "<p>x</p>" },
      { id: "acme.notes/points", target: "customer-account.order-index.block.render", html: "<p>Points</p>" },
    ])).toEqual([
      { id: "acme.notes/delivery", target: "purchase.checkout.contact.render-after", html: "<p>Ships today</p>" },
      { id: "acme.notes/points", target: "customer-account.order-index.block.render", html: "<p>Points</p>" },
    ]);
    expect(readAppBlocks(null)).toEqual([]);
  });

  it("reads a page group's blocks only when the layout names it", () => {
    expect(layoutHasAppBlocks({ appBlockPages: ["checkout"] }, "checkout")).toBe(true);
    expect(layoutHasAppBlocks({ appBlockPages: ["checkout"] }, "account")).toBe(false);
    expect(layoutHasAppBlocks({}, "checkout")).toBe(false);
    expect(layoutHasAppBlocks(null, "order")).toBe(false);
  });
});

describe("app scripts", () => {
  const scripts = [
    { pluginId: "acme.reviews", src: "https://cdn.acme.example/widget.js", placement: "body-end", pages: ["product"] },
    { pluginId: "acme.chat", src: "https://chat.example/loader.js?v=2", placement: "head", pages: ["all"] },
    { pluginId: "acme.listing", src: "https://list.example/l.js", placement: "body-end", pages: ["listing", "home"] },
    { pluginId: "evil.http", src: "http://plain.example/x.js", placement: "head", pages: ["all"] },
    { pluginId: "evil.inline", src: "javascript:alert(1)", placement: "head", pages: ["all"] },
    { pluginId: "acme.odd", src: "https://odd.example/x.js", placement: "inline", pages: ["all"] },
  ];

  it("names each storefront route's page kind", () => {
    expect(storefrontAppPage("/")).toBe("home");
    expect(storefrontAppPage("/products/linen-shirt")).toBe("product");
    expect(storefrontAppPage("/products/linen-shirt/reviews")).toBeNull();
    for (const path of ["/categories/bags", "/categories", "/brands/acme", "/collections/col_1", "/collections/", "/search"]) {
      expect(storefrontAppPage(path), path).toBe("listing");
    }
    expect(storefrontAppPage("/cart")).toBe("cart");
    expect(storefrontAppPage("/checkout")).toBe("checkout");
    expect(storefrontAppPage("/checkout/quick")).toBe("checkout");
    expect(storefrontAppPage("/order-success")).toBe("order-success");
    for (const path of ["/account", "/account/profile", "/account/orders/ord_1", "/payment-recovery", "/track-order", "/newsletter/confirm"]) {
      expect(storefrontAppPage(path), path).toBe("private");
    }
    for (const path of ["/about-us", "/apps/acme.wishlist/wishlist", "/blog", "/accounts"]) expect(storefrontAppPage(path), path).toBeNull();
  });

  it("loads only https scripts that name the page or all", () => {
    expect(readAppScripts(scripts).map((script) => script.pluginId)).toEqual(["acme.reviews", "acme.chat", "acme.listing"]);
    expect(appScriptsForPage(scripts, "product").map((script) => script.pluginId)).toEqual(["acme.reviews", "acme.chat"]);
    expect(appScriptsForPage(scripts, "home").map((script) => script.pluginId)).toEqual(["acme.chat", "acme.listing"]);
    expect(appScriptsForPage(scripts, null).map((script) => script.pluginId)).toEqual(["acme.chat"]);
    expect(appScriptsForPage(undefined, "home")).toEqual([]);
  });

  it("never loads an \"all\" script on checkout, order or account pages: only a script naming the page", () => {
    const buyer = [
      ...scripts,
      { pluginId: "acme.pay", src: "https://pay.example/p.js", placement: "body-end", pages: ["checkout", "order-success"] },
    ];
    expect(appScriptsForPage(buyer, "checkout").map((script) => script.pluginId)).toEqual(["acme.pay"]);
    expect(appScriptsForPage(buyer, "order-success").map((script) => script.pluginId)).toEqual(["acme.pay"]);
    expect(appScriptsForPage(buyer, "private")).toEqual([]);
    expect(appScriptsForPage(buyer, "cart").map((script) => script.pluginId)).toEqual(["acme.chat"]);
  });

  it("renders app components only off the buyer's pages", () => {
    for (const path of ["/", "/products/x", "/cart", "/about-us"]) expect(appComponentsRenderOn(storefrontAppPage(path)), path).toBe(true);
    for (const path of ["/checkout", "/order-success", "/account/orders/ord_1", "/payment-recovery", "/track-order"]) {
      expect(appComponentsRenderOn(storefrontAppPage(path)), path).toBe(false);
    }
  });

  it("adds a script's host to the page CSP only when the layout lists it for that page", () => {
    // What the middleware does for a page: the layout's scripts of this page kind.
    const csp = (layoutScripts: unknown, pathname: string) => setPageCspHeader(
      new Response("ok"),
      {},
      "",
      [],
      appScriptOrigins(appScriptsForPage(layoutScripts, storefrontAppPage(pathname))),
    ).headers.get("Content-Security-Policy")!;
    const directive = (policy: string, name: string) => policy.split("; ").find((entry) => entry.startsWith(`${name} `))!;

    const product = csp(scripts, "/products/linen");
    expect(directive(product, "script-src")).toContain("https://cdn.acme.example");
    expect(directive(product, "connect-src")).toContain("https://cdn.acme.example");
    expect(directive(product, "script-src")).toContain("https://chat.example");
    expect(product).not.toContain("https://list.example");
    expect(product).not.toContain("plain.example");
    // An origin, never the script's path or query.
    expect(product).not.toContain("loader.js");

    const listing = csp(scripts, "/categories/bags");
    expect(listing).toContain("https://list.example");
    expect(listing).not.toContain("https://cdn.acme.example");

    // No app scripts in the layout payload: no app host in the CSP.
    const none = csp([], "/products/linen");
    for (const host of ["cdn.acme.example", "chat.example", "list.example"]) expect(none).not.toContain(host);
  });

  it("never lets a non-https or wildcard origin into the CSP", () => {
    const policy = setPageCspHeader(new Response("ok"), {}, "", [], ["http://plain.example", "https://*.wild.example", "https://ok.example", "https://ok.example"])
      .headers.get("Content-Security-Policy")!;
    expect(policy).not.toContain("plain.example");
    expect(policy).not.toContain("wild.example");
    const scriptSrc = policy.split("; ").find((entry) => entry.startsWith("script-src "))!;
    expect(scriptSrc.split(" ").filter((source) => source === "https://ok.example")).toHaveLength(1);
  });
});
