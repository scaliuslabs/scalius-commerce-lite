// Noor's skins of the store's own sections draw exactly what Noor's own
// sections of the same names drew before they became skins. parity.before.json
// is that earlier markup, rendered by the sections over fixed inputs; each case
// here gives the matching skin the same content as the store's section data
// and skin settings, and expects the same HTML.
import { describe, expect, it } from "vitest";
import { STOREFRONT_COMPONENT_ABI, type StorefrontSectionSkinData, type StorefrontSkinJob } from "@scalius/shared/plugins/storefront-protocol";
import { resolveStorefrontSettings } from "@scalius/shared/plugins";
import { fixtureContext, fixtureProductCard, renderSkin, storefrontShown } from "@scalius/plugin-sdk/storefront/testing";
import type { StorefrontImage, StorefrontProductList } from "@scalius/plugin-sdk/storefront";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { manifest as rawManifest } from "./index";
import storefront from "./storefront";
import before from "./parity.before.json";

const parsed = parsePluginManifest(rawManifest);
if (!parsed.ok) throw new Error("Invalid Noor manifest");
const manifest = parsed.manifest;

const image = (name: string): StorefrontImage => ({
  url: `https://media.example.com/${name}-1200.webp`,
  srcset: `https://media.example.com/${name}-600.webp 600w, https://media.example.com/${name}-1200.webp 1200w`,
  width: 1200,
  height: 1500,
  alt: name,
});
const cards = (source: string, count = 4) => Array.from({ length: count }, (_, index) => fixtureProductCard({
  id: `${source}-${index + 1}`, title: `${source} ${index + 1}`, url: `/products/${source}-${index + 1}`, ...(index % 2 ? { quickAdd: false, compareAt: null, percentOff: null } : {}),
}));
const list = (source: string, count = 4): StorefrontProductList => ({ title: "", url: `/collections/${source}`, cards: cards(source, count) });
const tile = (id: string, title: string, name: string, url: string) => ({ id, title, url, image: image(name), cards: [] });

/** The skin's values as the storefront resolves them (a skin names no images or products). */
function skinSettings(component: string, values: Record<string, unknown>) {
  const skin = manifest.storefront.skins.find((entry) => entry.id === component)!;
  return resolveStorefrontSettings(skin.settings, values, { image: () => null, products: () => [] });
}

/** Renders a section skin the way the storefront asks for it, under the instance id the section had. */
function draw(component: string, legacyType: string, settings: Record<string, unknown>, data: Record<string, unknown>, aboveFold?: boolean): string {
  const target = manifest.storefront.skins.find((entry) => entry.id === component)!.target;
  const job = {
    id: "job_1", kind: "skin", target, component, instanceId: `app-${legacyType}`,
    settings: skinSettings(component, settings),
    data: { type: target.slice("section:".length), version: 1, tiles: [], cards: [], settings: data, ...(aboveFold === undefined ? {} : { aboveFold }) } satisfies StorefrontSectionSkinData,
  } as StorefrontSkinJob;
  const reply = storefront.render({ abi: STOREFRONT_COMPONENT_ABI, context: fixtureContext(), jobs: [job] });
  const result = reply.results[0]!;
  if ("error" in result) throw new Error(result.error);
  return result.html;
}

const heroSlide = { image: image("wide"), focalPoint: { x: 50, y: 50 }, alt: "wide", link: "/search" };

describe("Noor skins draw what Noor's own sections drew", () => {
  const cases: Array<[keyof typeof before, string, string, Record<string, unknown>, Record<string, unknown>]> = [
    ["hero-overlay", "noor_hero", "hero",
      { eyebrow: "New season", secondary_label: "Our story", secondary_link: "/pages/about", layout: "overlay", position: "center", height: "l", scrim: "strong", tone: "soft" },
      { layout: "full-bleed", slides: [{ ...heroSlide, phoneImage: image("tall"), heading: "Eid edit", text: "Hand-picked for the festival.", buttonLabel: "Shop all" }] }],
    ["hero-split", "noor_hero", "hero",
      { layout: "split", position: "end", height: "m", tone: "accent" },
      { layout: "full-bleed", slides: [{ ...heroSlide, heading: "Linen season", buttonLabel: "Shop all" }] }],
    ["products-tabs", "noor_products_tabs", "products",
      { eyebrow: "Shop", text: "Fresh this week.", link: "/search", link_label: "View all", layout: "grid", columns: 4, tone: "soft", spacing: "l" },
      { title: "New arrivals", limit: 8, tabs: [{ label: "New in", products: list("newest") }, { label: "On sale", products: list("on-sale") }, { label: "Popular", products: list("popular") }] }],
    ["products-row", "noor_products_rail", "products",
      { link: "/search", link_label: "Shop all", columns: 4, tone: "plain", spacing: "m" },
      { title: "Popular products", products: list("popular"), limit: 12 }],
    ["products-grid", "noor_products_grid", "products",
      { link: "/search", link_label: "View all", tone: "plain", spacing: "s" },
      { title: "All products", products: list("newest"), columns: 3, rows: 2 }],
    ["tiles-mosaic", "noor_tiles_categories", "collection-tiles",
      { eyebrow: "Browse", link: "/search", link_label: "All categories", layout: "mosaic", tone: "plain", spacing: "m" },
      { style: "photo", title: "Shop by category", categories: [tile("c1", "Sarees", "a", "/categories/sarees"), tile("c2", "Panjabi", "b", "/categories/panjabi"), tile("c3", "Kids", "c", "/categories/kids")] }],
    ["tiles-circles", "noor_tiles_cards", "collection-tiles",
      { layout: "circles", tone: "soft", spacing: "s" },
      { title: "Categories", cards: [{ image: image("a"), title: "Sarees", href: "/categories/sarees" }, { image: image("b"), title: "Panjabi", href: "/categories/panjabi" }] }],
    ["tiles-row", "noor_tiles_categories", "collection-tiles",
      { layout: "row", tone: "ink", spacing: "m" },
      { style: "photo", title: "Collections", categories: [tile("c1", "Eid", "a", "/collections/eid"), tile("c2", "Winter", "b", "/collections/winter")] }],
    ["promo-tiles", "noor_promo_tiles", "promo-tiles",
      { height: "m", tone: "plain", spacing: "m" },
      { tiles: [{ image: image("a"), alt: "Summer sale", href: "/collections/sale" }, { image: image("b"), alt: "New arrivals", href: "/collections/new" }] }],
    ["shop-the-look", "noor_look", "shop-the-look",
      {
        eyebrow: "Shop the look", text: "Pieces from the lookbook.", image_side: "end", tone: "soft", spacing: "m",
        hotspots: [{ x: 30, y: 40, title: "Panjabi", text: "Cotton, regular fit", link: "/products/panjabi" }, { x: 70, y: 60, title: "Scarf" }],
      },
      { title: "The Eid edit", image: image("look"), products: list("popular"), photo: "tall" }],
    ["sale-countdown", "noor_sale", "sale-countdown",
      { eyebrow: "Limited time", text: "Up to 40% off.", label: "View products", link: "/collections/sale", tone: "accent", spacing: "l" },
      { title: "End of season sale", products: list("on-sale", 0), promotion: { endsAt: new Date(Date.UTC(2026, 11, 31, 12)).toISOString() } }],
    ["promises", "noor_promises", "promises",
      { eyebrow: "Why us", heading: "Our promises", style: "cards", tone: "soft", spacing: "s" },
      { style: "icons", source: { kind: "custom", items: [{ title: "Free delivery", detail: "Over ৳2,000" }, { title: "Cash on delivery", detail: "Pay when it arrives" }, { title: "Easy returns", detail: "Seven days" }] } }],
    ["image-text", "noor_story", "image-text",
      {
        eyebrow: "Our story", points: [{ text: "Natural dyes" }, { text: "Fair pay" }], stats: [{ value: "12", label: "Studios" }, { value: "4,000", label: "Pieces" }],
        cta_label: "Read more", cta_link: "/pages/about", tone: "soft", spacing: "m",
      },
      { layout: "image-with-text", heading: "Made by hand", body: "Every piece is woven in Dhaka.\n\nWe work with small studios.", image: image("story"), imageSide: "end" }],
    ["rich-text", "noor_story", "rich-text",
      { eyebrow: "Notes", cta_label: "Shop fabrics", cta_link: "/search", align: "start", size: "l", tone: "plain", spacing: "m" },
      { layout: "rich-text", heading: "About our fabrics", body: "Soft cotton.\n\nBreathable linen." }],
    ["rich-text", "noor_text", "rich-text",
      { eyebrow: "Notes", cta_label: "Shop fabrics", cta_link: "/search", align: "start", size: "l", tone: "plain", spacing: "m" },
      { heading: "About our fabrics", body: "Soft cotton.\n\nBreathable linen." }],
    ["faq", "noor_faq", "faq",
      { eyebrow: "Help", text: "Everything about orders.", contact_label: "Contact us", contact_link: "/pages/contact", structured_data: true, tone: "plain", spacing: "m" },
      { heading: "Questions, answered", items: [{ question: "Delivery time?", answer: "Two to four days." }, { question: "Can I return?", answer: "Yes, within seven days." }] }],
    ["signup", "noor_signup", "signup",
      { eyebrow: "Newsletter", button: "Join the list", link: "/newsletter", tone: "ink", spacing: "m" },
      { heading: "Stay in touch", text: "Early access and offers.", email: "optional", whatsapp: false }],
  ];

  it.each(cases)("%s as %s", (name, component, legacyType, settings, data) => {
    const html = draw(component, legacyType, settings, data);
    // Since the move, arrows and chevrons carry `is-dir` (they mirror on RTL pages); the markup is otherwise the same.
    expect(html.replaceAll('class="noor-icon is-dir"', 'class="noor-icon"')).toBe(before[name]);
    expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
  });
});

describe("Noor skins of the store's sections", () => {
  it("loads the lead section's first row of photos eagerly, high priority for a phone's first two, the rest lazy", () => {
    const photos = (html: string) => [...html.matchAll(/<img [^>]*class="noor-card-img"[^>]*>/g)].map(([tag]) => [
      /loading="(\w+)"/.exec(tag)?.[1], /fetchpriority="(\w+)"/.exec(tag)?.[1] ?? null,
    ]);
    const tabs = { title: "New arrivals", limit: 8, tabs: [{ label: "New in", products: list("newest", 6) }, { label: "On sale", products: list("on-sale") }] };
    const lead = photos(draw("noor_products_tabs", "products", { columns: 4 }, tabs, true));
    // The first tab: its first row of four eager (two high, two normal), then lazy; the hidden tab stays lazy.
    expect(lead.slice(0, 6)).toEqual([["eager", "high"], ["eager", "high"], ["eager", null], ["eager", null], ["lazy", null], ["lazy", null]]);
    expect(lead.slice(6).every(([loading]) => loading === "lazy")).toBe(true);
    // A grid's first row is its column count; a section below the lead loads lazily.
    const grid = photos(draw("noor_products_grid", "products", {}, { title: "All", products: list("newest", 6), columns: 3, rows: 2 }, true));
    expect(grid.map(([loading]) => loading)).toEqual(["eager", "eager", "eager", "lazy", "lazy", "lazy"]);
    for (const aboveFold of [false, undefined]) {
      const below = photos(draw("noor_products_rail", "products", { columns: 4 }, { title: "Popular", products: list("popular"), limit: 12 }, aboveFold));
      expect(below.every(([loading, priority]) => loading === "lazy" && priority === null)).toBe(true);
    }
  });

  it("draws several hero slides as the slideshow, and nothing for a hero without a photo", () => {
    const slides = [{ ...heroSlide, heading: "One" }, { ...heroSlide, image: image("second"), alt: "second", heading: "Two" }];
    const html = draw("noor_hero", "hero", { height: "m" }, { layout: "full-bleed", slides });
    expect(html).toContain('data-island="slideshow"');
    expect(html.match(/ data-slide[ >]/g)).toHaveLength(2);
    expect(html).toContain('<h2 class="noor-display">One</h2>');
    expect(draw("noor_hero", "hero", {}, { layout: "full-bleed", slides: [] })).toBe("");
    expect(draw("noor_hero", "hero", {}, { layout: "full-bleed", slides: [{ ...heroSlide, image: null }] })).toBe("");
  });

  it("leaves the editorial layouts it does not draw to the store", () => {
    expect(draw("noor_story", "image-text", {}, { layout: "multicolumn", heading: "Why", columns: [] })).toBe("");
    expect(draw("noor_story", "image-text", {}, { layout: "testimonial", quotes: [] })).toBe("");
  });

  it("gives the promises the icon their words suggest, and a tick otherwise", () => {
    const html = draw("noor_promises", "promises", {}, {
      style: "icons",
      source: { kind: "delivery-facts", items: [{ title: "Free delivery", detail: "" }, { title: "Pay cash on delivery", detail: "" }, { title: "7-day exchange", detail: "" }, { title: "Handmade", detail: "" }] },
    });
    const icons = [...html.matchAll(/noor-promise-icon"><svg[^>]*>(<[a-z]+ [^>]*>)/g)].map((match) => match[1]);
    expect(new Set(icons).size).toBe(4);
  });

  it("draws the deal's products in a row under the banner", () => {
    const html = draw("noor_sale", "sale-countdown", { label: "See all" }, { title: "Eid sale", products: list("on-sale", 3), promotion: null });
    expect(html).toContain('class="noor-s noor-s-sale"');
    expect(html).toContain('href="/collections/on-sale"');
    expect(html.match(/<article class="noor-card /g)).toHaveLength(3);
    expect(html).not.toContain('data-island="countdown"');
  });

  it("draws saved tile subtitles and optional sale/signup images", () => {
    const tiles = draw("noor_tiles_cards", "collection-tiles", {}, { title: "Linen", cards: [{ image: image("tile"), title: "Summer", subtitle: "Made for warm days", href: "/linen" }] });
    expect(tiles).toContain("Made for warm days");
    for (const [skin, type, data] of [
      ["noor_sale", "sale-countdown", { title: "Season sale", products: list("on-sale", 0), promotion: null, image: image("sale") }],
      ["noor_signup", "signup", { heading: "Stay in touch", text: "News", image: image("signup") }],
    ] as const) {
      const html = draw(skin, type, {}, data);
      expect(html).toContain(`src="${data.image.url}"`);
      expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
    }
  });

  it("draws Specifications from the same resolved core rows", () => {
    const html = draw("noor_specifications", "specifications", {}, { heading: "Specifications", rows: [
      { label: "Fabric", value: "Cotton" }, { label: "Unfilled", value: "" },
    ] });
    expect(html).toContain("<dt>Fabric</dt><dd>Cotton</dd>");
    expect(html).not.toContain("Unfilled");
    expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
  });

  it("draws the same resolved size chart object fields and keeps literal fallback", () => {
    const settings = { heading: "Size chart", rows: [{ label: "Fit", value: "Ask us" }], objectFields: [
      { key: "chest", name: "Chest", list: false, parts: [{ kind: "text", text: "38 inches" }] },
      { key: "guide", name: "Guide", list: false, parts: [{ kind: "link", href: "/size-guide", label: "Size guide", external: false }] },
    ] };
    const html = draw("noor_specifications", "specifications", {}, settings);
    expect(html).toContain("<dt>Chest</dt>");
    expect(html).toContain("38 inches");
    expect(html).toContain('href="/size-guide"');
    expect(html).not.toContain("Ask us");
    expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
    expect(draw("noor_specifications", "specifications", {}, { ...settings, objectFields: [] })).toContain("Ask us");
  });

  it("keeps countdown units in a semantic list", () => {
    const html = draw("noor_sale", "sale-countdown", {}, { title: "Sale", products: list("on-sale", 0), promotion: { endsAt: "2026-12-31T00:00:00Z" } });
    expect(html).toContain('<ol class="noor-timer-list" aria-live="off">');
    expect(html).not.toContain('role="timer"');
  });

  it("falls back to the products' own listing for a view-all link", () => {
    const html = draw("noor_products_rail", "products", { link_label: "View all" }, { title: "Popular", products: list("popular"), limit: 12 });
    expect(html).toContain('<a class="noor-more" href="/collections/popular">');
  });

  it("draws the product page around the store's buy form, with the store's reviews and related products", () => {
    const html = renderSkin(storefront, "noor_product", "product_main", skinSettings("noor_product", {}));
    expect(html).toContain('<scalius-embed kind="buy_form" data-title="false"></scalius-embed>');
    // The store's gallery, buy form, reviews and related products.
    expect(html).toContain('<div class="noor-pdp-media"><scalius-embed kind="gallery"></scalius-embed></div>');
    expect(html.match(/<scalius-embed/g)).toHaveLength(4);
    expect(html).toContain('<h1 class="noor-h1">Linen shirt</h1>');
    // The trail ends on the product itself, so no separator dangles after the last link.
    expect(html).toMatch(/<nav class="noor-crumbs"[^>]*><ol>.*<span aria-current="page">Linen shirt<\/span><\/li><\/ol><\/nav>/);
    expect(html).toContain("Breathable linen, cut for the heat.");
    expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
    const bare = renderSkin(storefront, "noor_product", "product_main", skinSettings("noor_product", { show_reviews: false, show_related: false, show_breadcrumbs: false, show_description: false }));
    expect(bare.match(/<scalius-embed/g)).toHaveLength(2);
    expect(bare).not.toContain("noor-crumbs");
  });
});
