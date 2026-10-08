// Scalius Wishlist (`acme.wishlist`): a first-party app built only on the
// public plugin contract.
//
// - Storefront: a heart button product block (buy box) drawn from settings
//   alone, so it is cached with the product page and never per buyer; the
//   buyer's state is fetched after load (`data-app-state`) and the button is
//   a plain form, so it works without JavaScript. The wishlist page is
//   `/apps/acme.wishlist/wishlist`, drawn inside the store layout.
// - Identity: the storefront proxy tells public routes who is signed in
//   (`request.customer.id`); the app never sees a cookie or token.
// - Storage: `wishes` (one record per customer and product) and `products`
//   (name, link, image and wish count of every wished product, refreshed by
//   `product.updated`/`product.deleted`).
// - Dashboard: "Most wished" (products, ranked) and a card on each product.

import {
  adminContext,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  wantsPage,
  type PluginContext,
  type PluginManifestInput,
  type PluginRouteRequest,
  type PluginRouteResponse,
} from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.wishlist",
  name: "Wishlist",
  version: "0.1.2",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers save products with a heart button and find them again on their wishlist page; you see which products are wished most.",
  author: { name: "Scalius" },
  tagline: "Buyers save products to buy later",
  categories: ["marketing"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  // Product names, links and images for the wishlist page and the dashboard.
  permissions: ["products.view"],
  events: ["product.updated", "product.deleted"],
  routes: {
    admin: [
      { name: "most-wished", methods: ["GET"], description: "The most wished products." },
      { name: "product-card", methods: ["GET"], description: "How often one product is wished." },
    ],
    public: [
      { name: "button", methods: ["GET"], description: "Draws the heart button (product block)." },
      { name: "toggle", methods: ["POST"], description: "Saves or removes a product for the signed-in buyer." },
      { name: "state", methods: ["GET"], description: "Whether the signed-in buyer saved a product." },
      { name: "wishlist", methods: ["GET"], description: "The signed-in buyer's wishlist (a store page)." },
    ],
  },
  storage: {
    wishes: { indexes: [["customerId", "addedAt"], "productId"], unique: [["customerId", "productId"]] },
    products: { indexes: ["wishes"] },
  },
  settings: [
    { key: "max_items", label: "Most products one buyer can save", type: "number", integer: true, min: 1, max: 500, default: 100 },
  ],
  admin: {
    pages: [{ id: "most-wished", title: "Most wished", placement: "products", route: "most-wished" }],
    cards: [{ id: "wishes", target: "product", title: "Wishlist", route: "product-card" }],
  },
  translations: {
    bn: {
      name: "উইশলিস্ট",
      tagline: "ক্রেতারা পরে কেনার জন্য প্রোডাক্ট সেভ করেন",
      description: "ক্রেতারা হার্ট বাটনে প্রোডাক্ট সেভ করেন আর উইশলিস্ট পেজে আবার খুঁজে পান; আপনি দেখেন কোন প্রোডাক্ট সবচেয়ে বেশি সেভ হয়।",
      pages: { "most-wished": "সবচেয়ে বেশি সেভ করা" },
      cards: { wishes: "উইশলিস্ট" },
    },
  },
  storefront: {
    proxy: true,
    productBlocks: [{
      type: "button",
      name: "Wishlist button",
      placement: "buy-box",
      route: "button",
      settings: [
        { key: "label", label: "Button text", type: "text", default: "Save to wishlist", maxLength: 40 },
        { key: "saved_label", label: "Button text once saved", type: "text", default: "Saved to wishlist", maxLength: 40 },
      ],
    }],
  },
} satisfies PluginManifestInput;

const APP = `/apps/${manifest.id}`;

/** The dashboard screens' words, in the staff member's dashboard language (`adminContext().locale`). */
const ADMIN_TEXT = {
  en: {
    savedProducts: "Saved products",
    productsWished: "Products wished",
    mostWished: "Most wished",
    caption: "Products by how many buyers saved them",
    product: "Product",
    wishes: "Wishes",
    status: "Status",
    onSale: "On sale",
    notAvailable: "Not available",
    emptyTitle: "Nothing wished yet",
    emptyText: "Add the Wishlist button to the product page in Online Store → Theme.",
    pageDescription: "What buyers save for later, most wished first.",
    openProduct: "Open a product to see its wishes.",
    savedBy: "Buyers who saved it",
    mostWishedProducts: "Most wished products",
  },
  bn: {
    savedProducts: "সেভ করা প্রোডাক্ট",
    productsWished: "যত প্রোডাক্ট সেভ হয়েছে",
    mostWished: "সবচেয়ে বেশি সেভ করা",
    caption: "কতজন ক্রেতা সেভ করেছেন সেই অনুযায়ী প্রোডাক্ট",
    product: "প্রোডাক্ট",
    wishes: "সেভ",
    status: "স্ট্যাটাস",
    onSale: "বিক্রি হচ্ছে",
    notAvailable: "পাওয়া যাচ্ছে না",
    emptyTitle: "এখনও কিছু সেভ হয়নি",
    emptyText: "অনলাইন স্টোর → থিম-এ প্রোডাক্ট পেজে উইশলিস্ট বাটন যোগ করুন।",
    pageDescription: "ক্রেতারা পরে কেনার জন্য যা সেভ করেন, সবচেয়ে বেশি সেভ করা আগে।",
    openProduct: "কতজন সেভ করেছেন দেখতে একটি প্রোডাক্ট খুলুন।",
    savedBy: "যত ক্রেতা সেভ করেছেন",
    mostWishedProducts: "সবচেয়ে বেশি সেভ করা প্রোডাক্ট",
  },
} as const;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_SIZE = 24;

interface Wish extends Record<string, unknown> {
  customerId: string;
  productId: string;
  addedAt: number;
}

/** What the app keeps of a wished product. */
interface ProductFacts extends Record<string, unknown> {
  productId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  /** False once the product is trashed or deleted: the page leaves it out. */
  available: boolean;
}

interface WishedProduct extends ProductFacts {
  wishes: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

const wishes = (ctx: PluginContext) => ctx.storage.wishes!;
const products = (ctx: PluginContext) => ctx.storage.products!;

/** A same-store path to come back to after a form post without JavaScript. */
function returnPath(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\/(?![/\\])[^\s\\]{0,500}$/.test(value) ? value : fallback;
}

function fieldOf(request: PluginRouteRequest, name: string): string {
  const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const value = body[name] ?? request.query[name];
  return typeof value === "string" ? value.trim() : "";
}

/** The product as the dashboard API returns it (its base section and its picker summary), reduced to what the app shows. */
async function readProduct(ctx: PluginContext, productId: string): Promise<ProductFacts | null> {
  const [base, summary] = await Promise.all([
    ctx.api.call<{ product?: { name?: string; slug?: string; isActive?: boolean; deletedAt?: unknown } }>(
      "dashboard.products.get_section",
      { path: { id: productId, section: "base" } },
    ),
    ctx.api.call<{ products?: Array<{ id?: string; primaryImage?: string | null }> }>(
      "dashboard.products.get_by_ids",
      { query: { ids: productId } },
    ),
  ]);
  const product = base.ok ? base.data?.product : undefined;
  if (!product) return null;
  const image = summary.ok ? summary.data?.products?.find((entry) => entry.id === productId)?.primaryImage : null;
  return {
    productId,
    name: String(product.name ?? "").slice(0, 200),
    slug: String(product.slug ?? "").slice(0, 200),
    imageUrl: typeof image === "string" && image ? image : null,
    available: product.isActive !== false && !product.deletedAt,
  };
}

/** Recounts a product's wishes and keeps its name, link and image (read once, when it is first wished). */
async function refreshWishedProduct(ctx: PluginContext, productId: string): Promise<void> {
  const [count, stored] = await Promise.all([wishes(ctx).count({ productId }), products(ctx).get(productId)]);
  const existing = stored as WishedProduct | null;
  if (count === 0 && existing) {
    await products(ctx).delete(productId);
    return;
  }
  if (count === 0) return;
  const facts: ProductFacts = existing
    ?? await readProduct(ctx, productId)
    ?? { productId, name: "", slug: "", imageUrl: null, available: true };
  if (existing && existing.wishes === count) return;
  await products(ctx).put(productId, { ...facts, wishes: count } satisfies WishedProduct);
}

/** A form post without JavaScript is a navigation (redirect back); with the storefront's app-form script it is JSON. */
function answer(request: PluginRouteRequest, json: Record<string, unknown>, redirect: string, status = 200): PluginRouteResponse {
  if (wantsPage(request)) return { body: { redirect } };
  return status === 200 ? { body: json } : { status, body: json };
}

export default definePlugin({
  manifest,

  events: {
    // Keep the names, links and images of wished products current; products nobody wished are never stored.
    "product.updated": async (event, ctx) => {
      const existing = await products(ctx).get(event.resource.id) as WishedProduct | null;
      if (!existing) return;
      const facts = await readProduct(ctx, event.resource.id);
      if (!facts) return;
      if (facts.name === existing.name && facts.slug === existing.slug && facts.imageUrl === existing.imageUrl && facts.available === existing.available) return;
      await products(ctx).put(event.resource.id, { ...existing, ...facts });
    },
    "product.deleted": async (event, ctx) => {
      const existing = await products(ctx).get(event.resource.id) as WishedProduct | null;
      if (existing && existing.available) await products(ctx).put(event.resource.id, { ...existing, available: false });
    },
  },

  routes: {
    public: {
      // The product block: the same HTML for every buyer (cached with the page).
      button: (request) => {
        const product = request.render?.product;
        if (!product || !PRODUCT_ID.test(product.id)) return { body: { html: "" } };
        const label = String(request.render?.settings.label ?? "").trim() || "Save to wishlist";
        const saved = String(request.render?.settings.saved_label ?? "").trim() || "Saved to wishlist";
        const id = escapeHtml(product.id);
        const html = [
          `<form class="mt-3" action="${APP}/toggle" method="post" data-app-form data-app-state="${APP}/state?productId=${id}">`,
          `<input type="hidden" name="productId" value="${id}">`,
          `<input type="hidden" name="returnTo" value="/products/${escapeHtml(encodeURIComponent(product.slug))}">`,
          `<button type="submit" class="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground" aria-pressed="false" data-app-label-on="${escapeHtml(saved)}" data-app-label-off="${escapeHtml(label)}">`,
          `<span aria-hidden="true">&#9825;</span><span data-app-label>${escapeHtml(label)}</span></button>`,
          `<p class="mt-1 text-sm text-muted-foreground" role="status" data-app-message></p>`,
          `</form>`,
        ].join("");
        return { body: { html } };
      },

      toggle: async (request, ctx) => {
        const productId = fieldOf(request, "productId");
        const back = returnPath(fieldOf(request, "returnTo"), `${APP}/wishlist`);
        if (!PRODUCT_ID.test(productId)) return answer(request, { message: "That product cannot be saved." }, back, 422);
        const customer = request.customer;
        if (!customer) {
          return answer(request, { message: "Sign in to save products to your wishlist.", navigate: "/account" }, "/account", 401);
        }
        const id = `${customer.id}:${productId}`;
        let pressed: boolean;
        if (await wishes(ctx).get(id)) {
          await wishes(ctx).delete(id);
          pressed = false;
        } else {
          const limit = Number(ctx.settings.max_items ?? 100);
          if (await wishes(ctx).count({ customerId: customer.id }) >= limit) {
            return answer(request, { message: `Your wishlist is full (${limit} products).`, pressed: false }, back, 409);
          }
          await wishes(ctx).put(id, { customerId: customer.id, productId, addedAt: Date.now() } satisfies Wish);
          pressed = true;
        }
        await refreshWishedProduct(ctx, productId);
        return answer(request, { pressed, message: pressed ? "Saved to your wishlist." : "Removed from your wishlist." }, back);
      },

      state: async (request, ctx) => {
        const productId = request.query.productId ?? "";
        const customer = request.customer;
        if (!customer || !PRODUCT_ID.test(productId)) return { body: { pressed: false, signedIn: Boolean(customer) } };
        return { body: { pressed: Boolean(await wishes(ctx).get(`${customer.id}:${productId}`)), signedIn: true } };
      },

      wishlist: async (request, ctx) => {
        const customer = request.customer;
        if (!customer) {
          if (!wantsPage(request)) return { status: 401, body: { items: [], signedIn: false } };
          return {
            body: {
              page: {
                title: "Your wishlist",
                html: '<div class="max-w-3xl py-6"><p class="text-lg font-semibold">Sign in to see your wishlist</p><p class="mt-2 text-muted-foreground">Products you save stay here for next time.</p><p class="mt-4"><a class="underline" href="/account">Sign in</a></p></div>',
              },
            },
          };
        }
        const page = await wishes(ctx).query({
          where: { customerId: customer.id },
          orderBy: { field: "addedAt", direction: "desc" },
          limit: PAGE_SIZE,
          cursor: request.query.cursor ?? null,
        });
        const facts = await Promise.all(page.records.map((record) => products(ctx).get(String(record.data.productId)) as Promise<WishedProduct | null>));
        const items = page.records.flatMap((record, index) => {
          const product = facts[index];
          return product && product.available && product.slug ? [{ product, addedAt: Number(record.data.addedAt) || 0 }] : [];
        });
        if (!wantsPage(request)) {
          return { body: { items: items.map(({ product }) => ({ productId: product.productId, name: product.name, url: `/products/${product.slug}`, imageUrl: product.imageUrl })), nextCursor: page.nextCursor } };
        }
        const rows = items.map(({ product }) => {
          const href = `/products/${escapeHtml(encodeURIComponent(product.slug))}`;
          const image = product.imageUrl
            ? `<img src="${escapeHtml(product.imageUrl)}" alt="" width="80" height="80" class="h-20 w-20 rounded-md object-cover">`
            : '<span class="h-20 w-20 rounded-md bg-muted" aria-hidden="true"></span>';
          return `<li class="flex items-center gap-4 border-b border-border py-4">${image}<a class="flex-1 font-medium hover:underline" href="${href}">${escapeHtml(product.name || "Product")}</a>`
            + `<form action="${APP}/toggle" method="post"><input type="hidden" name="productId" value="${escapeHtml(product.productId)}"><input type="hidden" name="returnTo" value="${APP}/wishlist">`
            + `<button type="submit" class="text-sm underline">Remove</button></form></li>`;
        }).join("");
        const more = page.nextCursor
          ? `<p class="mt-6 text-center"><a class="underline" href="${APP}/wishlist?cursor=${escapeHtml(encodeURIComponent(page.nextCursor))}">More saved products</a></p>`
          : "";
        const body = rows
          ? `<ul class="mt-4">${rows}</ul>${more}`
          : '<p class="mt-4 text-muted-foreground">Nothing saved yet. Tap the heart on a product to keep it here.</p><p class="mt-4"><a class="underline" href="/">Continue shopping</a></p>';
        return { body: { page: { title: "Your wishlist", html: `<div class="max-w-3xl">${body}</div>` } } };
      },
    },

    admin: {
      "most-wished": async (request, ctx) => {
        const { cursor, locale } = adminContext(request);
        const t = ADMIN_TEXT[locale];
        const [page, total] = await Promise.all([
          products(ctx).query({ orderBy: { field: "wishes", direction: "desc" }, limit: 25, cursor }),
          wishes(ctx).count(),
        ]);
        return {
          body: ui.page([
            ui.columns([ui.stat(t.savedProducts, total), ui.stat(t.productsWished, page.records.length === 25 || page.nextCursor ? "25+" : page.records.length)]),
            ui.card(t.mostWished, [
              ui.table({
                caption: t.caption,
                columns: [{ key: "product", label: t.product }, { key: "wishes", label: t.wishes, align: "end" }, { key: "state", label: t.status }],
                rows: page.records.map((record) => {
                  const product = record.data as WishedProduct;
                  return {
                    id: record.id,
                    to: ui.to.resource("product", record.id),
                    cells: {
                      product: { text: product.name || record.id, to: ui.to.resource("product", record.id) },
                      wishes: Number(product.wishes) || 0,
                      state: product.available ? { badge: t.onSale, tone: "success" } : { badge: t.notAvailable, tone: "neutral" },
                    },
                  };
                }),
                pagination: { next: page.nextCursor },
                empty: { title: t.emptyTitle, text: t.emptyText },
              }),
            ]),
          ], { title: t.mostWished, description: t.pageDescription }),
        };
      },

      "product-card": async (request, ctx) => {
        const { id, locale } = adminContext(request);
        const t = ADMIN_TEXT[locale];
        if (!id) return { body: ui.view([ui.text(t.openProduct)]) };
        const count = await wishes(ctx).count({ productId: id });
        return {
          body: ui.view([
            ui.stat(t.savedBy, count),
            ui.link(t.mostWishedProducts, ui.to.page("most-wished")),
          ]),
        };
      },
    },
  },
});
