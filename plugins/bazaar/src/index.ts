// Bazaar: a marketplace storefront theme as an app. It replicates the
// layout and buying UX of the largest general marketplace (RESEARCH.md)
// under the store's own name and logo: the dark search-first header with
// its department select, account, orders and cart; the department row with
// the "All" drawer and full-width department panels; the hero carousel that
// fades into the page; four-card rows; deal and image rows; product cards
// with stars, superscript prices, list prices, a fast-delivery badge and a
// yellow "Add to cart"; the results page with its filter rail; the product
// page with its centre column and buy box ("Ships from / Sold by",
// other sellers); and the four-column footer.
//
// Everything is drawn at the edge by the storefront module (storefront.tsx)
// on the store's own tokens. The theme reads the `scalius.sellers` app's
// public product fields when that app is installed ("by <seller>" on cards,
// "Sold by" in the buy box) and draws nothing for them otherwise.
//
// The demo content feature (off until a person turns it on) imports the
// demo content pack (src/demo/pack.ts) as ordinary products in one click and
// removes them in one click; each imported item is tracked as a record of
// the `demo_items` object, so removal touches exactly what the import made.

import {
  adminContext,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  type PluginContext,
  type PluginManifestInput,
  type PluginObjectCollection,
} from "@scalius/plugin-sdk";
import { DEMO_PACK_VERSION, DEMO_PRODUCTS, type DemoProduct } from "./demo/pack";

type Storefront = NonNullable<PluginManifestInput["storefront"]>;
type Section = NonNullable<Storefront["sections"]>[number];
type Skin = NonNullable<Storefront["skins"]>[number];
type Template = NonNullable<Storefront["templates"]>[number];
type Field = NonNullable<Section["settings"]>[number];

const cardFields = (): Field[] => {
  const photo = (n: string): Field[] => [
    { key: `image${n}`, label: n ? `Photo ${n.slice(1)}` : "Photo 1", type: "image" },
    { key: `caption${n}`, label: n ? `Caption ${n.slice(1)}` : "Caption 1", type: "text", maxLength: 40 },
  ];
  return [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 60 },
    ...photo(""), ...photo("_2"), ...photo("_3"), ...photo("_4"),
    { key: "link", label: "Link", type: "link" },
    { key: "link_label", label: "Link text", type: "text", maxLength: 30, help: "Empty: See more." },
  ];
};

const sections = [
  {
    type: "card_row",
    name: "Card row",
    description: "Four white cards in a row, each one photo or a 2x2 grid of photos with captions, a title and a link.",
    settings: [
      { key: "cards", label: "Cards", type: "list", itemLabel: "Card", min: 1, max: 8, fields: cardFields(),
        help: "A card with four photos shows them as a 2x2 grid; with fewer, the first photo fills it." },
      { key: "overlap", label: "Overlap the hero above", type: "boolean", default: false, help: "For the first row under the hero carousel." },
    ],
  },
  {
    type: "deal_row",
    name: "Deal row",
    description: "A scrolling row of discounted products with the deal badge, the price and the list price.",
    settings: [
      { key: "heading", label: "Heading", type: "text", default: "Today's Deals", maxLength: 80 },
      { key: "products", label: "Products", type: "products", default: "on-sale", limit: 24 },
      { key: "link", label: "Link", type: "link" },
      { key: "link_label", label: "Link text", type: "text", default: "See all deals", maxLength: 30 },
    ],
  },
  {
    type: "image_row",
    name: "Image row",
    description: "A scrolling row of product photos only, such as best sellers in a department.",
    settings: [
      { key: "heading", label: "Heading", type: "text", default: "Best Sellers", maxLength: 80 },
      { key: "products", label: "Products", type: "products", default: "popular", limit: 24 },
      { key: "link", label: "Link", type: "link" },
      { key: "link_label", label: "Link text", type: "text", maxLength: 30 },
    ],
  },
] satisfies Section[];

const skins = [
  {
    id: "bazaar_header",
    target: "header",
    name: "Bazaar header",
    description: "The marketplace header: logo, deliver-to, search with a department select, account, orders, cart; the department row with the All drawer.",
    settings: [
      { key: "search_placeholder", label: "Search placeholder", type: "text", maxLength: 60, help: "Empty: Search <store name>." },
      { key: "deliver_label", label: "Deliver-to label", type: "text", default: "Deliver to", maxLength: 30 },
      { key: "deliver_place", label: "Deliver-to place", type: "text", maxLength: 40, help: "A city or country you deliver to. Empty hides the chip." },
      { key: "account_greeting", label: "Account greeting", type: "text", default: "Hello, sign in", maxLength: 30 },
      { key: "promo_text", label: "Promotion at the end of the department row", type: "text", maxLength: 60 },
      { key: "promo_link", label: "Promotion link", type: "link" },
      { key: "drawer_programs_title", label: "Drawer heading for the menu", type: "text", default: "Programs & Features", maxLength: 40 },
      { key: "sticky_phone", label: "Keep the header on screen on phones", type: "boolean", default: true },
    ],
  },
  {
    id: "bazaar_footer",
    target: "footer",
    name: "Bazaar footer",
    description: "Back to top, four link columns from your footer menus, your contact line, an optional services grid and the legal line.",
    settings: [
      { key: "show_back_to_top", label: "Back to top bar", type: "boolean", default: true },
      {
        key: "services", label: "Services grid", type: "list", itemLabel: "Service", max: 15,
        help: "Your other stores or programs: a name and one line each.",
        fields: [
          { key: "name", label: "Name", type: "text", required: true, maxLength: 40 },
          { key: "text", label: "One line", type: "text", maxLength: 60 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
      { key: "copyright", label: "Copyright line", type: "text", maxLength: 120, help: "Empty: © <year>, <store name>." },
    ],
  },
  {
    id: "bazaar_card",
    target: "product-card",
    name: "Bazaar card",
    description: "Photo on a light panel, title, stars and count, the big price with the list price, a fast-delivery badge and Add to cart.",
    settings: [
      { key: "fast_label", label: "Fast-delivery badge text", type: "text", maxLength: 20, help: "Such as Express. Empty hides the badge." },
      { key: "show_rating", label: "Stars", type: "boolean", default: true },
      { key: "show_add", label: "Add to cart button", type: "boolean", default: true },
      { key: "show_seller", label: "Seller name (with the Sellers app)", type: "boolean", default: true },
    ],
  },
  {
    id: "bazaar_product",
    target: "product-main",
    name: "Bazaar product page",
    description: "Gallery, the centre column with title, store link, stars, price and About this item, and the buy box with Ships from and Sold by.",
    settings: [
      { key: "choice_badge", label: "Badge under the stars", type: "text", maxLength: 30, help: "Such as Store's Choice. Empty hides it." },
      { key: "ships_from", label: "Ships from", type: "text", maxLength: 60, help: "Empty: the seller, else the store." },
      { key: "returns_text", label: "Returns", type: "text", maxLength: 80, help: "Such as 30-day refund or replacement." },
      { key: "secure_text", label: "Secure line", type: "text", default: "Secure transaction", maxLength: 40 },
      { key: "other_sellers_label", label: "Other sellers link text", type: "text", maxLength: 60 },
      { key: "other_sellers_link", label: "Other sellers link", type: "link", help: "Empty hides the link." },
      { key: "show_info_table", label: "Product information table", type: "boolean", default: true },
    ],
  },
  {
    id: "bazaar_listing",
    target: "listing-main",
    name: "Bazaar results",
    description: "The results bar with the count and sort, the filter rail on the left and the card grid.",
    settings: [],
  },
  {
    id: "bazaar_hero",
    target: "section:hero",
    name: "Bazaar hero carousel",
    description: "The hero's slides as a full-width carousel with side arrows, the photos fading into the page.",
    settings: [
      { key: "fade", label: "Fade into the page", type: "boolean", default: true },
      { key: "interval", label: "Seconds per slide", type: "number", default: 6, min: 3, max: 12, integer: true },
    ],
  },
  {
    id: "bazaar_product_row",
    target: "section:product-rail",
    name: "Bazaar product row",
    description: "Products as a carousel of marketplace cards.",
    settings: [{ key: "link_label", label: "Link text", type: "text", default: "See more", maxLength: 30 }],
  },
  {
    id: "bazaar_deals",
    target: "section:deal-block",
    name: "Bazaar deals",
    description: "The deal block's products as the deal row.",
    settings: [],
  },
  {
    id: "bazaar_quad_tiles",
    target: "section:category-tiles",
    name: "Bazaar category cards",
    description: "Categories four to a card, as the marketplace's shop-by-category cards.",
    settings: [{ key: "link_label", label: "Link text", type: "text", default: "Shop now", maxLength: 30 }],
  },
] satisfies Skin[];

/** The marketplace look: dark navy header, grey page, white cards, teal links, yellow and orange pills. */
const tokens = {
  colors: {
    background: "#e3e6e6", foreground: "#0f1111",
    card: "#ffffff", "card-foreground": "#0f1111",
    popover: "#ffffff", "popover-foreground": "#0f1111",
    primary: "#ffd814", "primary-foreground": "#0f1111",
    secondary: "#232f3e", "secondary-foreground": "#ffffff",
    muted: "#f7f8f8", "muted-foreground": "#565959",
    accent: "#febd69", "accent-foreground": "#0f1111",
    destructive: "#cc0c39", "destructive-foreground": "#ffffff",
    border: "#d5d9d9", input: "#888c8c", ring: "#007185",
  },
  typography: "retail",
  typeScale: "retail",
  headingCase: "sentence",
  density: "dense",
  radius: "subtle",
  buttonShape: "pill",
  surface: "flat",
  imageRatio: "square",
  imageFit: "contain",
  headerTone: "dark",
  container: "full",
};

const appSection = (id: string, type: string, values: Record<string, unknown> = {}) => ({
  id, type: "app", version: 1, settings: { app: `scalius.bazaar/${type}`, values },
});
const skinned = (id: string, type: string, settings: Record<string, unknown>, skin: string, values: Record<string, unknown> = {}) => ({
  id, type, version: 1, settings, skin: { app: `scalius.bazaar/${skin}`, values },
});

// A starting layout: no claims about the merchant's offers. The cards stay
// hidden until the merchant gives them photos and links.
const templates = [
  {
    id: "bazaar",
    name: "Bazaar",
    description: "A marketplace home: the hero carousel, a row of four cards over it, deal and best-seller rows, category cards and product rows.",
    themeVersion: 11,
    theme: {
      tokens,
      blocks: { navigation: { source: "menu", maxTopItems: 30, linkBudget: 200 } },
      apps: {
        skins: {
          header: { app: "scalius.bazaar/bazaar_header", values: {} },
          footer: { app: "scalius.bazaar/bazaar_footer", values: { services: [] } },
          "product-card": { app: "scalius.bazaar/bazaar_card", values: {} },
          "product-main": { app: "scalius.bazaar/bazaar_product", values: {} },
          "listing-main": { app: "scalius.bazaar/bazaar_listing", values: {} },
        },
      },
      sections: [
        skinned("bazaar-hero", "hero", { layout: "full-bleed", slides: [] }, "bazaar_hero"),
        appSection("bazaar-cards-1", "card_row", { cards: [], overlap: true }),
        appSection("bazaar-deals", "deal_row", { heading: "Today's Deals", products: "on-sale" }),
        skinned("bazaar-categories", "category-tiles", { style: "photo", title: "Shop by category", categoryIds: [] }, "bazaar_quad_tiles"),
        appSection("bazaar-best", "image_row", { heading: "Best Sellers", products: "popular" }),
        skinned("bazaar-new", "product-rail", { title: "New arrivals", source: { kind: "newest" }, limit: 12 }, "bazaar_product_row"),
        appSection("bazaar-cards-2", "card_row", { cards: [] }),
      ],
    },
  },
] satisfies Template[];

export const manifest = {
  id: "scalius.bazaar",
  name: "Bazaar theme",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A marketplace storefront theme: a search-first header with a department select, the All drawer and department panels, a hero carousel, four-card rows, deal and best-seller rows, marketplace product cards, a results page with a filter rail, a product page with a buy box, and a four-column footer. Shows each product's seller with the Sellers app. Includes a demo content pack you can import and remove in one click.",
  tagline: "A marketplace theme with a buy box and deal rows",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  categories: ["store-design", "content"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  objects: {
    demo_items: {
      name: "Bazaar demo items",
      description: "What the demo content import made, so removal removes exactly that.",
      fields: [
        { key: "kind", name: "Kind", type: "single_line_text", required: true, validations: { choices: ["product", "media"] } },
        { key: "key", name: "Pack item", type: "single_line_text", required: true },
        { key: "resource_id", name: "Store id", type: "single_line_text" },
        { key: "media_id", name: "Photo id", type: "single_line_text" },
        { key: "status", name: "Status", type: "single_line_text", validations: { choices: ["pending", "imported"] } },
        { key: "pack_version", name: "Pack version", type: "integer" },
        { key: "created_at", name: "Imported at", type: "integer" },
      ],
      display: "key",
      indexes: [["kind", "created_at"]],
      admin: "read",
    },
  },
  settings: [
    { key: "demo_image_base", label: "Demo photo folder", type: "url", group: "demo", help: "An https folder with the demo pack's photos (earbuds.jpg, speaker.jpg, ...). Empty: the demo products import without photos." },
  ],
  settingsGroups: [{ id: "demo", title: "Demo content", description: "Sample products to see the theme with a full catalogue." }],
  routes: {
    admin: [
      { name: "demo", methods: ["GET"], description: "The demo content page." },
      { name: "demo-import", methods: ["POST"], description: "Imports the demo pack's products." },
      { name: "demo-remove", methods: ["POST"], description: "Moves the imported demo products to the trash." },
    ],
  },
  admin: {
    pages: [{ id: "demo", title: "Bazaar demo content", route: "demo" }],
  },
  features: [{
    id: "demo_content",
    name: "Demo content",
    description: "Import sample products (and optional photos) in one click to see the theme full, and remove exactly those in one click.",
    scopes: ["write_products", "write_files"],
    settingsGroups: ["demo"],
    routes: { admin: ["demo", "demo-import", "demo-remove"], public: [], webhooks: [] },
    admin: ["demo"],
  }],
  storefront: {
    sections,
    skins,
    templates,
    islands: [
      { name: "rail", description: "Side arrows for scrolling rows." },
      { name: "hero", description: "Slides, arrows and autoplay for the hero carousel." },
      { name: "search", description: "Sends a header search to the chosen department." },
    ],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

// ── Demo content ───────────────────────────────────────────────────────────

/** Items one click imports or removes: each takes about three platform calls, within the Free plan's 50 per run. */
const PER_RUN = 8;

interface DemoItem extends Record<string, unknown> {
  kind: "product" | "media";
  key: string;
  resource_id: string | null;
  media_id: string | null;
  status: "pending" | "imported";
  pack_version: number;
  created_at: number;
}

function items(ctx: PluginContext) {
  const collection = ctx.objects.demo_items;
  if (!collection) throw new Error("The demo_items object is not declared.");
  return collection as unknown as PluginObjectCollection<DemoItem>;
}

const recordId = (key: string) => `product:${key}`;

function idOf(data: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    let value: unknown = data;
    for (const step of path) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[step] : undefined;
    if (typeof value === "string" && value) return value;
  }
  return null;
}

async function importPhoto(ctx: PluginContext, product: DemoProduct): Promise<string | null> {
  const base = typeof ctx.settings.demo_image_base === "string" ? ctx.settings.demo_image_base.trim().replace(/\/+$/, "") : "";
  if (!base.startsWith("https://")) return null;
  const result = await ctx.api.call("dashboard.media.import_url", {
    body: { sourceUrl: `${base}/${product.image}`, filename: `bazaar-demo-${product.image}` },
    idempotencyKey: `bazaar-demo-media-${DEMO_PACK_VERSION}-${product.key}`,
  });
  if (!result.ok) {
    ctx.log.warn("A demo photo did not import", { key: product.key, status: result.status, code: result.error?.code });
    return null;
  }
  return idOf(result.data, ["data", "file", "id"], ["file", "id"]);
}

/** Imports the pack's next products; returns how many it imported and how many remain. */
export async function importDemo(ctx: PluginContext): Promise<{ imported: number; remaining: number; failed: number }> {
  const store = items(ctx);
  let imported = 0;
  let failed = 0;
  let pending = 0;
  for (const product of DEMO_PRODUCTS) {
    const existing = await store.getVersion(recordId(product.key));
    if (existing?.data.status === "imported") continue;
    if (imported + failed >= PER_RUN) { pending += 1; continue; }
    // The record comes first: a crash after the create leaves a pending item
    // the merchant can see in Objects (products.create takes no retry key).
    const at = Date.now();
    const pendingRecord: DemoItem = { kind: "product", key: product.key, resource_id: null, media_id: null, status: "pending", pack_version: DEMO_PACK_VERSION, created_at: at };
    const { revision } = await store.put(recordId(product.key), pendingRecord, { expectedRevision: existing?.revision ?? null });
    const mediaId = await importPhoto(ctx, product);
    const created = await ctx.api.call("dashboard.products.create", {
      body: {
        name: product.name,
        description: product.description,
        price: product.price,
        isActive: true,
        slug: `demo-${product.key}`,
        ...(product.discountPercentage ? { discountType: "percentage", discountPercentage: product.discountPercentage } : {}),
        ...(mediaId ? { media: [{ id: `pmed_bazaar_${product.key.replace(/[^A-Za-z0-9_-]/g, "_")}`, mediaId, altText: product.name, isPrimary: true }] } : {}),
      },
    });
    const productId = created.ok ? idOf(created.data, ["data", "product", "id"], ["data", "id"], ["product", "id"], ["id"]) : null;
    if (!productId) {
      failed += 1;
      ctx.log.warn("A demo product did not import", { key: product.key, status: created.status, code: created.error?.code });
      continue;
    }
    await store.put(recordId(product.key), { ...pendingRecord, resource_id: productId, media_id: mediaId, status: "imported" }, { expectedRevision: revision });
    imported += 1;
  }
  return { imported, remaining: pending, failed };
}

/** Moves the next imported demo products (and their photos) to the trash and forgets them. */
export async function removeDemo(ctx: PluginContext): Promise<{ removed: number; remaining: number; failed: number }> {
  const store = items(ctx);
  const page = await store.query({ where: { kind: "product" }, orderBy: { field: "created_at", direction: "asc" }, limit: 100 });
  let removed = 0;
  let failed = 0;
  for (const record of page.records.slice(0, PER_RUN)) {
    const productId = record.data.resource_id;
    if (productId) {
      const current = await ctx.api.call<{ data?: { revision?: number; deletedAt?: string | null } }>("dashboard.resources.products.get", { path: { id: productId } });
      const revision = current.data?.data?.revision;
      if (current.ok && current.data?.data?.deletedAt == null && typeof revision === "number") {
        const trashed = await ctx.api.call("dashboard.products.trash", {
          path: { id: productId },
          query: { expectedAggregateRevision: revision },
          idempotencyKey: `bazaar-demo-trash-${productId}-${revision}`,
        });
        if (!trashed.ok) {
          failed += 1;
          ctx.log.warn("A demo product was not removed", { key: record.data.key, status: trashed.status, code: trashed.error?.code });
          continue;
        }
      } else if (current.status !== 404 && !current.ok) {
        failed += 1;
        continue;
      }
    }
    if (record.data.media_id) {
      await ctx.api.call("dashboard.media.trash", { path: { id: record.data.media_id }, idempotencyKey: `bazaar-demo-media-trash-${record.data.media_id}` });
    }
    await store.delete(record.id, { expectedRevision: record.revision });
    removed += 1;
  }
  return { removed, remaining: Math.max(0, page.records.length - removed - failed), failed };
}

export default definePlugin({
  manifest,
  routes: {
    admin: {
      demo: async (request, ctx) => {
        const page = await items(ctx).query({ where: { kind: "product" }, orderBy: { field: "created_at", direction: "desc" }, limit: 50, cursor: adminContext(request).cursor });
        const imported = page.records.filter((record) => record.data.status === "imported").length;
        const photos = typeof ctx.settings.demo_image_base === "string" && ctx.settings.demo_image_base.startsWith("https://");
        return {
          body: ui.page([
            ui.columns([
              ui.stat("Products in the pack", DEMO_PRODUCTS.length),
              ui.stat("Imported", imported),
              ui.stat("Photos", photos ? "From your folder" : "None"),
            ]),
            photos ? ui.text("Photos come from the demo photo folder in the app's settings.", { tone: "neutral", size: "sm" })
              : ui.banner("info", "The demo products import without photos. Set a demo photo folder in the app's settings to add them."),
            ui.card("Imported demo products", [
              ui.table({
                columns: [{ key: "item", label: "Pack item" }, { key: "status", label: "Status" }, { key: "at", label: "Imported" }],
                rows: page.records.map((record) => ({
                  id: record.id,
                  ...(record.data.resource_id ? { to: ui.to.resource("product", record.data.resource_id) } : {}),
                  cells: {
                    item: record.data.resource_id ? { text: record.data.key, to: ui.to.resource("product", record.data.resource_id) } : record.data.key,
                    status: { badge: record.data.status === "imported" ? "Imported" : "Pending", tone: record.data.status === "imported" ? "success" : "warning" },
                    at: { date: new Date(record.data.created_at || 0).toISOString() },
                  },
                })),
                pagination: { next: page.nextCursor },
                empty: { title: "No demo content yet", text: "Import the pack to see the theme with a full catalogue." },
              }),
            ]),
          ], {
            title: "Bazaar demo content",
            description: "Sample products for the Bazaar theme. They are ordinary products while imported; removal moves exactly these to the trash.",
            actions: [
              ui.button("Import demo content", { route: "demo-import" }, { tone: "primary" }),
              ui.button("Remove demo content", { route: "demo-remove" }, {
                tone: "critical",
                confirm: { title: "Remove the demo content?", text: "The imported demo products and their photos move to the trash. Your own products are not touched.", confirmLabel: "Remove", destructive: true },
              }),
            ],
          }),
        };
      },
      "demo-import": async (_request, ctx) => {
        const result = await importDemo(ctx);
        const more = result.remaining > 0 ? ` ${result.remaining} more: import again to continue.` : "";
        const failed = result.failed > 0 ? ` ${result.failed} could not be imported (see the app's log).` : "";
        return { body: ui.result({ toast: { message: `Imported ${result.imported} demo products.${more}${failed}`, tone: result.failed > 0 ? "info" : "success" }, refresh: true }) };
      },
      "demo-remove": async (_request, ctx) => {
        const result = await removeDemo(ctx);
        const more = result.remaining > 0 ? ` ${result.remaining} more: remove again to continue.` : "";
        return { body: ui.result({ toast: { message: `Removed ${result.removed} demo products.${more}`, tone: result.failed > 0 ? "info" : "success" }, refresh: true }) };
      },
    },
  },
});
