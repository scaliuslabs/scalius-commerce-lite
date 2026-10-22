import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { checkPluginHandlers, pluginHandlerInventory, resolveStorefrontSettings } from "@scalius/shared/plugins";
import { validatePluginSettingValues, type PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import {
  DEFAULT_STOREFRONT_THEME,
  applyStorefrontAppTemplate,
  readStorefrontAppTemplateTheme,
  readStorefrontPagePresetSections,
  storefrontThemeDocumentSchema,
} from "@scalius/shared/storefront-theme";
import {
  fixtureProductCard,
  fixtureContext,
  renderFooter,
  renderHeader,
  renderProductCard,
  renderSection,
  storefrontShown,
} from "@scalius/plugin-sdk/storefront/testing";
import type { StorefrontImage } from "@scalius/plugin-sdk/storefront";
import plugin, { manifest } from "./index";
import storefront from "./storefront";
import { countdownEnd } from "./components/sections/commerce";

const image = (name: string): StorefrontImage => ({
  url: `https://media.example.com/${name}-1200.webp`,
  srcset: `https://media.example.com/${name}-600.webp 600w, https://media.example.com/${name}-1200.webp 1200w`,
  width: 1200,
  height: 1500,
  alt: name,
});

const parsed = parsePluginManifest(manifest);
if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
const declared = parsed.manifest;

/** A section's settings as the storefront resolves them: defaults plus `values`, images and products from fixtures. */
function settingsFor(type: string, values: Record<string, unknown> = {}) {
  const section = declared.storefront.sections.find((entry) => entry.type === type)!;
  return resolveStorefrontSettings(section.settings, values, {
    image: (id) => image(id),
    products: (source) => [fixtureProductCard({ id: `${source}-1` }), fixtureProductCard({ id: `${source}-2`, quickAdd: false, compareAt: null, percentOff: null })],
  });
}

function slotSettings(id: string, values: Record<string, unknown> = {}) {
  const slot = declared.storefront.skins.find((entry) => entry.id === id)!;
  return resolveStorefrontSettings(slot.settings, values, { image: () => null, products: () => [] });
}

/** What the storefront would put on the page: the checked markup. */
function shown(html: string): string {
  const result = storefrontShown(html, "scalius.noor");
  expect(result.dropped).toBe(0);
  return result.html;
}


const LANDING = { page: { kind: "landing" as const, path: "/pages/offer" } };

describe("Noor manifest", () => {
  it("supplies valid settings in every template and preset before merchant-required fields are filled", () => {
    const validate = (label: string, schema: PluginSettingsSchema, values: Record<string, unknown>) => {
      // Missing required fields (for example a product) await the merchant; supplied values must be valid.
      const result = validatePluginSettingValues(schema.filter((field) => Object.hasOwn(values, field.key)), values);
      expect(result.ok ? [] : result.errors, label).toEqual([]);
    };
    const sections = declared.storefront.pagePresets.flatMap((preset) => readStorefrontPagePresetSections(preset.sections, preset.themeVersion!)!);
    for (const template of declared.storefront.templates) {
      const theme = readStorefrontAppTemplateTheme(template.theme, template.themeVersion!)!;
      sections.push(...(theme.sections ?? []));
      for (const placement of Object.values(theme.apps?.skins ?? {})) {
        if (!placement) continue;
        const skin = declared.storefront.skins.find((entry) => `${declared.id}/${entry.id}` === placement.app)!;
        expect(skin, placement.app).toBeDefined();
        validate(placement.app, skin.settings, placement.values);
      }
    }
    for (const section of sections) {
      if (section.type !== "app") {
        // One of the store's own sections drawn by a Noor skin of the section's type.
        const placement = (section as { skin?: { app: string; values: Record<string, unknown> } }).skin!;
        const skin = declared.storefront.skins.find((entry) => `${declared.id}/${entry.id}` === placement.app)!;
        expect(skin, section.id).toBeDefined();
        expect(skin.target, section.id).toBe(`section:${section.type}`);
        validate(section.id, skin.settings, placement.values);
        continue;
      }
      const declaration = declared.storefront.sections.find((item) => `${declared.id}/${item.type}` === section.settings.app)!;
      expect(declaration, section.settings.app).toBeDefined();
      validate(section.id, declaration.settings, section.settings.values);
    }
    const tabs = declared.storefront.skins.find((skin) => skin.id === "noor_products_tabs")!;
    const invalid = validatePluginSettingValues(tabs.settings.filter((field) => field.key === "columns"), { columns: 9 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors).toEqual([expect.objectContaining({ key: "columns" })]);
  });

  it("is a valid manifest whose module draws every declared component", () => {
    expect(checkPluginHandlers(pluginHandlerInventory(declared), plugin)).toEqual([]);
    const sections = Object.keys(storefront.definition.sections ?? {}).sort();
    expect(sections).toEqual(declared.storefront.sections.map((section) => section.type).sort());
    expect(Object.keys(storefront.definition.skins ?? {}).sort()).toEqual(declared.storefront.skins.map((skin) => skin.id).sort());
    // The nine sections the store has no equivalent of; the rest are skins of the store's own sections.
    expect(declared.storefront.sections.map((section) => section.type).sort()).toEqual([
      "featured_product", "gallery", "landing_features", "landing_hero", "landing_order", "marquee", "slideshow", "testimonials", "video",
    ]);
    expect(declared.storefront.skins.map((skin) => skin.target).sort()).toEqual([
      "footer", "header", "product_card", "product_main",
      "section:banner_mosaic", "section:category_tiles", "section:deal_block", "section:editorial", "section:faq", "section:hero",
      "section:lookbook", "section:newsletter", "section:product_grid", "section:product_rail", "section:product_tabs",
      "section:seo_text", "section:shop_by", "section:specifications", "section:usp_strip",
    ]);
  });

  it("asks for nothing but storefront code", () => {
    expect(declared.scopes).toEqual([]);
    expect(declared.allowedHosts).toEqual([]);
    expect(declared.storefront.connect).toEqual([]);
  });

  it("is one template: the look applies to a store's theme as a valid document", () => {
    expect(declared.storefront.templates.map((template) => template.id)).toEqual(["noor"]);
    const theme = readStorefrontAppTemplateTheme(declared.storefront.templates[0]!.theme, declared.storefront.templates[0]!.themeVersion!);
    expect(theme).not.toBeNull();
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, "scalius.noor/noor", theme!);
    const result = storefrontThemeDocumentSchema.safeParse(document);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(document.apps?.skins?.header?.app).toBe("scalius.noor/noor_header");
    expect(document.apps?.template).toBe("scalius.noor/noor");
    // The header shows the merchant's own menu, in their order.
    expect(document.blocks.navigation.source).toBe("menu");
    // The merchant's brand and landing pages stay.
    expect(document.brand).toEqual(DEFAULT_STOREFRONT_THEME.brand);
    expect(document.pages.landing).toEqual(DEFAULT_STOREFRONT_THEME.pages.landing);
  });

  it("starts new stores and campaigns with product facts, without invented trust claims", () => {
    const template = readStorefrontAppTemplateTheme(declared.storefront.templates[0]!.theme, declared.storefront.templates[0]!.themeVersion!)!;
    const campaign = readStorefrontPagePresetSections(declared.storefront.pagePresets[0]!.sections, declared.storefront.pagePresets[0]!.themeVersion!)!;
    const sections = [...(template.sections ?? []), ...campaign];
    // Testimonials, questions and promises are the merchant's to write: a template starts with none of them.
    const trustTypes = ["scalius.noor/testimonials", "faq", "usp_strip", "editorial"];
    for (const section of sections) {
      if (section.type !== "app") {
        expect(trustTypes).not.toContain(section.type);
        continue;
      }
      expect(trustTypes).not.toContain(section.settings.app);
      const values = section.settings.values;
      for (const field of ["assurances", "stats", "summary", "urgency", "ends_at"]) expect(values[field]).toBeUndefined();
      const rendered = renderSection(storefront, section.settings.app.slice("scalius.noor/".length), settingsFor(section.settings.app.slice("scalius.noor/".length), values));
      expect(rendered).not.toMatch(/Cash on delivery|two.days|seven.day|40%|1,200\s*(?:happy|customers|reviews|orders)|quality checked|pure cotton|inspect|check the product before/i);
    }
    expect(template.apps?.skins?.header?.values.announcements).toEqual([]);
    expect(template.apps?.skins?.footer?.values.payments).toEqual([]);
    expect(template.apps?.skins?.footer?.values.tagline).toBe("");
    expect(campaign.map((section) => section.id)).toEqual(["lp-hero", "lp-features", "lp-steps", "lp-order"]);
    const appCampaign = campaign.filter((section) => section.type === "app");
    const hero = appCampaign[0]!.settings.values;
    const html = renderSection(storefront, "landing_hero", settingsFor("landing_hero", { ...hero, product: "prod_1" }));
    expect(html).toContain("Linen shirt");
    expect(html).not.toContain("Special offer");
    expect(html).not.toContain("noor-urgency");
    expect(renderSection(storefront, "landing_features", settingsFor("landing_features", appCampaign[1]!.settings.values))).toBe("");
    const order = renderSection(storefront, "landing_order", settingsFor("landing_order", { ...appCampaign.at(-1)!.settings.values, product: "prod_1" }));
    expect(order).toContain('<scalius-embed kind="order_form"');
    expect(order).not.toContain("noor-assure");
  });

  it("resolves omitted copy neutrally while preserving explicit merchant values", () => {
    expect(settingsFor("landing_hero")).toMatchObject({ badge: null, urgency: null });
    expect(slotSettings("noor_hero")).toMatchObject({ eyebrow: null, secondary_label: null });
    expect(slotSettings("noor_sale")).toMatchObject({ eyebrow: null, text: null });
    expect(settingsFor("testimonials")).toMatchObject({ heading: "Customer reviews", items: [] });
    const unrated = settingsFor("testimonials", { items: [{ quote: "A merchant-supplied quote without a score", name: "Customer" }] });
    expect(unrated.items).toEqual([expect.objectContaining({ rating: null })]);
    expect(renderSection(storefront, "testimonials", unrated)).not.toContain("noor-stars");
    expect(settingsFor("gallery")).toMatchObject({ heading: "Gallery", handle: null });
    expect(slotSettings("noor_footer")).toMatchObject({ tagline: null, newsletter_text: null, payments: [] });
    const saved = { heading: "Our real promotion", text: "Delivery in five days", eyebrow: "Merchant's collection" };
    expect(settingsFor("featured_product", saved)).toMatchObject(saved);
  });

  it("keeps merchant-authored saved claims and testimonials renderable", () => {
    const saved = [{ id: "lp-reviews", type: "app", version: 1, settings: { app: "scalius.noor/testimonials", values: { heading: "Our customer reviews", items: [{ quote: "A real review supplied by this merchant", name: "Verified customer", rating: 4 }] } } }];
    const before = JSON.stringify(saved);
    expect(readStorefrontPagePresetSections(saved, declared.storefront.pagePresets[0]!.themeVersion!)).toEqual(saved);
    const html = renderSection(storefront, "testimonials", settingsFor("testimonials", saved[0]!.settings.values));
    expect(html).toContain("A real review supplied by this merchant");
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("offers a campaign page preset built from its own landing sections", () => {
    const [preset] = declared.storefront.pagePresets;
    expect(preset?.id).toBe("product_campaign");
    const sections = readStorefrontPagePresetSections(preset!.sections, preset!.themeVersion!);
    expect(sections).not.toBeNull();
    const types = sections!.map((section) => (section.type === "app" ? section.settings.app : section.type));
    for (const type of types) expect(declared.storefront.sections.map((section) => `scalius.noor/${section.type}`)).toContain(type);
    expect(types[0]).toBe("scalius.noor/landing_hero");
    expect(types.at(-1)).toBe("scalius.noor/landing_order");
    // Both ends of the page take the product the merchant picks with the preset.
    for (const type of ["landing_hero", "landing_order"]) {
      expect(declared.storefront.sections.find((section) => section.type === type)!.settings.some((field) => field.type === "product")).toBe(true);
    }
  });
});

describe("Noor chrome", () => {
  it("draws the header with menus, the drawer, search and the cart count", () => {
    const html = shown(renderHeader(storefront, "noor_header", slotSettings("noor_header")));
    expect(html).toContain('class="noor-header is-center"');
    expect(html).toContain('popovertarget="noor-drawer"');
    expect(html).toContain('id="noor-search" popover="auto"');
    expect(html).toContain('name="q"');
    expect(html).toContain("data-cart-open");
    expect(html).toContain("data-scalius-cart-count");
    expect(html).toContain('<scalius-island data-island="header" data-hydrate="idle"');
    // The store's announcement shows when the header names none of its own.
    expect(html).toContain("Free delivery over ৳2,000");
  });

  it("opens full-width panels for menus with groups and dropdowns for flat ones", () => {
    const html = renderHeader(storefront, "noor_header", slotSettings("noor_header"), {
      menu: [
        { title: "Women", url: "/categories/women", children: [{ title: "Sarees", url: "/categories/sarees", children: [{ title: "Jamdani", url: "/categories/jamdani", children: [] }] }] },
        { title: "Shop", url: "/search", children: [{ title: "New", url: "/collections/new", children: [] }] },
        { title: "About", url: "/pages/about", children: [] },
      ],
    });
    expect(html.match(/class="noor-mega"/g)).toHaveLength(1);
    expect(html.match(/class="noor-drop"/g)).toHaveLength(1);
    expect(html).toContain("All Women");
  });

  it("keeps deep merchant links reachable in the mobile drawer and both desktop menu styles", () => {
    const menu = [{ title: "Women", url: "/women", children: [{ title: "Sarees", url: "/sarees", children: [
      { title: "Jamdani", url: "/jamdani", children: [{ title: "Cotton", url: "/cotton-jamdani", children: [] }] },
    ] }] }];
    for (const menu_style of ["simple", "mega"]) {
      const html = shown(renderHeader(storefront, "noor_header", slotSettings("noor_header", { menu_style }), { menu }));
      const drawer = html.slice(html.indexOf('id="noor-drawer"'), html.indexOf('id="noor-search"'));
      expect(drawer).toContain('href="/jamdani"');
      expect(drawer).toContain('href="/cotton-jamdani"');
      const desktop = html.slice(0, html.indexOf('id="noor-drawer"'));
      expect(desktop).toContain('href="/cotton-jamdani"');
    }
  });

  it("rotates its own announcements, the first one showing", () => {
    const html = renderHeader(storefront, "noor_header", slotSettings("noor_header", {
      announcements: [{ text: "Eid delivery until the 28th", link: "/pages/eid" }, { text: "Cash on delivery everywhere", link: null }],
    }));
    expect(html).toContain('<li data-active=""><a href="/pages/eid">Eid delivery until the 28th');
    expect(html).toContain('<li aria-hidden="true" inert><span>Cash on delivery everywhere</span></li>');
  });

  it("sits over the hero only on the homepage", () => {
    const settings = slotSettings("noor_header", { transparent_home: true });
    // The store's hero, drawn by Noor's hero skin.
    const lead = { kind: "core" as const, type: "hero", skin: { id: "noor_hero", settings: slotSettings("noor_hero") } };
    expect(renderHeader(storefront, "noor_header", settings, { page: { lead } })).toContain("is-transparent");
    expect(renderHeader(storefront, "noor_header", settings)).not.toContain("is-transparent");
    expect(renderHeader(storefront, "noor_header", settings, {}, { context: { page: { kind: "product", path: "/products/x" } } })).not.toContain("is-transparent");
  });

  it("keeps solid chrome for non-overlay or unresolved leading sections", () => {
    const settings = slotSettings("noor_header", { transparent_home: true });
    const app = { kind: "app" as const, pluginId: "scalius.noor", type: "slideshow", instanceId: "first" };
    const hero = { kind: "core" as const, type: "hero" };
    const leads = [
      null,
      { kind: "core" as const, type: "product_grid" },
      // The store's own hero, or another skin's, or one Noor draws beside the photo.
      hero,
      { ...hero, skin: { id: "other-hero", settings: slotSettings("noor_hero") } },
      { ...hero, skin: { id: "noor_hero", settings: slotSettings("noor_hero", { layout: "split" }) } },
      { kind: "core" as const, type: "seo_text", skin: { id: "noor_hero", settings: slotSettings("noor_hero") } },
      app,
      { ...app, pluginId: "another.theme", settings: settingsFor("slideshow", { slides: [{ image: "hero" }] }) },
      { ...app, settings: settingsFor("slideshow", { slides: [] }) },
    ];
    for (const lead of leads) expect(renderHeader(storefront, "noor_header", settings, { page: { lead } })).not.toContain("is-transparent");
  });

  it("accepts an image-backed slideshow and declares the actual sticky box", () => {
    const settings = slotSettings("noor_header", { transparent_home: true });
    const lead = { kind: "app" as const, pluginId: "scalius.noor", type: "slideshow", instanceId: "first", settings: settingsFor("slideshow", { slides: [{ image: "wide", phone_image: "phone" }] }) };
    expect(lead.settings.slides).toEqual([expect.objectContaining({ image: image("wide"), phone_image: image("phone") })]);
    const header = renderHeader(storefront, "noor_header", settings, { page: { lead } });
    expect(header).toContain("is-transparent");
    expect(header).toContain('data-sticky-header=""');
    expect(header).toContain('href="/account" data-account-link=""');
    expect(renderHeader(storefront, "noor_header", slotSettings("noor_header", { sticky: false }))).not.toContain("data-sticky-header");
  });

  it("turns into a campaign header and footer on landing pages, unless the merchant keeps the full ones", () => {
    const header = shown(renderHeader(storefront, "noor_header", slotSettings("noor_header"), {}, { context: LANDING }));
    expect(header).toContain("noor-header is-campaign");
    expect(header).not.toContain('href="#order"');
    expect(header).toContain('data-noor-order-link');
    expect(header).toContain('href="/search"');
    expect(header).toContain('data-order-label="Order now"');
    expect(header).not.toContain("noor-nav");
    expect(renderHeader(storefront, "noor_header", slotSettings("noor_header", { landing_header: "full" }), {}, { context: LANDING })).toContain("noor-nav");
    const footer = shown(renderFooter(storefront, "noor_footer", slotSettings("noor_footer"), {}, { context: LANDING }));
    expect(footer).toContain("noor-footer is-campaign");
    expect(footer).not.toContain("noor-footer-main");
  });

  it("draws the footer with contact, menus, social links and payments", () => {
    const html = shown(renderFooter(storefront, "noor_footer", slotSettings("noor_footer", { payments: [{ name: "bKash" }, { name: "Nagad" }] })));
    expect(html).toContain("noor-footer tone-ink");
    expect(html).toContain('href="tel:+8801700000000"');
    expect(html).toContain('href="mailto:hello@acme.example"');
    expect(html).toContain('aria-label="facebook"');
    expect(html).toContain("<li>bKash</li><li>Nagad</li>");
    expect(html).toContain('href="/newsletter"');
  });

  it("draws the card with renditions, the hover photo, the sale badge and quick add", () => {
    const product = fixtureProductCard({ hoverImage: image("back") });
    const html = shown(renderProductCard(storefront, "noor_card", slotSettings("noor_card"), product));
    expect(html).toContain("noor-card ratio-portrait has-hover");
    expect(html).toContain('srcset="https://media.example.com/shirt-480.webp 480w');
    expect(html).toContain("noor-card-img is-alt");
    expect(html).toContain("−20%");
    expect(html).toContain('class="noor-card-bar" href="/products/linen-shirt" data-card-quick-add aria-label="Add Linen shirt to cart"');
  });

  it("writes ratings, review counts and discounts in the page's numbers and plural rules", () => {
    const one = renderProductCard(storefront, "noor_card", slotSettings("noor_card"), { rating: { average: 4.5, count: 1 } });
    expect(one).toContain('aria-label="Rated 4.5 out of 5 from 1 review"');
    const bangla = renderProductCard(storefront, "noor_card", slotSettings("noor_card"), { rating: { average: 4.5, count: 12 } }, {
      context: { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn", timeZone: "Asia/Dhaka" } },
    });
    expect(bangla).toContain("১২টি রিভিউতে ৫-এর মধ্যে ৪.৫");
    expect(bangla).toContain("★ ৪.৫");
    expect(bangla).toContain("−২০%");
  });

  it("says what a card that can't add opens: options to choose, or just the product (a gift card, an e-book)", () => {
    const options = renderProductCard(storefront, "noor_card", slotSettings("noor_card"), { quickAdd: false, needsOptions: true });
    expect(options).toContain('class="noor-card-bar" href="/products/linen-shirt" aria-label="Choose options for Linen shirt"');
    expect(options).toContain("<span>Choose options</span>");
    const page = renderProductCard(storefront, "noor_card", slotSettings("noor_card"), { quickAdd: false, needsOptions: false });
    expect(page).toContain('class="noor-card-bar" href="/products/linen-shirt" aria-label="View Linen shirt"');
    expect(page).toContain("<span>View product</span>");
    expect(page).not.toContain("Add to cart");
    expect(page).not.toContain("data-card-quick-add");
  });

  it("offers no add button on a sold-out card, and a round one when asked", () => {
    const soldOut = renderProductCard(storefront, "noor_card", slotSettings("noor_card"), { soldOut: true, quickAdd: false });
    expect(soldOut).toContain("Sold out");
    expect(soldOut).not.toContain("noor-card-bar");
    expect(renderProductCard(storefront, "noor_card", slotSettings("noor_card", { action: "icon" }))).toContain("noor-card-icon");
  });
});

describe("Noor sections", () => {
  it("draws every section from its defaults (and nothing for one with nothing to show)", () => {
    for (const section of declared.storefront.sections) {
      const html = renderSection(storefront, section.type, settingsFor(section.type));
      if (html) expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
    }
    expect(renderSection(storefront, "slideshow", settingsFor("slideshow"))).toBe("");
    expect(renderSection(storefront, "landing_order", settingsFor("landing_order"))).toBe("");
  });

  it("shells every section in the store's rhythm, its own tone and spacing", () => {
    const items = [{ quote: "Lovely", name: "Customer" }];
    const html = renderSection(storefront, "testimonials", settingsFor("testimonials", { items, tone: "ink", spacing: "l" }));
    expect(html).toContain('<section class="noor-s noor-s-testimonials" data-tone="ink" data-space="l">');
    // An unknown stored value falls back instead of breaking the layout.
    expect(renderSection(storefront, "testimonials", settingsFor("testimonials", { items, spacing: "huge" }))).toContain('data-space="m"');
  });

  it("draws the slideshow's slides, with arrows and dots for its island", () => {
    const html = shown(renderSection(storefront, "slideshow", settingsFor("slideshow", {
      slides: [{ image: "a", heading: "One" }, { image: "b", heading: "Two" }],
    })));
    expect(html).toContain('data-island="slideshow"');
    expect(html.match(/ data-slide[ >]/g)).toHaveLength(2);
    expect(html.match(/data-dot=/g)).toHaveLength(2);
    expect(html).toContain('<h2 class="noor-display">One</h2>');
  });

  it.each(["2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-12-31 24:00", "2026-12-31 23:60", "0050-01-01"])("rejects impossible countdown date %s", (value) => {
    expect(countdownEnd(value, "Asia/Dhaka")).toBeNull();
  });

  it("accepts leap days and preserves the invalid-zone fallback", () => {
    expect(countdownEnd("2028-02-29 12:00", "UTC")).toBe(Date.UTC(2028, 1, 29, 12));
    expect(countdownEnd("2000-02-29 12:00", "UTC")).toBe(Date.UTC(2000, 1, 29, 12));
    expect(countdownEnd("2026-12-31 18:00", "not-a-time-zone")).toBe(Date.UTC(2026, 11, 31, 18));
  });

  it("counts the sale down to the store's local time", () => {
    expect(countdownEnd("2026-12-31 18:00", "Asia/Dhaka")).toBe(Date.UTC(2026, 11, 31, 12, 0));
    expect(countdownEnd("2026-12-31", "Asia/Dhaka")).toBe(Date.UTC(2026, 11, 31, 17, 59, 59));
    expect(countdownEnd("31/12/2026", "Asia/Dhaka")).toBeNull();
  });
});

describe("Noor landing kit", () => {
  const render = (type: string, values: Record<string, unknown> = {}, context = {}) => renderSection(
    storefront, type, settingsFor(type, { product: "prod_1", ...values }), { context: { ...LANDING, ...context } },
  );

  it("opens a campaign page with the product, the offer and every way to order", () => {
    const html = shown(render("landing_hero", {
      photos: [{ image: "front" }], points: [{ text: "Genuine" }], phone: "+880 1711-000000", whatsapp: "8801711000000", ends_at: "2026-12-31",
    }));
    expect(html).toContain('<h1 class="noor-h1">Linen shirt</h1>');
    expect(html).toContain("Save 20%");
    expect(html).toContain('href="/products/linen-shirt" data-noor-order-link');
    expect(html).toContain('href="tel:+8801711000000"');
    expect(html).toContain('href="https://wa.me/8801711000000"');
    expect(html).toContain('data-island="countdown"');
    expect(html).toContain("Genuine");
    expect(html).toContain("Review your order before placing it");
    expect(html).not.toContain("check the product before you pay");
    // The merchant's photos first, then the product's own.
    expect(html.indexOf("front-1200")).toBeLessThan(html.indexOf("shirt-480"));
  });

  it("places the store's order form at its instance anchor, with the phone order bar", () => {
    const html = shown(render("landing_order", { assurances: [{ icon: "truck", text: "2-day delivery" }], max_quantity: 3 }));
    expect(html).toContain('id="noor-order-app-landing_order"');
    // The embed names the product by id, never by a URL a canonical path override can change.
    expect(html).toContain('<scalius-embed kind="order_form" data-product="product:prod_1-1" data-max-quantity="3"></scalius-embed>');
    expect(html).toContain('data-island="landing-bar"');
    expect(html).toContain("2-day delivery");
    expect(html).not.toContain("Cash on delivery: pay when it arrives");
  });

  it("shows only merchant-authored order assurances", () => {
    const empty = shown(render("landing_order", { assurances: [] }));
    expect(empty).not.toContain('class="noor-assure"');
    expect(empty).not.toContain("Cash on delivery");
    const merchant = shown(render("landing_order", { assurances: [{ icon: "cash", text: "COD available in Dhaka" }] }));
    expect(merchant).toContain("COD available in Dhaka");
    expect(merchant.match(/class="noor-assure"/g)).toHaveLength(1);
    const bangla = shown(render("landing_order", { assurances: [] }, { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn", timeZone: "Asia/Dhaka" } }));
    expect(bangla).not.toContain("ক্যাশ অন ডেলিভারি");
  });

  it("keeps repeated order sections and their phone bars on distinct anchors", () => {
    const reply = storefront.render({
      abi: storefront.abi,
      context: fixtureContext(LANDING),
      jobs: ["first", "second"].map((instanceId) => ({
        id: instanceId, kind: "section" as const, type: "landing_order", instanceId,
        settings: settingsFor("landing_order", { product: "prod_1" }),
      })),
    });
    for (const [index, result] of reply.results.entries()) {
      if (!("html" in result)) throw new Error(result.error);
      const id = index === 0 ? "first" : "second";
      expect(shown(result.html)).toContain(`id="noor-order-${id}"`);
      expect(result.html).toContain(`href="#noor-order-${id}"`);
    }
  });

  it("draws features as cards, photo rows or numbered steps", () => {
    const items = [{ title: "Fill in the form" }, { title: "We call to confirm" }];
    expect(shown(render("landing_features", { items, style: "steps" }))).toContain('<span class="noor-step" aria-hidden="true">2</span>');
    expect(shown(render("landing_features", { items, style: "rows" }))).toContain('class="noor-rows"');
    expect(shown(render("landing_features", { items, cta_label: "Order now" }))).toContain('data-noor-order-link hidden');
  });

  it("keeps a sold-out product's order section without a form", () => {
    const html = renderSection(storefront, "landing_order", resolveStorefrontSettings(
      declared.storefront.sections.find((section) => section.type === "landing_order")!.settings,
      { product: "prod_1" },
      { image: () => null, products: () => [fixtureProductCard({ soldOut: true })] },
    ));
    expect(html).toContain("Sold out for now");
    expect(html).not.toContain("scalius-embed");
  });

  it("asks for a product only in the editor's preview", () => {
    const settings = resolveStorefrontSettings(declared.storefront.sections.find((section) => section.type === "landing_hero")!.settings, {}, {
      image: () => null,
      products: () => [],
    });
    expect(renderSection(storefront, "landing_hero", settings)).toBe("");
    expect(renderSection(storefront, "landing_hero", settings, { context: { preview: true } })).toContain("Choose the product");
  });

  it("speaks Bangla on a Bangla store", () => {
    const bangla = { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn" as const, timeZone: "Asia/Dhaka" } };
    expect(render("landing_hero", {}, bangla)).toContain("এখনই অর্ডার করুন");
    expect(render("landing_order", {}, bangla)).toContain("আপনার অর্ডার");
  });
});
