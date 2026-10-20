import { describe, expect, it } from "vitest";
import { sanitizePluginHtml } from "./html";
import { splitStorefrontEmbeds } from "./storefront-embeds";
import { storefrontEmbedRule } from "./storefront-protocol";

const checked = (html: string) => {
  const result = sanitizePluginHtml(html, { pluginId: "acme.theme" });
  if (!result.ok) throw new Error(result.reason);
  return result.html;
};

describe("core embeds", () => {
  it("cuts a product-main skin at its embeds, one buy form at most", () => {
    const split = splitStorefrontEmbeds(checked(
      '<div class="pdp"><h1>Shirt</h1><scalius-embed kind="buy-form" data-title="false"></scalius-embed>'
      + '<scalius-embed kind="buy-form"></scalius-embed><scalius-embed kind="filters"></scalius-embed>'
      + '<scalius-embed kind="reviews"><p>ignored</p></scalius-embed></div>',
    ), storefrontEmbedRule("product-main"));
    expect(split.missing).toEqual([]);
    expect(split.dropped).toBe(2);
    expect(split.parts).toEqual([
      { kind: "html", html: '<div class="pdp"><h1>Shirt</h1>' },
      { kind: "embed", embed: "buy-form", data: { title: "false" }, index: 0 },
      { kind: "embed", embed: "reviews", data: {}, index: 1 },
      { kind: "html", html: "</div>" },
    ]);
  });

  it("names a missing buy form, so core draws the product page instead", () => {
    expect(splitStorefrontEmbeds('<div>No way to buy</div>', storefrontEmbedRule("product-main")).missing).toEqual(["buy-form"]);
  });

  it("appends the listing's pagination when the skin leaves it out", () => {
    const split = splitStorefrontEmbeds('<ul></ul><scalius-embed kind="toolbar"></scalius-embed>', storefrontEmbedRule("listing-main"));
    expect(split.parts.map((part) => (part.kind === "embed" ? part.embed : "html"))).toEqual(["html", "toolbar", "pagination"]);
  });

  it("gives skins without embeds none, and component sections their order forms", () => {
    expect(splitStorefrontEmbeds('<p>a</p><scalius-embed kind="buy-form"></scalius-embed>', storefrontEmbedRule("header")).parts)
      .toEqual([{ kind: "html", html: "<p>a</p>" }]);
    const section = splitStorefrontEmbeds(checked(
      '<scalius-embed kind="order-form" data-product="prod_1" data-max-quantity="3" data-submit-label="Order &amp; pay"></scalius-embed>',
    ), storefrontEmbedRule("section"));
    expect(section.parts).toEqual([{ kind: "embed", embed: "order-form", data: { product: "prod_1", "max-quantity": "3", "submit-label": "Order & pay" }, index: 0 }]);
  });

  it("lets a header and footer skin place their own slots once, and nothing else place a slot", () => {
    const header = splitStorefrontEmbeds(checked(
      '<nav><scalius-embed kind="slot" data-name="header.actions"></scalius-embed><scalius-embed kind="slot" data-name="header.actions"></scalius-embed>'
      + '<scalius-embed kind="slot" data-name="footer.columns"></scalius-embed></nav>',
    ), storefrontEmbedRule("header"));
    expect(header.parts).toEqual([
      { kind: "html", html: "<nav>" },
      { kind: "embed", embed: "slot", data: { name: "header.actions" }, index: 0 },
      { kind: "html", html: "</nav>" },
    ]);
    expect(header.dropped).toBe(2);
    expect(splitStorefrontEmbeds('<scalius-embed kind="slot" data-name="footer.columns"></scalius-embed>', storefrontEmbedRule("footer")).parts)
      .toEqual([{ kind: "embed", embed: "slot", data: { name: "footer.columns" }, index: 0 }]);
    for (const unit of ["component", "section", "product-card", "product-main"] as const) {
      expect(splitStorefrontEmbeds('<scalius-embed kind="slot" data-name="header.actions"></scalius-embed>', storefrontEmbedRule(unit)).parts).toEqual([]);
    }
  });
});
