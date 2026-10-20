import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { checkPluginHandlers, pluginHandlerInventory, resolveStorefrontSettings } from "@scalius/shared/plugins";
import { DEFAULT_STOREFRONT_THEME, applyStorefrontAppTemplate, checkStorefrontAppTemplateTheme, readStorefrontAppTemplateTheme, storefrontThemeDocumentSchema } from "@scalius/shared/storefront-theme";
import {
  fixtureListingPage,
  fixtureProductCard,
  fixtureProductPage,
  fixtureSectionSkinData,
  renderFooter,
  renderHeader,
  renderProductCard,
  renderSection,
  renderSkin,
  storefrontShown,
} from "@scalius/plugin-sdk/storefront/testing";
import type { StorefrontImage } from "@scalius/plugin-sdk/storefront";
import plugin, { manifest } from "./index";
import storefront from "./storefront";

const parsed = parsePluginManifest(manifest);
if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
const declared = parsed.manifest;

const image = (name: string): StorefrontImage => ({ url: `https://media.example.com/${name}.webp`, srcset: null, width: 800, height: 800, alt: name });

function skinSettings(id: string, values: Record<string, unknown> = {}) {
  const skin = declared.storefront.skins.find((entry) => entry.id === id)!;
  return resolveStorefrontSettings(skin.settings, values, { image: () => null, products: () => [] });
}

function sectionSettings(type: string, values: Record<string, unknown> = {}) {
  const section = declared.storefront.sections.find((entry) => entry.type === type)!;
  return resolveStorefrontSettings(section.settings, values, {
    image: (id) => image(id),
    products: (source) => [fixtureProductCard({ id: `${source}-1`, percentOff: 20 }), fixtureProductCard({ id: `${source}-2`, compareAt: null, percentOff: null })],
  });
}

function shown(html: string): string {
  const result = storefrontShown(html, "scalius.bazaar");
  expect(result.dropped).toBe(0);
  return result.html;
}

describe("scalius.bazaar manifest", () => {
  it("parses, and its module exports exactly the declared handlers", () => {
    expect(checkPluginHandlers(pluginHandlerInventory(declared), plugin)).toEqual([]);
    expect(declared.storefront.skins.map((skin) => skin.target)).toEqual([
      "header", "footer", "product-card", "product-main", "listing-main", "section:hero", "section:product-rail", "section:deal-block", "section:category-tiles",
    ]);
  });

  it("applies its template to a store's theme as a valid document", () => {
    const template = declared.storefront.templates[0]!;
    const check = checkStorefrontAppTemplateTheme(template.theme, template.themeVersion!);
    expect(check.ok ? null : check).toBeNull();
    const theme = readStorefrontAppTemplateTheme(template.theme, template.themeVersion!);
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, "scalius.bazaar/bazaar", theme!);
    const result = storefrontThemeDocumentSchema.safeParse(document);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(document.apps?.skins?.header?.app).toBe("scalius.bazaar/bazaar_header");
    expect(document.apps?.skins?.["listing-main"]?.app).toBe("scalius.bazaar/bazaar_listing");
  });
});

describe("scalius.bazaar storefront", () => {
  it("draws the marketplace header: search with departments, account, orders, cart and the All drawer", () => {
    const html = shown(renderHeader(storefront, "bazaar_header", skinSettings("bazaar_header", { deliver_place: "Dhaka" }), {
      categories: [{ title: "Electronics", url: "/categories/electronics", children: [{ title: "Phones", url: "/categories/phones", children: [] }] }],
      menu: [{ title: "Today's Deals", url: "/collections/deals", children: [] }, { title: "Home", url: "/categories/home", children: [{ title: "Kitchen", url: "/categories/kitchen", children: [] }] }],
    }, { islands: ["rail", "hero", "search"] }));
    expect(html).toContain('role="search"');
    expect(html).toContain("<select data-department");
    expect(html).toContain('<option value="/categories/electronics">Electronics</option>');
    expect(html).toContain("Account &amp; Lists");
    expect(html).toContain("Returns");
    expect(html).toContain('popovertarget="bazaar-drawer"');
    expect(html).toContain("Shop by Department");
    expect(html).toContain("Dhaka");
    // A department with children gets its full-width panel behind the store's disclosure pattern.
    expect(html).toContain('aria-controls="bazaar-nav-panel-1"');
  });

  it("draws the footer with back to top, link columns and the legal line", () => {
    const html = shown(renderFooter(storefront, "bazaar_footer", skinSettings("bazaar_footer", { services: [{ name: "Bazaar Fresh", text: "Groceries in an hour" }] })));
    expect(html).toContain("Back to top");
    expect(html).toContain("bz-footer-cols");
    expect(html).toContain("Bazaar Fresh");
    expect(html).toContain("bz-legal");
  });

  it("draws the card with stars, the big price, the list price and Add to cart", () => {
    const html = shown(renderProductCard(storefront, "bazaar_card", skinSettings("bazaar_card", { fast_label: "Express" }), {
      title: "Demo earbuds", rating: { average: 4.5, count: 1234 }, percentOff: 20,
      fields: { "scalius.sellers.seller_name": "Acme Audio", "scalius.sellers.seller_handle": "acme-audio" },
    }));
    expect(html).toContain("bz-stars");
    expect(html).toContain("bz-star is-half");
    expect(html).toContain("bz-price-whole");
    expect(html).toContain("Limited time deal");
    expect(html).toContain("by Acme Audio");
    expect(html).toContain("Express");
    expect(html).toContain("data-card-quick-add");
  });

  it("leaves the seller out when the product has none or the merchant hides it", () => {
    expect(renderProductCard(storefront, "bazaar_card", skinSettings("bazaar_card"))).not.toContain("bz-card-seller");
    expect(renderProductCard(storefront, "bazaar_card", skinSettings("bazaar_card", { show_seller: false }), { fields: { "scalius.sellers.seller_name": "Acme" } })).not.toContain("bz-card-seller");
  });

  it("draws the product page around the store's buy form, with Sold by from the seller field", () => {
    const page = fixtureProductPage({ fields: { "scalius.sellers.seller_name": "Acme Audio", "scalius.sellers.seller_handle": "acme-audio", "custom.material": "Aluminium" }, brand: { title: "Acme", url: "/brands/acme" } });
    const html = shown(renderSkin(storefront, "bazaar_product", "product-main", skinSettings("bazaar_product", { returns_text: "30-day returns", other_sellers_link: "/apps/scalius.sellers/store/acme-audio" }), page));
    expect(html).toContain('kind="buy-form"');
    expect(html).toContain('kind="gallery"');
    expect(html).toContain("Visit the Acme Store");
    expect(html).toContain("Sold by");
    expect(html).toContain('href="/apps/scalius.sellers/store/acme-audio"');
    expect(html).toContain("30-day returns");
    expect(html).toContain("Product information");
    expect(html).toContain("Aluminium");
    expect(html).not.toContain("seller_handle");
  });

  it("draws the results page with the filter rail, sort, cards and page links", () => {
    const html = shown(renderSkin(storefront, "bazaar_listing", "listing-main", {}, fixtureListingPage({ kind: "search", title: "earbuds", total: 1200, totalIsCapped: true })));
    expect(html).toContain('kind="filters"');
    expect(html).toContain('kind="toolbar"');
    expect(html).toContain('kind="pagination"');
    expect(html).toContain("of over");
    expect(html).toContain('"earbuds"');
  });

  it("draws the card row as single and quad photo cards", () => {
    const html = shown(renderSection(storefront, "card_row", sectionSettings("card_row", {
      overlap: true,
      cards: [
        { title: "Shop by category", image: "a", image_2: "b", image_3: "c", image_4: "d", caption: "Phones", link: "/categories/phones" },
        { title: "New in home", image: "e", link: "/categories/home", link_label: "Shop now" },
      ],
    })));
    expect(html).toContain("bz-merch-quad");
    expect(html).toContain("bz-merch-single");
    expect(html).toContain("is-overlap");
    expect(html).toContain("Shop now");
  });

  it("draws deal and image rows, and nothing without products", () => {
    expect(shown(renderSection(storefront, "deal_row", sectionSettings("deal_row")))).toContain("bz-deal-item");
    expect(shown(renderSection(storefront, "image_row", sectionSettings("image_row")))).toContain("bz-image-item");
    expect(renderSection(storefront, "deal_row", { ...sectionSettings("deal_row"), products: [] })).toBe("");
  });

  it("skins the store's hero, rows, deals and category tiles", () => {
    const hero = renderSkin(storefront, "bazaar_hero", "section:hero", skinSettings("bazaar_hero"), {
      ...fixtureSectionSkinData("hero"),
      settings: { layout: "full-bleed", slides: [{ image: image("h1"), focalPoint: { x: 50, y: 50 }, alt: "Sale", link: "/collections/sale" }, { image: image("h2"), focalPoint: { x: 50, y: 50 }, alt: "New", link: null }] },
      aboveFold: true,
    });
    expect(shown(hero)).toContain("bz-hero-slide");
    expect(hero).toContain('loading="eager"');
    const list = { title: "New", url: "/collections/new", cards: [fixtureProductCard()] };
    expect(shown(renderSkin(storefront, "bazaar_product_row", "section:product-rail", skinSettings("bazaar_product_row"), { ...fixtureSectionSkinData("product-rail"), settings: { title: "New arrivals", products: list, limit: 12 } }))).toContain("New arrivals");
    expect(shown(renderSkin(storefront, "bazaar_deals", "section:deal-block", {}, { ...fixtureSectionSkinData("deal-block"), settings: { title: "Deals", products: list } }))).toContain("bz-deal-item");
    const tiles = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, title: `Cat ${index}`, url: `/categories/c${index}`, image: image(`c${index}`), cards: [] }));
    const quad = shown(renderSkin(storefront, "bazaar_quad_tiles", "section:category-tiles", skinSettings("bazaar_quad_tiles"), { ...fixtureSectionSkinData("category-tiles"), settings: { style: "photo", title: "Shop by category", categories: tiles } }));
    expect(quad.match(/bz-merch"/g)?.length).toBe(2);
  });
});
