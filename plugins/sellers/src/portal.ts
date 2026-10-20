// The seller portal and the public seller pages, storefront proxy pages
// (`/apps/scalius.sellers/...`) drawn in the store's layout by the app's own
// page components (src/pages.tsx) from the props these routes answer:
//
// - `apply`: the onboarding form (a signed-in customer applies for a shop);
// - `portal`: the seller's own dashboard (status, sales, net, payouts), its
//   orders with what to ship, a "Mark as shipped" form per split, and its
//   payouts;
// - `store/<handle>`: the seller's public page with its products.
//
// The platform resolves the signed-in customer (`request.customer`); the app
// never sees a cookie. A seller is the customer an account names. Forms post
// back to the same route (same origin); every write checks that the split
// belongs to the signed-in seller.

import type { PluginContext, PluginRouteRequest, PluginRouteResponse } from "@scalius/plugin-sdk";
import { createSeller, sellerOfCustomer } from "./accounts";
import { HANDLE_PATTERN, plain, productSellers, profiles, sellers, splits, payouts, type OrderSplit, type Seller } from "./model";
import type { PageMoney, PageSeller, PageSplit, SellerPortalProps, SellerShopProps } from "./pages";

const BASE = "/apps/scalius.sellers";

/** Where a guest signs in: the store's own route (`request.routes`), never a hard-coded path. */
function signInPath(request: PluginRouteRequest): string {
  return request.routes?.signIn ?? "/account";
}

/** Integer minor units as the page component formats them: major units of the store's decimal places. */
function money(ctx: PluginContext, minor: number, currency: string): PageMoney {
  return { amount: minor / 10 ** ctx.store.decimalPlaces, currency };
}

function portalPage(title: string, props: SellerPortalProps): PluginRouteResponse {
  return { headers: { "cache-control": "no-store" }, body: { page: { title, component: "seller_portal", props } } };
}

function shopPage(title: string, props: SellerShopProps, description?: string): PluginRouteResponse {
  return { body: { page: { title, ...(description ? { description } : {}), component: "seller_shop", props } } };
}

function signIn(request: PluginRouteRequest): PluginRouteResponse {
  return portalPage("Seller dashboard", { view: "sign-in", signIn: signInPath(request) });
}

function sellerOf(seller: Seller): PageSeller {
  return { name: seller.name, handle: seller.handle, status: seller.status };
}

function splitRows(ctx: PluginContext, rows: Array<{ id: string; data: OrderSplit }>): PageSplit[] {
  return rows.map(({ id, data }) => ({
    id,
    order: String(data.order_number ?? data.order_id),
    placedAt: data.created_at,
    lines: data.lines.map((line) => ({ quantity: line.quantity, title: line.title })),
    status: data.status,
    net: money(ctx, data.net_minor, data.currency),
    shippable: data.status === "open" || data.status === "paid",
  }));
}

async function dashboard(ctx: PluginContext, id: string, seller: Seller) {
  const recent = await splits(ctx).query({ where: { seller_id: id }, orderBy: { field: "created_at", direction: "desc" }, limit: 50 });
  const live = recent.records.filter((record) => record.data.status !== "cancelled" && record.data.status !== "refunded");
  const currency = live[0]?.data.currency ?? ctx.store.currency;
  const sales = live.reduce((sum, record) => sum + record.data.subtotal_minor, 0);
  const net = live.reduce((sum, record) => sum + record.data.net_minor, 0);
  const toShip = live.filter((record) => record.data.status === "open" || record.data.status === "paid");
  return portalPage(`${seller.name}: seller dashboard`, {
    view: "home",
    seller: sellerOf(seller),
    sales: money(ctx, sales, currency),
    net: money(ctx, net, currency),
    toShipCount: toShip.length,
    toShip: splitRows(ctx, toShip.slice(0, 10)),
  });
}

async function ordersPage(ctx: PluginContext, id: string, seller: Seller, request: PluginRouteRequest) {
  const page = await splits(ctx).query({ where: { seller_id: id }, orderBy: { field: "created_at", direction: "desc" }, limit: 25, cursor: request.query.cursor ?? null });
  const shipped = request.query.shipped;
  return portalPage(`${seller.name}: orders`, {
    view: "orders",
    seller: sellerOf(seller),
    orders: splitRows(ctx, page.records),
    older: page.nextCursor ? `${BASE}/portal/orders?cursor=${encodeURIComponent(page.nextCursor)}` : null,
    notice: shipped === "1" ? "shipped" : shipped === "0" ? "not_shipped" : null,
  });
}

async function productsPage(ctx: PluginContext, id: string, seller: Seller) {
  const owned = await productSellers(ctx).query({ where: { seller_id: id }, orderBy: { field: "assigned_at", direction: "desc" }, limit: 20 });
  // One read per product (no bulk read for apps yet: BURST-NOTES gap 19), bounded at 20.
  const products: Array<{ name: string; status: string }> = [];
  for (const record of owned.records) {
    const result = await ctx.api.call<{ data?: { name?: string; status?: string } }>("dashboard.resources.products.get", { path: { id: record.id } });
    const product = result.ok ? result.data?.data : undefined;
    products.push({ name: product?.name ?? record.id, status: product?.name ? product.status ?? "" : "" });
  }
  return portalPage(`${seller.name}: products`, { view: "products", seller: sellerOf(seller), products });
}

async function payoutsPage(ctx: PluginContext, id: string, seller: Seller) {
  const page = await payouts(ctx).query({ where: { seller_id: id }, orderBy: { field: "created_at", direction: "desc" }, limit: 25 });
  return portalPage(`${seller.name}: payouts`, {
    view: "payouts",
    seller: sellerOf(seller),
    payouts: page.records.map(({ data }) => ({
      periodEnd: data.period_end,
      orders: data.split_count,
      gross: money(ctx, data.gross_minor, data.currency),
      commission: money(ctx, data.commission_minor, data.currency),
      net: money(ctx, data.net_minor, data.currency),
      status: data.status,
      reference: data.reference ?? null,
    })),
  });
}

/** Marks one of the signed-in seller's splits as shipped: a fulfilment of exactly its lines, then the split moves on. */
async function ship(ctx: PluginContext, request: PluginRouteRequest, id: string): Promise<PluginRouteResponse> {
  const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const splitId = plain(body.split, 300);
  const current = splitId ? await splits(ctx).getVersion(splitId) : null;
  // The split must be this seller's: a forged id for another seller's order changes nothing.
  if (!current || current.data.seller_id !== id) return { body: { redirect: `${BASE}/portal/orders` } };
  if (current.data.status !== "open" && current.data.status !== "paid") return { body: { redirect: `${BASE}/portal/orders` } };
  const courier = plain(body.courier, 120);
  const tracking = plain(body.tracking, 180);
  const result = await ctx.api.call("dashboard.resources.fulfillments.create", {
    path: { id: current.data.order_id },
    body: {
      kind: "ship",
      lines: current.data.lines.map((line) => ({ orderItemId: line.line_id, quantity: line.quantity })),
      ...(courier || tracking ? { tracking: { ...(courier ? { courierName: courier } : {}), ...(tracking ? { trackingId: tracking } : {}) } } : {}),
    },
    idempotencyKey: `sellers-ship-${splitId}`.slice(0, 200),
  });
  if (!result.ok) {
    ctx.log.warn("A seller shipment was refused", { status: result.status, code: result.error?.code });
    return { body: { redirect: `${BASE}/portal/orders?shipped=0` } };
  }
  await splits(ctx).put(splitId, { ...current.data, status: "fulfilled" }, { expectedRevision: current.revision });
  return { body: { redirect: `${BASE}/portal/orders?shipped=1` } };
}

export async function portalRoute(request: PluginRouteRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const customerId = request.customer?.id ?? null;
  if (!customerId) return signIn(request);
  const mine = await sellerOfCustomer(ctx, customerId);
  if (!mine) return { body: { redirect: `${BASE}/apply` } };
  const section = request.subpath.replace(/^\/+|\/+$/g, "");
  if (request.method === "POST") {
    if (section === "ship" && mine.seller.status === "approved") return ship(ctx, request, mine.id);
    return { body: { redirect: `${BASE}/portal` } };
  }
  if (section === "orders") return ordersPage(ctx, mine.id, mine.seller, request);
  if (section === "products") return productsPage(ctx, mine.id, mine.seller);
  if (section === "payouts") return payoutsPage(ctx, mine.id, mine.seller);
  return dashboard(ctx, mine.id, mine.seller);
}

export async function applyRoute(request: PluginRouteRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const customerId = request.customer?.id ?? null;
  if (!customerId) return signIn(request);
  const mine = await sellerOfCustomer(ctx, customerId);
  if (mine) return { body: { redirect: `${BASE}/portal` } };
  const open = ctx.settings.applications_open !== false;
  if (!open || request.method !== "POST") return portalPage("Sell with us", { view: "apply", storeName: ctx.store.name, open });
  const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const values = { name: plain(body.name, 80), handle: plain(body.handle, 50), email: plain(body.email, 200), about: plain(body.about, 600) };
  const result = await createSeller(ctx, { ...values, customerId }, "pending");
  if (!result.ok) {
    return { status: 422, ...portalPage("Sell with us", { view: "apply", storeName: ctx.store.name, open, errors: result.errors, values }) };
  }
  await ctx.messaging.notifyStaff({ title: "A new seller applied", body: `${result.seller.name} wants to sell on the store.`, url: "/admin/apps/scalius.sellers/pages/sellers" })
    .catch(() => undefined);
  return { body: { redirect: `${BASE}/portal` } };
}

/** The seller's public page: name, about, and its products (bounded). */
export async function storeRoute(request: PluginRouteRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const handle = request.subpath.replace(/^\/+|\/+$/g, "");
  const notFound = { status: 404, ...shopPage("Shop not found", { found: false }) };
  if (!HANDLE_PATTERN.test(handle)) return notFound;
  const profile = await profiles(ctx).getByHandle(handle);
  if (!profile || profile.status !== "published") return notFound;
  const seller = await sellers(ctx).get(String(profile.data.seller_id ?? ""));
  if (!seller || seller.status !== "approved") return notFound;
  const owned = await productSellers(ctx).query({ where: { seller_id: String(profile.data.seller_id) }, orderBy: { field: "assigned_at", direction: "desc" }, limit: 12 });
  const products: Extract<SellerShopProps, { found: true }>["products"] = [];
  for (const record of owned.records) {
    const result = await ctx.api.call<{ data?: { name?: string; slug?: string; status?: string; priceMinor?: number; currency?: string; imageUrl?: string | null; deletedAt?: string | null } }>(
      "dashboard.resources.products.get", { path: { id: record.id } });
    const product = result.data?.data;
    if (!result.ok || !product?.slug || !product.name || product.deletedAt || (product.status && product.status !== "active")) continue;
    products.push({
      name: product.name,
      url: `/products/${encodeURIComponent(product.slug)}`,
      price: typeof product.priceMinor === "number" ? money(ctx, product.priceMinor, product.currency ?? ctx.store.currency) : null,
      image: product.imageUrl && /^https?:\/\//.test(product.imageUrl) ? product.imageUrl : null,
    });
  }
  const response = shopPage(seller.name, { found: true, about: seller.about ?? null, products }, seller.about ? plain(seller.about, 300) : `Products sold by ${seller.name}.`);
  return { ...response, headers: { "cache-control": "public, max-age=60" } };
}
