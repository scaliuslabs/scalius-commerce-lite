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
  const slot = declared.storefront.slots.find((entry) => entry.id === id)!;
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
    const sections = declared.storefront.pagePresets.flatMap((preset) => readStorefrontPagePresetSections(preset.sections)!);
    for (const template of declared.storefront.templates) {
      const theme = readStorefrontAppTemplateTheme(template.theme)!;
      sections.push(...(theme.sections ?? []));
      for (const placement of Object.values(theme.apps ?? {})) {
        if (!placement) continue;
        const slot = declared.storefront.slots.find((slot) => `${declared.id}/${slot.id}` === placement.app)!;
        expect(slot, placement.app).toBeDefined();
        validate(placement.app, slot.settings, placement.values);
      }
    }
    for (const section of sections) {
      if (section.type !== "app") continue;
      const declaration = declared.storefront.sections.find((item) => `${declared.id}/${item.type}` === section.settings.app)!;
      expect(declaration, section.settings.app).toBeDefined();
      validate(section.id, declaration.settings, section.settings.values);
    }
    const products = declared.storefront.sections.find((section) => section.type === "products")!;
    const invalid = validatePluginSettingValues(products.settings.filter((field) => field.key === "tab1_products"), { tab1_products: "featured" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors).toEqual([expect.objectContaining({ key: "tab1_products" })]);
  });

  it("is a valid manifest whose module draws every declared component", () => {
    expect(checkPluginHandlers(pluginHandlerInventory(declared), plugin)).toEqual([]);
    const sections = Object.keys(storefront.definition.sections ?? {}).sort();
    expect(sections).toEqual(declared.storefront.sections.map((section) => section.type).sort());
    expect(Object.keys(storefront.definition.slots ?? {}).sort()).toEqual(["noor-card", "noor-footer", "noor-header"]);
    expect(declared.storefront.sections).toHaveLength(20);
  });

  it("asks for nothing but storefront code", () => {
    expect(declared.scopes).toEqual([]);
    expect(declared.allowedHosts).toEqual([]);
    expect(declared.storefront.connect).toEqual([]);
  });

  it("is one template: the look applies to a store's theme as a valid document", () => {
    expect(declared.storefront.templates.map((template) => template.id)).toEqual(["noor"]);
    const theme = readStorefrontAppTemplateTheme(declared.storefront.templates[0]!.theme);
    expect(theme).not.toBeNull();
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, "scalius.noor/noor", theme!);
    const result = storefrontThemeDocumentSchema.safeParse(document);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(document.apps?.header?.app).toBe("scalius.noor/noor-header");
    expect(document.apps?.template).toBe("scalius.noor/noor");
    // The header shows the merchant's own menu, in their order.
    expect(document.blocks.navigation.source).toBe("menu");
    // The merchant's brand and landing pages stay.
    expect(document.brand).toEqual(DEFAULT_STOREFRONT_THEME.brand);
    expect(document.pages.landing).toEqual(DEFAULT_STOREFRONT_THEME.pages.landing);
  });

  it("starts new stores and campaigns with product facts, without invented trust claims", () => {
    const template = readStorefrontAppTemplateTheme(declared.storefront.templates[0]!.theme)!;
    const campaign = readStorefrontPagePresetSections(declared.storefront.pagePresets[0]!.sections)!;
    const sections = [...(template.sections ?? []), ...campaign];
    const trustTypes = ["scalius.noor/testimonials", "scalius.noor/faq", "scalius.noor/promises"];
    for (const section of sections) {
      if (section.type !== "app") throw new Error("Expected app preset section");
      expect(trustTypes).not.toContain(section.settings.app);
      const values = section.settings.values;
      for (const field of ["assurances", "stats", "summary", "urgency", "ends_at"]) expect(values[field]).toBeUndefined();
      const rendered = renderSection(storefront, section.settings.app.slice("scalius.noor/".length), settingsFor(section.settings.app.slice("scalius.noor/".length), values));
      expect(rendered).not.toMatch(/Cash on delivery|two.days|seven.day|40%|1,200\s*(?:happy|customers|reviews|orders)|quality checked|pure cotton|inspect|check the product before/i);
    }
    expect(template.apps?.header?.values.announcements).toEqual([]);
    expect(template.apps?.footer?.values.payments).toEqual([]);
    expect(template.apps?.footer?.values.tagline).toBe("");
    expect(campaign.map((section) => section.id)).toEqual(["lp-hero", "lp-features", "lp-steps", "lp-order"]);
    const appCampaign = campaign.filter((section) => section.type === "app");
    const hero = appCampaign[0]!.settings.values;
    const html = renderSection(storefront, "landing-hero", settingsFor("landing-hero", { ...hero, product: "prod_1" }));
    expect(html).toContain("Linen shirt");
    expect(html).not.toContain("Special offer");
    expect(html).not.toContain("noor-urgency");
    expect(renderSection(storefront, "landing-features", settingsFor("landing-features", appCampaign[1]!.settings.values))).toBe("");
    const order = renderSection(storefront, "landing-order", settingsFor("landing-order", { ...appCampaign.at(-1)!.settings.values, product: "prod_1" }));
    expect(order).toContain("scalius-checkout");
    expect(order).not.toContain("noor-assure");
  });

  it("resolves omitted copy neutrally while preserving explicit merchant values", () => {
    expect(settingsFor("hero")).toMatchObject({ heading: "Explore our products", text: null, eyebrow: null });
    expect(settingsFor("landing-hero")).toMatchObject({ badge: null, urgency: null });
    expect(settingsFor("sale-countdown")).toMatchObject({ heading: null, eyebrow: null });
    expect(renderSection(storefront, "sale-countdown", settingsFor("sale-countdown"))).toBe("");
    expect(settingsFor("testimonials")).toMatchObject({ heading: "Customer reviews", items: [] });
    const unrated = settingsFor("testimonials", { items: [{ quote: "A merchant-supplied quote without a score", name: "Customer" }] });
    expect(unrated.items).toEqual([expect.objectContaining({ rating: null })]);
    expect(renderSection(storefront, "testimonials", unrated)).not.toContain("noor-stars");
    expect(settingsFor("gallery")).toMatchObject({ heading: "Gallery", handle: null });
    expect(slotSettings("noor-footer")).toMatchObject({ tagline: null, newsletter_text: null, payments: [] });
    const saved = { heading: "Our real promotion", text: "Delivery in five days", eyebrow: "Merchant's collection" };
    expect(settingsFor("hero", saved)).toMatchObject(saved);
  });

  it("keeps merchant-authored saved claims and testimonials renderable", () => {
    const saved = [{ id: "lp-reviews", type: "app", version: 1, settings: { app: "scalius.noor/testimonials", values: { heading: "Our customer reviews", items: [{ quote: "A real review supplied by this merchant", name: "Verified customer", rating: 4 }] } } }];
    const before = JSON.stringify(saved);
    expect(readStorefrontPagePresetSections(saved)).toEqual(saved);
    const html = renderSection(storefront, "testimonials", settingsFor("testimonials", saved[0]!.settings.values));
    expect(html).toContain("A real review supplied by this merchant");
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("offers a campaign page preset built from its own landing sections", () => {
    const [preset] = declared.storefront.pagePresets;
    expect(preset?.id).toBe("product-campaign");
    const sections = readStorefrontPagePresetSections(preset!.sections);
    expect(sections).not.toBeNull();
    const types = sections!.map((section) => (section.type === "app" ? section.settings.app : section.type));
    for (const type of types) expect(declared.storefront.sections.map((section) => `scalius.noor/${section.type}`)).toContain(type);
    expect(types[0]).toBe("scalius.noor/landing-hero");
    expect(types.at(-1)).toBe("scalius.noor/landing-order");
    // Both ends of the page take the product the merchant picks with the preset.
    for (const type of ["landing-hero", "landing-order"]) {
      expect(declared.storefront.sections.find((section) => section.type === type)!.settings.some((field) => field.type === "product")).toBe(true);
    }
  });
});

describe("Noor chrome", () => {
  it("draws the header with menus, the drawer, search and the cart count", () => {
    const html = shown(renderHeader(storefront, "noor-header", slotSettings("noor-header")));
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
    const html = renderHeader(storefront, "noor-header", slotSettings("noor-header"), {
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
      const html = shown(renderHeader(storefront, "noor-header", slotSettings("noor-header", { menu_style }), { menu }));
      const drawer = html.slice(html.indexOf('id="noor-drawer"'), html.indexOf('id="noor-search"'));
      expect(drawer).toContain('href="/jamdani"');
      expect(drawer).toContain('href="/cotton-jamdani"');
      const desktop = html.slice(0, html.indexOf('id="noor-drawer"'));
      expect(desktop).toContain('href="/cotton-jamdani"');
    }
  });

  it("rotates its own announcements, the first one showing", () => {
    const html = renderHeader(storefront, "noor-header", slotSettings("noor-header", {
      announcements: [{ text: "Eid delivery until the 28th", link: "/pages/eid" }, { text: "Cash on delivery everywhere", link: null }],
    }));
    expect(html).toContain('<li data-active=""><a href="/pages/eid">Eid delivery until the 28th');
    expect(html).toContain('<li aria-hidden="true" inert><span>Cash on delivery everywhere</span></li>');
  });

  it("sits over the hero only on the homepage", () => {
    const settings = slotSettings("noor-header", { transparent_home: true });
    const lead = { kind: "app" as const, pluginId: "scalius.noor", type: "hero", instanceId: "hero-first", settings: settingsFor("hero", { image: "hero" }) };
    expect(renderHeader(storefront, "noor-header", settings, { page: { lead } })).toContain("is-transparent");
    expect(renderHeader(storefront, "noor-header", settings)).not.toContain("is-transparent");
    expect(renderHeader(storefront, "noor-header", settings, {}, { context: { page: { kind: "product", path: "/products/x" } } })).not.toContain("is-transparent");
  });

  it("keeps solid chrome for non-overlay or unresolved leading sections", () => {
    const settings = slotSettings("noor-header", { transparent_home: true });
    const app = { kind: "app" as const, pluginId: "scalius.noor", type: "hero", instanceId: "first" };
    const leads = [
      null,
      { kind: "core" as const, type: "product-grid" },
      app,
      { ...app, settings: settingsFor("hero") },
      { ...app, settings: settingsFor("hero", { image: "hero", layout: "split" }) },
      { ...app, pluginId: "another.theme", settings: settingsFor("hero", { image: "hero" }) },
      { ...app, type: "slideshow", settings: settingsFor("slideshow", { slides: [] }) },
    ];
    for (const lead of leads) expect(renderHeader(storefront, "noor-header", settings, { page: { lead } })).not.toContain("is-transparent");
  });

  it("accepts an image-backed slideshow and declares the actual sticky box", () => {
    const settings = slotSettings("noor-header", { transparent_home: true });
    const lead = { kind: "app" as const, pluginId: "scalius.noor", type: "slideshow", instanceId: "first", settings: settingsFor("slideshow", { slides: [{ image: "wide", phone_image: "phone" }] }) };
    expect(lead.settings.slides).toEqual([expect.objectContaining({ image: image("wide"), phone_image: image("phone") })]);
    const header = renderHeader(storefront, "noor-header", settings, { page: { lead } });
    expect(header).toContain("is-transparent");
    expect(header).toContain('data-sticky-header=""');
    expect(header).toContain('href="/account" data-account-link=""');
    expect(renderHeader(storefront, "noor-header", slotSettings("noor-header", { sticky: false }))).not.toContain("data-sticky-header");
  });

  it("turns into a campaign header and footer on landing pages, unless the merchant keeps the full ones", () => {
    const header = shown(renderHeader(storefront, "noor-header", slotSettings("noor-header"), {}, { context: LANDING }));
    expect(header).toContain("noor-header is-campaign");
    expect(header).not.toContain('href="#order"');
    expect(header).toContain('data-noor-order-link');
    expect(header).toContain('href="/search"');
    expect(header).toContain('data-order-label="Order now"');
    expect(header).not.toContain("noor-nav");
    expect(renderHeader(storefront, "noor-header", slotSettings("noor-header", { landing_header: "full" }), {}, { context: LANDING })).toContain("noor-nav");
    const footer = shown(renderFooter(storefront, "noor-footer", slotSettings("noor-footer"), {}, { context: LANDING }));
    expect(footer).toContain("noor-footer is-campaign");
    expect(footer).not.toContain("noor-footer-main");
  });

  it("draws the footer with contact, menus, social links and payments", () => {
    const html = shown(renderFooter(storefront, "noor-footer", slotSettings("noor-footer", { payments: [{ name: "bKash" }, { name: "Nagad" }] })));
    expect(html).toContain("noor-footer tone-ink");
    expect(html).toContain('href="tel:+8801700000000"');
    expect(html).toContain('href="mailto:hello@acme.example"');
    expect(html).toContain('aria-label="facebook"');
    expect(html).toContain("<li>bKash</li><li>Nagad</li>");
    expect(html).toContain('href="/newsletter"');
  });

  it("draws the card with renditions, the hover photo, the sale badge and quick add", () => {
    const product = fixtureProductCard({ hoverImage: image("back") });
    const html = shown(renderProductCard(storefront, "noor-card", slotSettings("noor-card"), product));
    expect(html).toContain("noor-card ratio-portrait has-hover");
    expect(html).toContain('srcset="https://media.example.com/shirt-480.webp 480w');
    expect(html).toContain("noor-card-img is-alt");
    expect(html).toContain("−20%");
    expect(html).toContain('class="noor-card-bar" href="/products/linen-shirt" data-card-quick-add aria-label="Add Linen shirt to cart"');
  });

  it("writes ratings, review counts and discounts in the page's numbers and plural rules", () => {
    const one = renderProductCard(storefront, "noor-card", slotSettings("noor-card"), { rating: { average: 4.5, count: 1 } });
    expect(one).toContain('aria-label="Rated 4.5 out of 5 from 1 review"');
    const bangla = renderProductCard(storefront, "noor-card", slotSettings("noor-card"), { rating: { average: 4.5, count: 12 } }, {
      context: { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn", timeZone: "Asia/Dhaka" } },
    });
    expect(bangla).toContain("১২টি রিভিউতে ৫-এর মধ্যে ৪.৫");
    expect(bangla).toContain("★ ৪.৫");
    expect(bangla).toContain("−২০%");
  });

  it("offers no add button on a sold-out card, and a round one when asked", () => {
    const soldOut = renderProductCard(storefront, "noor-card", slotSettings("noor-card"), { soldOut: true, quickAdd: false });
    expect(soldOut).toContain("Sold out");
    expect(soldOut).not.toContain("noor-card-bar");
    expect(renderProductCard(storefront, "noor-card", slotSettings("noor-card", { action: "icon" }))).toContain("noor-card-icon");
  });
});

describe("Noor sections", () => {
  it("draws every section from its defaults (and nothing for one with nothing to show)", () => {
    for (const section of declared.storefront.sections) {
      const html = renderSection(storefront, section.type, settingsFor(section.type));
      if (html) expect(storefrontShown(html, "scalius.noor").dropped).toBe(0);
    }
    expect(renderSection(storefront, "faq", settingsFor("faq"))).toBe("");
    expect(renderSection(storefront, "slideshow", settingsFor("slideshow"))).toBe("");
    expect(renderSection(storefront, "landing-order", settingsFor("landing-order"))).toBe("");
  });

  it("shells every section in the store's rhythm, its own tone and spacing", () => {
    const html = renderSection(storefront, "image-text", settingsFor("image-text", { heading: "Our story", tone: "ink", spacing: "l" }));
    expect(html).toContain('<section class="noor-s noor-s-story" data-tone="ink" data-space="l">');
    // An unknown stored value falls back instead of breaking the layout.
    expect(renderSection(storefront, "image-text", settingsFor("image-text", { heading: "Our story", spacing: "huge" }))).toContain('data-space="m"');
  });

  it("draws one eager hero image with a responsive phone crop", () => {
    const html = shown(renderSection(storefront, "hero", settingsFor("hero", { image: "wide", phone_image: "tall" })));
    expect(html).toContain('loading="eager" fetchpriority="high"');
    expect(html).toContain('<picture><source media="(max-width: 47.99rem)"');
    expect(html).toContain('srcset="https://media.example.com/tall-600.webp 600w, https://media.example.com/tall-1200.webp 1200w"');
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toContain('href="/search"');
    expect(shown(renderSection(storefront, "hero", settingsFor("hero", { image: "wide", layout: "split" })))).toContain("noor-hero is-split");
  });

  it("draws product tabs as radios with one panel each", () => {
    const html = shown(renderSection(storefront, "products", settingsFor("products", {
      tab1_label: "New in", tab2_label: "On sale", tab2_products: "on-sale", tab3_label: "Popular", tab3_products: "popular",
    })));
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/class="noor-tabpanel"/g)).toHaveLength(3);
    expect(html.match(/<article class="noor-card /g)).toHaveLength(6);
  });

  it("draws a scrolling row with its rail island", () => {
    const html = shown(renderSection(storefront, "products", settingsFor("products", { layout: "row" })));
    expect(html).toContain('data-island="rail"');
    expect(html).toContain('class="noor-products is-row" data-track');
  });

  it("draws the questions with FAQPage structured data that survives the output check", () => {
    const html = shown(renderSection(storefront, "faq", settingsFor("faq", {
      questions: [{ question: "Delivery?", answer: "Two days <fast>." }, { question: "COD?", answer: "Yes." }],
    })));
    const json = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(json["@type"]).toBe("FAQPage");
    expect(json.mainEntity[0].acceptedAnswer.text).toBe("Two days <fast>.");
    expect(html).toContain("Two days &lt;fast&gt;.");
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
    expect(shown(renderSection(storefront, "sale-countdown", settingsFor("sale-countdown", { heading: "Sale ends", ends_at: "2026-02-31" })))).not.toContain('data-island="countdown"');
  });

  it("counts the sale down to the store's local time", () => {
    expect(countdownEnd("2026-12-31 18:00", "Asia/Dhaka")).toBe(Date.UTC(2026, 11, 31, 12, 0));
    expect(countdownEnd("2026-12-31", "Asia/Dhaka")).toBe(Date.UTC(2026, 11, 31, 17, 59, 59));
    expect(countdownEnd("31/12/2026", "Asia/Dhaka")).toBeNull();
    const html = renderSection(storefront, "sale-countdown", settingsFor("sale-countdown", { heading: "Sale ends", ends_at: "2026-12-31 18:00" }));
    expect(html).toContain(`data-props="{&quot;end&quot;:${Date.UTC(2026, 11, 31, 12, 0)}}"`);
  });
});

describe("Noor landing kit", () => {
  const render = (type: string, values: Record<string, unknown> = {}, context = {}) => renderSection(
    storefront, type, settingsFor(type, { product: "prod_1", ...values }), { context: { ...LANDING, ...context } },
  );

  it("opens a campaign page with the product, the offer and every way to order", () => {
    const html = shown(render("landing-hero", {
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
    const html = shown(render("landing-order", { assurances: [{ icon: "truck", text: "2-day delivery" }], max_quantity: 3 }));
    expect(html).toContain('id="noor-order-app-landing-order"');
    // The embed names the product by id, never by a URL a canonical path override can change.
    expect(html).toContain('<scalius-checkout data-product="product:prod_1-1" data-max-quantity="3"></scalius-checkout>');
    expect(html).toContain('data-island="landing-bar"');
    expect(html).toContain("2-day delivery");
    expect(html).not.toContain("Cash on delivery: pay when it arrives");
  });

  it("shows only merchant-authored order assurances", () => {
    const empty = shown(render("landing-order", { assurances: [] }));
    expect(empty).not.toContain('class="noor-assure"');
    expect(empty).not.toContain("Cash on delivery");
    const merchant = shown(render("landing-order", { assurances: [{ icon: "cash", text: "COD available in Dhaka" }] }));
    expect(merchant).toContain("COD available in Dhaka");
    expect(merchant.match(/class="noor-assure"/g)).toHaveLength(1);
    const bangla = shown(render("landing-order", { assurances: [] }, { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn", timeZone: "Asia/Dhaka" } }));
    expect(bangla).not.toContain("ক্যাশ অন ডেলিভারি");
  });

  it("keeps repeated order sections and their phone bars on distinct anchors", () => {
    const reply = storefront.render({
      abi: storefront.abi,
      context: fixtureContext(LANDING),
      jobs: ["first", "second"].map((instanceId) => ({
        id: instanceId, kind: "section" as const, type: "landing-order", instanceId,
        settings: settingsFor("landing-order", { product: "prod_1" }),
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
    expect(shown(render("landing-features", { items, style: "steps" }))).toContain('<span class="noor-step" aria-hidden="true">2</span>');
    expect(shown(render("landing-features", { items, style: "rows" }))).toContain('class="noor-rows"');
    expect(shown(render("landing-features", { items, cta_label: "Order now" }))).toContain('data-noor-order-link hidden');
  });

  it("keeps a sold-out product's order section without a form", () => {
    const html = renderSection(storefront, "landing-order", resolveStorefrontSettings(
      declared.storefront.sections.find((section) => section.type === "landing-order")!.settings,
      { product: "prod_1" },
      { image: () => null, products: () => [fixtureProductCard({ soldOut: true })] },
    ));
    expect(html).toContain("Sold out for now");
    expect(html).not.toContain("scalius-checkout");
  });

  it("asks for a product only in the editor's preview", () => {
    const settings = resolveStorefrontSettings(declared.storefront.sections.find((section) => section.type === "landing-hero")!.settings, {}, {
      image: () => null,
      products: () => [],
    });
    expect(renderSection(storefront, "landing-hero", settings)).toBe("");
    expect(renderSection(storefront, "landing-hero", settings, { context: { preview: true } })).toContain("Choose the product");
  });

  it("speaks Bangla on a Bangla store", () => {
    const bangla = { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn" as const, timeZone: "Asia/Dhaka" } };
    expect(render("landing-hero", {}, bangla)).toContain("এখনই অর্ডার করুন");
    expect(render("landing-order", {}, bangla)).toContain("আপনার অর্ডার");
  });
});
