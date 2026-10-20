import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { resolveStorefrontSettings } from "@scalius/shared/plugins";
import {
  DEFAULT_STOREFRONT_THEME,
  applyStorefrontAppTemplate,
  readStorefrontAppTemplateTheme,
  storefrontThemeDocumentSchema,
} from "@scalius/shared/storefront-theme";
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
import type { StorefrontImage, StorefrontMenuItem } from "@scalius/plugin-sdk/storefront";
import { manifest } from "./index";
import storefront from "./storefront";
import { specGroups } from "./components/product";

const parsed = parsePluginManifest(manifest);
if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
const declared = parsed.manifest;

const image = (name: string): StorefrontImage => ({ url: `https://media.example.com/${name}.webp`, srcset: null, width: 1200, height: 600, alt: name });

function skinSettings(id: string, values: Record<string, unknown> = {}) {
  const skin = declared.storefront.skins.find((entry) => entry.id === id)!;
  return resolveStorefrontSettings(skin.settings, values, { image: () => null, products: () => [] });
}

function shown(html: string): string {
  const result = storefrontShown(html, "scalius.volt");
  expect(result.dropped).toBe(0);
  return result.html;
}

const item = (title: string, url: string, children: StorefrontMenuItem[] = []): StorefrontMenuItem => ({ title, url, children });
const TREE = [
  item("Apple Products", "/categories/apple", [item("iPhone", "/categories/iphone"), item("MacBook", "/categories/macbook")]),
  item("Phones", "/categories/phones", [item("Samsung Phones", "/categories/samsung-phones")]),
  item("Laptops", "/categories/laptops"),
];

describe("Volt's manifest and template", () => {
  it("parses, and its template applies to a valid theme document", () => {
    const template = declared.storefront.templates[0]!;
    const theme = readStorefrontAppTemplateTheme(template.theme, template.themeVersion!);
    expect(theme).not.toBeNull();
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, "scalius.volt/volt", theme!);
    const result = storefrontThemeDocumentSchema.safeParse(document);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(document.apps?.skins?.header?.app).toBe("scalius.volt/volt_header");
    expect(document.apps?.skins?.["listing-main"]?.app).toBe("scalius.volt/volt_listing");
  });
});

describe("the header", () => {
  it("draws the search, quick links, cart and the category bar with mega panels and a promo photo", () => {
    const html = shown(renderHeader(storefront, "volt_header", skinSettings("volt_header", {
      mega_promos: [{ menu: "apple products", image_url: "https://media.example.com/apple.webp", alt: "Apple", link: "/categories/apple" }],
    }), { categories: TREE }, { islands: [] }));
    expect(html).toContain('role="search"');
    expect(html).toContain("Offers");
    expect(html).toContain("Pre-order");
    expect(html).toContain('id="volt-mega-0"');
    expect(html).toContain("https://media.example.com/apple.webp");
    expect(html).toContain("Samsung Phones");
    // A leaf top item has no panel.
    expect(html).not.toContain('id="volt-mega-2"');
    expect(html).toContain('popover="auto"');
  });

  it("leaves out its bottom bar when the theme draws the store's tab bar", () => {
    const own = renderHeader(storefront, "volt_header", skinSettings("volt_header"), { categories: TREE });
    const store = renderHeader(storefront, "volt_header", skinSettings("volt_header"), { categories: TREE, phoneNavigation: { menu: "accordion", tabBar: true } });
    expect(own).toContain("volt-bottom");
    expect(store).not.toContain("volt-bottom");
  });
});

describe("the card", () => {
  it("shows the amount saved as the pill and the regular price struck through", () => {
    const html = shown(renderProductCard(storefront, "volt_card", skinSettings("volt_card"), {
      price: { amountMinor: 11399900, currency: "BDT", formatted: "৳113,999" },
      compareAt: { amountMinor: 11700000, currency: "BDT", formatted: "৳117,000" },
    }));
    expect(html).toContain("volt-pill");
    expect(html).toMatch(/3,001/);
    expect(html).toContain("<del");
    expect(html).not.toContain("Shop Now");
  });
});

describe("the product page", () => {
  it("places the store's buy form and gallery and draws the specification table from its field", () => {
    const data = fixtureProductPage({
      fields: {
        "scalius.volt.specs": [{ group: "Display", rows: [{ label: "Size", value: "6.9 inches | 120Hz" }] }],
        "scalius.volt.key_features": ["Snapdragon 8 Elite Gen 5"],
        "scalius.volt.product_code": "VGL31896",
      },
    });
    const html = shown(renderSkin(storefront, "volt_product", "product-main", skinSettings("volt_product"), data));
    expect(html).toContain('kind="buy-form"');
    expect(html).toContain('kind="gallery"');
    expect(html).toContain('id="volt-spec"');
    expect(html).toContain("6.9 inches");
    expect(html).toContain("VGL31896");
    expect(html).toContain("Key Features");
  });

  it("reads flat and grouped specification rows and ignores junk", () => {
    expect(specGroups([{ label: "RAM", value: "8GB" }])).toEqual([{ group: "", rows: [{ label: "RAM", value: "8GB" }] }]);
    expect(specGroups("nope")).toEqual([]);
    expect(specGroups([{ group: "A", rows: [{ label: 1 }] }])).toEqual([]);
  });
});

describe("the listing", () => {
  it("draws the count, the store's filters and toolbar, and Shop Now cards", () => {
    const html = shown(renderSkin(storefront, "volt_listing", "listing-main", skinSettings("volt_listing", { title_suffix: "Price in Bangladesh" }),
      fixtureListingPage({ title: "Laptop", total: 167, cards: [fixtureProductCard({ id: "a" }), fixtureProductCard({ id: "b" })] })));
    expect(html).toContain("Laptop Price in Bangladesh");
    expect(html).toContain("Showing: (167 Items)");
    expect(html).toContain('kind="filters"');
    expect(html).toContain('kind="toolbar"');
    expect(html).toContain("Shop Now");
  });
});

describe("section skins and sections", () => {
  it("draws the slider with the two side banners", () => {
    const data = fixtureSectionSkinData("hero", {
      layout: "contained-banners",
      slides: [1, 2].map((index) => ({ image: image(`s${index}`), focalPoint: { x: 50, y: 50 }, alt: `Slide ${index}`, link: "/offers" })),
      sideBanners: [{ image: image("side-a"), alt: "A", href: "/a" }, { image: image("side-b"), alt: "B", href: null }],
    });
    const html = shown(renderSkin(storefront, "volt_hero", "section:hero", skinSettings("volt_hero"), data));
    expect(html).toContain("volt-hero-side");
    expect(html).toContain("data-dot=\"1\"");
  });

  it("draws product tabs that work without the island", () => {
    const list = (title: string) => ({ title, url: `/c/${title}`, cards: [fixtureProductCard({ id: `${title}-1` })] });
    const data = fixtureSectionSkinData("product-tabs", { title: "Volt Computers", tabs: [{ label: "Special PC", products: list("pc") }, { label: "CPU", products: list("cpu") }], limit: 8 });
    const html = shown(renderSkin(storefront, "volt_tabs", "section:product-tabs", skinSettings("volt_tabs"), data));
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toContain("Volt Computers");
  });

  it("draws the five-fact trust strip and the offer cards", () => {
    const trust = shown(renderSection(storefront, "trust_strip", { items: [{ icon: "card", title: "36 Months EMI", detail: "" }, { icon: "truck", title: "Fastest Home Delivery", detail: "" }] }));
    expect(trust).toContain("36 Months EMI");
    const offers = shown(renderSection(storefront, "offer_cards", { heading: "Offers", subtitle: null, columns: 3, offers: [{ image: image("tab"), title: "Tab Carnival", text: null, badge: "New", link: "/offers/tab" }] }));
    expect(offers).toContain("Tab Carnival");
    expect(offers).toContain("/offers/tab");
  });

  it("draws the footer with outlets, menus and the chat button", () => {
    const html = shown(renderFooter(storefront, "volt_footer", skinSettings("volt_footer", {
      outlets: [{ name: "Bashundhara City", address: "Level 5, Block A" }],
      whatsapp: "+880 1700-000000",
    }), { menus: [{ title: "Policy", items: [item("Warranty Policy", "/pages/warranty")] }] }));
    expect(html).toContain("Bashundhara City");
    expect(html).toContain("Warranty Policy");
    expect(html).toContain("https://wa.me/8801700000000");
  });
});
