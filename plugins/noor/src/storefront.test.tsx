import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { checkPluginHandlers, pluginHandlerInventory, resolveStorefrontSettings } from "@scalius/shared/plugins";
import { sanitizeStorefrontHtml } from "@scalius/shared/plugins/storefront-html";
import {
  DEFAULT_STOREFRONT_THEME,
  applyStorefrontAppTemplate,
  readStorefrontAppTemplateTheme,
  storefrontThemeDocumentSchema,
} from "@scalius/shared/storefront-theme";
import {
  fixtureProductCard,
  renderFooter,
  renderHeader,
  renderProductCard,
  renderSection,
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
  const result = sanitizeStorefrontHtml(html);
  expect(result.dropped).toBe(0);
  return result.html;
}

describe("Noor manifest", () => {
  it("is a valid manifest whose module draws every declared component", () => {
    expect(checkPluginHandlers(pluginHandlerInventory(declared), plugin)).toEqual([]);
    const sections = Object.keys(storefront.definition.sections ?? {}).sort();
    expect(sections).toEqual(declared.storefront.sections.map((section) => section.type).sort());
    expect(Object.keys(storefront.definition.slots ?? {}).sort()).toEqual(["noor-card", "noor-footer", "noor-header"]);
    expect(declared.storefront.sections).toHaveLength(15);
  });

  it("asks for nothing but storefront code", () => {
    expect(declared.permissions).toEqual([]);
    expect(declared.allowedHosts).toEqual([]);
    expect(declared.storefront.connect).toEqual([]);
  });

  it.each(declared.storefront.templates.map((template) => [template.id, template] as const))("template %s applies to a store's theme as a valid document", (_id, template) => {
    const theme = readStorefrontAppTemplateTheme(template.theme);
    expect(theme).not.toBeNull();
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, `scalius.noor/${template.id}`, theme!);
    const result = storefrontThemeDocumentSchema.safeParse(document);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(document.apps?.header?.app).toBe("scalius.noor/noor-header");
    expect(document.apps?.template).toBe(`scalius.noor/${template.id}`);
    // The merchant's brand and pages stay.
    expect(document.brand).toEqual(DEFAULT_STOREFRONT_THEME.brand);
    expect(document.pages.landing).toEqual(DEFAULT_STOREFRONT_THEME.pages.landing);
  });
});

describe("Noor chrome", () => {
  it("draws the header with mega menus, the drawer, search and the cart count", () => {
    const html = shown(renderHeader(storefront, "noor-header", slotSettings("noor-header")));
    expect(html).toContain('class="noor-header layout-split"');
    expect(html).toContain('<div class="noor-mega">');
    expect(html).toContain('popovertarget="noor-drawer"');
    expect(html).toContain('id="noor-search" popover="auto"');
    expect(html).toContain('name="q"');
    expect(html).toContain("data-cart-open");
    expect(html).toContain("data-scalius-cart-count");
    expect(html).toContain('<scalius-island data-island="header" data-hydrate="load"');
    // The store's announcement shows when the header names none of its own.
    expect(html).toContain("Free delivery over ৳2,000");
  });

  it("rotates its own announcements, the first one showing", () => {
    const html = renderHeader(storefront, "noor-header", slotSettings("noor-header", {
      announcements: [{ text: "Eid delivery until the 28th", link: "/pages/eid" }, { text: "Cash on delivery everywhere", link: null }],
    }));
    expect(html).toContain('<li class="noor-announce-item" data-active=""><a href="/pages/eid">Eid delivery until the 28th</a></li>');
    expect(html).toContain('<li class="noor-announce-item" aria-hidden="true">Cash on delivery everywhere</li>');
  });

  it("overlays the homepage hero only on the homepage", () => {
    const settings = slotSettings("noor-header", { overlay_home: true });
    expect(renderHeader(storefront, "noor-header", settings)).toContain("is-overlay");
    expect(renderHeader(storefront, "noor-header", settings, {}, { context: { page: { kind: "product", path: "/products/x" } } })).not.toContain("is-overlay");
  });

  it("draws the footer with contact, menus, social links and payments", () => {
    const html = shown(renderFooter(storefront, "noor-footer", slotSettings("noor-footer", { payments: [{ name: "bKash" }, { name: "Nagad" }] })));
    expect(html).toContain("noor-footer tone-dark");
    expect(html).toContain('href="tel:+8801700000000"');
    expect(html).toContain('href="mailto:hello@acme.example"');
    expect(html).toContain('aria-label="facebook"');
    expect(html).toContain('<li>bKash</li><li>Nagad</li>');
    expect(html).toContain('href="/newsletter"');
  });

  it("draws the card with renditions, the hover photo, the sale badge and quick add", () => {
    const product = fixtureProductCard({ hoverImage: image("back") });
    const html = shown(renderProductCard(storefront, "noor-card", slotSettings("noor-card"), product));
    expect(html).toContain("noor-card ratio-portrait has-hover");
    expect(html).toContain('srcset="https://media.example.com/shirt-480.webp 480w');
    expect(html).toContain("noor-card-img is-alt");
    expect(html).toContain("−20%");
    expect(html).toContain('href="/products/linen-shirt" data-card-quick-add aria-label="Add Linen shirt to cart"');
  });

  it("offers no add button on a sold-out card", () => {
    const html = renderProductCard(storefront, "noor-card", slotSettings("noor-card"), { soldOut: true, quickAdd: false });
    expect(html).toContain("Sold out");
    expect(html).not.toContain("noor-card-quick");
  });
});

describe("Noor sections", () => {
  it("draws every section from its defaults (and nothing for one with nothing to show)", () => {
    for (const section of declared.storefront.sections) {
      expect(() => renderSection(storefront, section.type, settingsFor(section.type))).not.toThrow();
    }
    expect(renderSection(storefront, "faq", settingsFor("faq"))).toBe("");
    expect(renderSection(storefront, "hero-slideshow", settingsFor("hero-slideshow"))).toBe("");
  });

  it("draws the editorial hero with its image eager, buttons and the sticker", () => {
    const html = shown(renderSection(storefront, "hero-editorial", settingsFor("hero-editorial", { image: "hero", sticker: "Free delivery" })));
    expect(html).toContain("<h1");
    expect(html).toContain('loading="eager" fetchpriority="high"');
    expect(html).toContain('href="/search"');
    expect(html).toContain("<textPath");
  });

  it("draws three product tabs as radios with one panel each", () => {
    const html = shown(renderSection(storefront, "product-showcase", settingsFor("product-showcase", { tab3_label: "Popular", tab3_products: "popular" })));
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/class="noor-tabpanel"/g)).toHaveLength(3);
    expect(html.match(/class="noor-card /g)).toHaveLength(6);
  });

  it("draws the questions with FAQPage structured data that survives the output check", () => {
    const html = shown(renderSection(storefront, "faq", settingsFor("faq", {
      questions: [{ question: "Delivery?", answer: "Two days <fast>." }, { question: "COD?", answer: "Yes." }],
    })));
    expect(html).toContain('<script type="application/ld+json">');
    const json = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(json["@type"]).toBe("FAQPage");
    expect(json.mainEntity[0].acceptedAnswer.text).toBe("Two days <fast>.");
    expect(html).toContain("Two days &lt;fast&gt;.");
  });

  it("draws the slideshow's slides, with arrows and dots for its island", () => {
    const html = shown(renderSection(storefront, "hero-slideshow", settingsFor("hero-slideshow", {
      slides: [{ image: "a", heading: "One" }, { image: "b", heading: "Two" }],
    })));
    expect(html).toContain('data-island="slideshow"');
    expect(html.match(/ data-slide[ >]/g)).toHaveLength(2);
    expect(html.match(/data-dot=/g)).toHaveLength(2);
    expect(html).toContain("<h1 class=\"noor-display\">One</h1>");
    expect(html).toContain("<h2 class=\"noor-display\">Two</h2>");
  });

  it("counts the sale down to the store's local time", () => {
    expect(countdownEnd("2026-12-31 18:00", "Asia/Dhaka")).toBe(Date.UTC(2026, 11, 31, 12, 0));
    expect(countdownEnd("2026-12-31", "Asia/Dhaka")).toBe(Date.UTC(2026, 11, 31, 17, 59, 59));
    expect(countdownEnd("31/12/2026", "Asia/Dhaka")).toBeNull();
    const html = renderSection(storefront, "promo-countdown", settingsFor("promo-countdown", { ends_at: "2026-12-31 18:00" }));
    expect(html).toContain(`data-props="{&quot;end&quot;:${Date.UTC(2026, 11, 31, 12, 0)}}"`);
  });
});

describe("Noor order landing", () => {
  const landing = (values: Record<string, unknown> = {}, preview = false) => renderSection(
    storefront,
    "order-landing",
    settingsFor("order-landing", { product: "prod_1", ...values }),
    { context: { preview, page: { kind: "landing", path: "/pages/offer" } } },
  );

  it("places the store's order form for the picked product, with the order bar", () => {
    const html = shown(landing({ benefits: [{ text: "Genuine" }], badges: [{ icon: "truck", text: "2-day delivery" }], max_quantity: 3 }));
    expect(html).toContain('<scalius-checkout data-product="linen-shirt" data-max-quantity="3"></scalius-checkout>');
    expect(html).toContain('href="#order-app-order-landing"');
    expect(html).toContain('id="order-app-order-landing"');
    expect(html).toContain('data-island="landing-bar"');
    expect(html).toContain("Genuine");
    expect(html).toContain("2-day delivery");
    expect(html).toContain("Pay cash on delivery");
  });

  it("keeps a sold-out product's landing without a form", () => {
    const html = renderSection(storefront, "order-landing", resolveStorefrontSettings(
      declared.storefront.sections.find((section) => section.type === "order-landing")!.settings,
      { product: "prod_1" },
      { image: () => null, products: () => [fixtureProductCard({ soldOut: true })] },
    ));
    expect(html).toContain("Sold out for now");
    expect(html).not.toContain("scalius-checkout");
  });

  it("asks for a product only in the editor's preview", () => {
    const settings = resolveStorefrontSettings(declared.storefront.sections.find((section) => section.type === "order-landing")!.settings, {}, {
      image: () => null,
      products: () => [],
    });
    expect(renderSection(storefront, "order-landing", settings)).toBe("");
    expect(renderSection(storefront, "order-landing", settings, { context: { preview: true } })).toContain("Choose the product");
  });

  it("speaks Bangla on a Bangla store", () => {
    const html = renderSection(storefront, "order-landing", settingsFor("order-landing", { product: "prod_1" }), {
      context: { store: { name: "দোকান", currency: "BDT", locale: "bn-BD", language: "bn", timeZone: "Asia/Dhaka" } },
    });
    expect(html).toContain("এখনই অর্ডার করুন");
    expect(html).toContain("পণ্য হাতে পেয়ে মূল্য পরিশোধ");
  });
});
