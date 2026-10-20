// Volt Gadgets: a gadget-store theme as an app, a replica of a large
// Bangladeshi electronics retailer's storefront under its own name and logo
// (RESEARCH.md). The theme part has no backend: a header with a category
// mega menu, a footer, a card, a product page with a specification table, a
// listing, skins of the store's own home sections, three sections and a
// template. The `demo_content` feature adds a removable demo store: an admin
// page imports it (categories, brands, products, collections, files) from
// the separate content pack in demo-pack/ in bounded slices, records each
// created item in the app's Objects and removes exactly those again.

import { adminContext, definePlugin, PLUGIN_API_VERSION, ui, type PluginManifestInput } from "@scalius/plugin-sdk";
import { VOLT_DEMO_PACK } from "../demo-pack";
import { demoPage } from "./demo/page";
import { importSlice, readJob, removeSlice } from "./demo/run";

type Storefront = NonNullable<PluginManifestInput["storefront"]>;
type Section = NonNullable<Storefront["sections"]>[number];
type Skin = NonNullable<Storefront["skins"]>[number];
type Template = NonNullable<Storefront["templates"]>[number];
type Field = NonNullable<Section["settings"]>[number];

const ICONS = ["card", "truck", "swap", "tag", "headset", "shield", "gift", "clock", "check", "phone", "chat"]
  .map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));
const LINK_ICONS = ["gift", "clock", "blog", "compare", "tag", "pin", "phone", "chat", "headset"]
  .map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));

const productsSkin = (columns: number): Field[] => [
  { key: "subtitle", label: "Line under the title", type: "text", maxLength: 120 },
  { key: "link_label", label: "Link text", type: "text", maxLength: 40, help: "Shows a link to the products' own listing." },
  { key: "columns", label: "Cards across on computers", type: "number", default: columns, min: 2, max: 6, integer: true },
];

const sections = [
  {
    type: "trust_strip",
    name: "Trust strip",
    description: "A row of up to six promises with icons: EMI, delivery, exchange, best price, after-sales service.",
    settings: [
      {
        key: "items", label: "Promises", type: "list", itemLabel: "Promise", min: 1, max: 6,
        fields: [
          { key: "icon", label: "Icon", type: "select", default: "check", options: ICONS },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 40 },
          { key: "detail", label: "Detail", type: "text", maxLength: 80 },
        ],
      },
    ],
  },
  {
    type: "offer_cards",
    name: "Offer cards",
    description: "The offers page: a grid of campaign cards, each a banner, a title, a line and a link.",
    settings: [
      { key: "heading", label: "Heading", type: "text", default: "Offers", maxLength: 80 },
      { key: "subtitle", label: "Line under the heading", type: "text", maxLength: 160 },
      { key: "columns", label: "Cards across on computers", type: "number", default: 3, min: 1, max: 4, integer: true },
      {
        key: "offers", label: "Offers", type: "list", itemLabel: "Offer", max: 12,
        fields: [
          { key: "image", label: "Banner", type: "image" },
          { key: "title", label: "Title", type: "text", maxLength: 80 },
          { key: "text", label: "Text", type: "text", maxLength: 160 },
          { key: "badge", label: "Badge", type: "text", maxLength: 24 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
    ],
  },
  {
    type: "promo_banner",
    name: "Wide banner",
    description: "One full-width promo image with a link, with an optional phone image.",
    settings: [
      { key: "image", label: "Image", type: "image", required: true },
      { key: "phone_image", label: "Image on phones", type: "image" },
      { key: "alt", label: "What the image shows", type: "text", maxLength: 160 },
      { key: "link", label: "Link", type: "link" },
    ],
  },
] satisfies Section[];

const skins = [
  {
    id: "volt_header",
    target: "header",
    name: "Volt header",
    description: "Logo, a wide search, quick links with icons, cart and account; a category bar with mega menus; a phone drawer and bottom bar.",
    settings: [
      {
        key: "menu_source", label: "Category bar", type: "select", default: "categories",
        options: [{ value: "categories", label: "The category tree" }, { value: "menu", label: "The header menu" }],
      },
      { key: "search_placeholder", label: "Search placeholder", type: "text", maxLength: 60 },
      {
        key: "quick_links", label: "Quick links", type: "list", itemLabel: "Link", max: 5,
        help: "Beside the search on computers. Empty: Offers, Pre-order and Blog.",
        fields: [
          { key: "label", label: "Text", type: "text", required: true, maxLength: 24 },
          { key: "link", label: "Link", type: "link", required: true },
          { key: "icon", label: "Icon", type: "select", default: "gift", options: LINK_ICONS },
        ],
      },
      {
        key: "mega_promos", label: "Mega menu photos", type: "list", itemLabel: "Photo", max: 12,
        help: "A photo beside a category's panel, by the category's name. Use the address of a file in Files.",
        fields: [
          { key: "menu", label: "Category name", type: "text", required: true, maxLength: 60 },
          { key: "image_url", label: "Photo address", type: "url", required: true },
          { key: "alt", label: "What the photo shows", type: "text", maxLength: 120 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
      { key: "offer_link", label: "Offer link (phone bottom bar)", type: "link", default: "/offers" },
      { key: "bottom_bar", label: "Bottom bar on phones", type: "boolean", default: true, help: "Hidden when the theme draws its own tab bar." },
      { key: "sticky", label: "Stay on screen while scrolling", type: "boolean", default: true },
    ],
  },
  {
    id: "volt_footer",
    target: "footer",
    name: "Volt footer",
    description: "A dark footer: contact and app badges, outlets, the footer menus as columns, social icons and a WhatsApp chat button.",
    settings: [
      { key: "hotline_label", label: "Phone label", type: "text", default: "Hotline", maxLength: 30 },
      { key: "outlets_heading", label: "Outlets heading", type: "text", default: "Find our store", maxLength: 40 },
      {
        key: "outlets", label: "Outlets", type: "list", itemLabel: "Outlet", max: 6,
        fields: [
          { key: "name", label: "Name", type: "text", required: true, maxLength: 60 },
          { key: "address", label: "Address", type: "text", maxLength: 160 },
        ],
      },
      { key: "outlets_link", label: "All outlets link", type: "link" },
      { key: "app_store_url", label: "App Store link", type: "url" },
      { key: "play_store_url", label: "Google Play link", type: "url" },
      { key: "whatsapp", label: "WhatsApp number for live chat", type: "text", maxLength: 20, help: "With the country code, such as 8801XXXXXXXXX." },
      { key: "chat_label", label: "Chat button text", type: "text", default: "Live chat", maxLength: 24 },
      { key: "copyright", label: "Copyright line", type: "text", maxLength: 160, help: "Empty: © year and the store's name." },
    ],
  },
  {
    id: "volt_card",
    target: "product-card",
    name: "Volt card",
    description: "A square photo with the amount saved, two lines of name and the price beside the regular price.",
    settings: [
      {
        key: "button", label: "Button under the price", type: "select", default: "none",
        options: [{ value: "none", label: "None" }, { value: "shop", label: "Shop Now" }, { value: "cart", label: "Add to Cart" }],
      },
    ],
  },
  {
    id: "volt_product",
    target: "product-main",
    name: "Volt product page",
    description: "Gallery beside price chips, key features and the store's buy form; a tab bar over the specification table, description, warranty and reviews.",
    settings: [
      { key: "emi_text", label: "EMI line", type: "text", default: "EMI available", maxLength: 80 },
      { key: "emi_link", label: "EMI plans link", type: "link" },
      { key: "delivery_text", label: "Delivery line", type: "text", default: "Delivery timescale: 3-5 days", maxLength: 80 },
      { key: "warranty_text", label: "Warranty text", type: "textarea", maxLength: 1200 },
      { key: "warranty_link", label: "Warranty policy link", type: "link" },
      { key: "whatsapp", label: "WhatsApp number for questions", type: "text", maxLength: 20 },
      { key: "show_related", label: "Related products", type: "boolean", default: true },
    ],
  },
  {
    id: "volt_listing",
    target: "listing-main",
    name: "Volt listing",
    description: "Filters in a sidebar, the title with its item count, sort above a grid of cards, numbered pages.",
    settings: [
      { key: "columns", label: "Cards across on computers", type: "number", default: 4, min: 2, max: 5, integer: true },
      { key: "title_suffix", label: "Words after a category's name", type: "text", maxLength: 40, help: "Such as “Price in Bangladesh”." },
      {
        key: "card_button", label: "Card button", type: "select", default: "shop",
        options: [{ value: "shop", label: "Shop Now" }, { value: "cart", label: "Add to Cart" }, { value: "none", label: "None" }],
      },
    ],
  },
  {
    id: "volt_hero",
    target: "section:hero",
    name: "Volt slider",
    description: "The slides as a slider with dots and arrows; with the contained layout, the two side banners stacked beside it.",
    settings: [
      { key: "autoplay", label: "Play automatically", type: "boolean", default: true },
      { key: "interval", label: "Seconds per slide", type: "number", default: 5, min: 3, max: 12, integer: true },
    ],
  },
  { id: "volt_usp", target: "section:usp-strip", name: "Volt trust strip", description: "The store's facts or your points as icon cards in a row.", settings: [] },
  {
    id: "volt_categories",
    target: "section:category-tiles",
    name: "Volt featured categories",
    description: "Small category tiles in a dense grid under a centred title, with a See All button.",
    settings: [
      { key: "subtitle", label: "Line under the title", type: "text", default: "Get your desired product from featured category!", maxLength: 120 },
      { key: "all_label", label: "Button text", type: "text", default: "See All Categories", maxLength: 40 },
      { key: "all_link", label: "Button link", type: "link", default: "/categories" },
    ],
  },
  { id: "volt_tabs", target: "section:product-tabs", name: "Volt product tabs", description: "The title with pill tabs beside it over a grid of cards.", settings: productsSkin(5) },
  { id: "volt_grid", target: "section:product-grid", name: "Volt product grid", description: "A titled grid of cards.", settings: productsSkin(5).slice(0, 2) },
  { id: "volt_rail", target: "section:product-rail", name: "Volt product row", description: "A titled scrolling row of cards.", settings: productsSkin(5) },
  { id: "volt_deals", target: "section:deal-block", name: "Volt deals", description: "A titled row of deals with the section's banner beside it.", settings: productsSkin(4) },
  { id: "volt_brands", target: "section:brand-wall", name: "Volt brands", description: "Brand logos on white tiles.", settings: [] },
  { id: "volt_banners", target: "section:banner-mosaic", name: "Volt banner row", description: "Up to three banners side by side.", settings: [] },
  { id: "volt_about", target: "section:seo-text", name: "Volt store text", description: "The long store text on a white panel; lines starting with # are headings.", settings: [] },
] satisfies Skin[];

/** The source store's look: a light grey page, white panels, an orange accent, system sans type, 8px corners. */
const tokens = {
  colors: {
    background: "#f2f4f8", foreground: "#1d1d1f",
    card: "#ffffff", "card-foreground": "#1d1d1f",
    popover: "#ffffff", "popover-foreground": "#1d1d1f",
    primary: "#f26522", "primary-foreground": "#ffffff",
    secondary: "#eef1f6", "secondary-foreground": "#1d1d1f",
    muted: "#eef1f6", "muted-foreground": "#565e6c",
    accent: "#fff1e8", "accent-foreground": "#9a3412",
    destructive: "#b91c1c", "destructive-foreground": "#ffffff",
    border: "#e5e7eb", input: "#d1d5db", ring: "#f26522",
  },
  typography: "retail",
  typeScale: "retail",
  headingCase: "sentence",
  density: "compact",
  radius: "rounded",
  buttonShape: "radius",
  surface: "flat",
  imageRatio: "square",
  imageFit: "contain",
  headerTone: "light",
  container: "1360",
};

const skinned = (id: string, type: string, settings: Record<string, unknown>, skin: string, values: Record<string, unknown> = {}) => ({
  id, type, version: 1, settings, skin: { app: `scalius.volt/${skin}`, values },
});
const app = (id: string, type: string, values: Record<string, unknown> = {}) => ({
  id, type: "app", version: 1, settings: { app: `scalius.volt/${type}`, values },
});

// A starting layout in the source store's order. Product sources are generic
// until the merchant (or the demo page's list) points each tab at a
// collection or category: a template cannot name store ids.
const templates = [
  {
    id: "volt",
    name: "Volt Gadgets",
    description: "A gadget and electronics store: a slider with side banners, a trust strip, featured categories, product tabs, deals, brands and the store text.",
    themeVersion: 11,
    theme: {
      tokens,
      blocks: { navigation: { source: "tree+menu", maxTopItems: 12, linkBudget: 150 } },
      apps: {
        skins: {
          header: { app: "scalius.volt/volt_header", values: {} },
          footer: { app: "scalius.volt/volt_footer", values: {} },
          "product-card": { app: "scalius.volt/volt_card", values: {} },
          "product-main": { app: "scalius.volt/volt_product", values: {} },
          "listing-main": { app: "scalius.volt/volt_listing", values: {} },
        },
      },
      sections: [
        skinned("volt-hero", "hero", { layout: "contained-banners", slides: [], sideBanners: [] }, "volt_hero"),
        app("volt-trust", "trust_strip", {
          items: [
            { icon: "card", title: "36 Months EMI", detail: "On credit cards" },
            { icon: "truck", title: "Fastest Home Delivery", detail: "Across the country" },
            { icon: "swap", title: "Exchange Facility", detail: "Old for new" },
            { icon: "tag", title: "Best Price Deals", detail: "Every day" },
            { icon: "headset", title: "After-Sales Service", detail: "We are here to help" },
          ],
        }),
        skinned("volt-categories", "category-tiles", { style: "round-small", title: "Featured Category", categoryIds: [] }, "volt_categories"),
        skinned("volt-computers", "product-tabs", {
          title: "Volt Computers",
          tabs: [{ label: "Special PC", source: { kind: "newest" } }, { label: "On sale", source: { kind: "on-sale" } }],
          limit: 10,
        }, "volt_tabs", { columns: 5 }),
        skinned("volt-apple", "product-rail", { title: "Apple Exclusive 2026", source: { kind: "popular" }, limit: 12 }, "volt_rail", { link_label: "View all" }),
        skinned("volt-appliances", "product-tabs", {
          title: "Home Appliances",
          tabs: [{ label: "Hot Deals", source: { kind: "on-sale" } }, { label: "New", source: { kind: "newest" } }],
          limit: 10,
        }, "volt_tabs", { columns: 5 }),
        skinned("volt-deals", "product-grid", { title: "Exclusive Deals", source: { kind: "on-sale" }, columns: 5, rows: 3 }, "volt_grid"),
        skinned("volt-featured", "product-tabs", {
          title: "Featured Products",
          tabs: [{ label: "Earbuds", source: { kind: "popular" } }, { label: "New", source: { kind: "newest" } }],
          limit: 10,
        }, "volt_tabs", { columns: 5 }),
        skinned("volt-brands", "brand-wall", { title: "Top Brands", style: "grid" }, "volt_brands"),
        skinned("volt-about", "seo-text", { heading: "", body: "" }, "volt_about"),
      ],
    },
  },
] satisfies Template[];

export const manifest = {
  id: "scalius.volt",
  name: "Volt Gadgets",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A gadget and electronics storefront: a search-first header with a category mega menu, offer pills on every card, a product page with a specification table, a filter-sidebar listing, and a one-click demo store you can remove again.",
  tagline: "An electronics store theme with a removable demo store",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  categories: ["store-design", "content"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/volt",
  translations: {
    bn: {
      name: "ভোল্ট গ্যাজেটস",
      tagline: "সরানো যায় এমন ডেমো স্টোরসহ একটি ইলেকট্রনিক্স স্টোর থিম",
      description: "একটি গ্যাজেট ও ইলেকট্রনিক্স স্টোরফ্রন্ট: ক্যাটাগরি মেগা মেনুসহ সার্চ-প্রধান হেডার, প্রতিটি কার্ডে ছাড়ের পরিমাণ, স্পেসিফিকেশন টেবিলসহ পণ্যের পেজ, ফিল্টার সাইডবারসহ তালিকা এবং এক ক্লিকে ডেমো স্টোর।",
      pages: { demo: "ডেমো স্টোর" },
      features: { demo_content: { name: "ডেমো স্টোর", description: "এক ক্লিকে একটি সম্পূর্ণ ডেমো স্টোর ইমপোর্ট করুন এবং পরে সরিয়ে ফেলুন।" } },
    },
  },
  customFields: [
    { ownerType: "product", key: "specs", name: "Specifications", type: "json", description: "Groups of label and value rows for the product page's specification table.", storefrontVisible: true },
    { ownerType: "product", key: "key_features", name: "Key features", type: "list.single_line_text", storefrontVisible: true },
    { ownerType: "product", key: "product_code", name: "Product code", type: "single_line_text", storefrontVisible: true },
  ],
  objects: {
    demo_items: {
      name: "Demo items",
      fields: [
        { key: "kind", name: "Kind", type: "single_line_text" },
        { key: "key", name: "Pack key", type: "single_line_text" },
        { key: "resource_id", name: "Resource", type: "single_line_text" },
        { key: "revision", name: "Revision at import", type: "integer" },
        { key: "url", name: "File address", type: "single_line_text" },
        { key: "filename", name: "File name", type: "single_line_text" },
        { key: "size", name: "File size", type: "integer" },
        { key: "created_at", name: "File created", type: "single_line_text" },
        { key: "depth", name: "Category depth", type: "integer" },
      ],
      indexes: ["kind"],
    },
  },
  routes: {
    admin: [
      { name: "demo", methods: ["GET"], description: "The demo store page." },
      { name: "demo-import", methods: ["POST"], description: "Imports the next slice of the demo store." },
      { name: "demo-remove", methods: ["POST"], description: "Removes the next slice of the demo content." },
    ],
  },
  cron: [{ name: "demo_continue", schedule: "* * * * *" }],
  admin: {
    pages: [{ id: "demo", title: "Demo store", route: "demo" }],
  },
  features: [{
    id: "demo_content",
    name: "Demo store",
    description: "Import a complete demo store in one click, and remove it again.",
    scopes: ["write_products", "write_inventory", "write_files"],
    routes: { admin: ["demo", "demo-import", "demo-remove"] },
    cron: ["demo_continue"],
    admin: ["demo"],
  }],
  storefront: {
    sections,
    skins,
    templates,
    islands: [
      { name: "slider", description: "Arrows, dots and autoplay for the home slider." },
      { name: "tabs", description: "Switches product tabs one panel at a time." },
    ],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

async function sliceAnswer(run: () => Promise<{ job: { mode: string; done: number; total: number; error: string | null } }>) {
  const { job } = await run();
  const message = job.error
    ? { message: job.error.slice(0, 200), tone: "critical" as const }
    : job.mode === "idle"
      ? { message: "Done.", tone: "success" as const }
      : { message: `${job.done} of ${job.total}: continuing every minute.`, tone: "info" as const };
  return { body: ui.result({ toast: message, refresh: true }) };
}

export default definePlugin({
  manifest,
  routes: {
    admin: {
      demo: async (request, ctx) => ({ body: await demoPage(ctx, VOLT_DEMO_PACK, adminContext(request).locale) }),
      "demo-import": (_request, ctx) => sliceAnswer(() => importSlice(ctx, VOLT_DEMO_PACK)),
      "demo-remove": (_request, ctx) => sliceAnswer(() => removeSlice(ctx, VOLT_DEMO_PACK)),
    },
  },
  cron: {
    // Continues a started import or removal; idle costs one read.
    demo_continue: async (ctx) => {
      const job = await readJob(ctx);
      if (job.mode === "import") await importSlice(ctx, VOLT_DEMO_PACK);
      else if (job.mode === "remove") await removeSlice(ctx, VOLT_DEMO_PACK);
    },
  },
});
