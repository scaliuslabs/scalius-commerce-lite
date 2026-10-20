// The seller portal and the public seller pages, drawn as storefront proxy
// pages (`/apps/scalius.sellers/...`, in the store's layout):
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
import { formatDate, formatMoney, toHtml, type Renderable } from "@scalius/plugin-sdk/storefront";
import { createSeller, sellerOfCustomer } from "./accounts";
import { HANDLE_PATTERN, plain, productSellers, profiles, sellers, splits, payouts, type OrderSplit, type Seller } from "./model";

const BASE = "/apps/scalius.sellers";
/** The core account page, where a guest signs in (proxy pages get no route map: a platform gap, see BURST-NOTES). */
const ACCOUNT = "/account";

function view(ctx: PluginContext) {
  const language = ctx.store.locale.split("-")[0] || "en";
  return { store: { name: ctx.store.name, currency: ctx.store.currency, locale: ctx.store.locale, language, timeZone: ctx.store.timezone } };
}

/** Integer minor units as the store writes money. */
function money(ctx: PluginContext, minor: number, currency: string): string {
  const context = view(ctx);
  return formatMoney({ store: { ...context.store, currency } }, minor / 10 ** ctx.store.decimalPlaces);
}

function day(ctx: PluginContext, at: number): string {
  return formatDate(view(ctx), at, { dateStyle: "medium" });
}

function page(title: string, body: Renderable, description?: string): PluginRouteResponse {
  return { headers: { "cache-control": "no-store" }, body: { page: { title, ...(description ? { description } : {}), html: toHtml(body).value } } };
}

function Nav({ current }: { current: string }) {
  const links = [
    { id: "home", label: "Dashboard", href: `${BASE}/portal` },
    { id: "orders", label: "Orders", href: `${BASE}/portal/orders` },
    { id: "products", label: "Products", href: `${BASE}/portal/products` },
    { id: "payouts", label: "Payouts", href: `${BASE}/portal/payouts` },
  ];
  return (
    <nav class="sellers-nav" aria-label="Seller dashboard">
      <ul>{links.map((link) => <li><a href={link.href} aria-current={link.id === current ? "page" : undefined}>{link.label}</a></li>)}</ul>
    </nav>
  );
}

function SignIn() {
  return page("Seller dashboard", (
    <section class="sellers-page">
      <h1>Seller dashboard</h1>
      <p>Sign in to your account to open your seller dashboard or apply to sell.</p>
      <p><a class="sellers-button" href={ACCOUNT}>Sign in</a></p>
    </section>
  ));
}

function Status({ seller }: { seller: Seller }) {
  const words: Record<string, string> = {
    pending: "Your application is being reviewed. We will email you when it is approved.",
    approved: "Your shop is open.",
    suspended: "Your shop is paused: buyers cannot order your products. Contact the store.",
    rejected: "Your application was not approved.",
  };
  return <p class={`sellers-status is-${seller.status}`}>{words[seller.status] ?? seller.status}</p>;
}

function SplitTable({ ctx, rows, shipping }: { ctx: PluginContext; rows: Array<{ id: string; data: OrderSplit }>; shipping: boolean }) {
  if (rows.length === 0) return <p class="sellers-empty">No orders yet.</p>;
  return (
    <table class="sellers-table">
      <thead><tr><th scope="col">Order</th><th scope="col">Placed</th><th scope="col">Items</th><th scope="col">Status</th><th scope="col">Your net</th>{shipping ? <th scope="col">Ship</th> : null}</tr></thead>
      <tbody>
        {rows.map(({ id, data }) => (
          <tr>
            <td>{data.order_number ?? data.order_id}</td>
            <td>{day(ctx, data.created_at)}</td>
            <td><ul class="sellers-lines">{data.lines.map((line) => <li>{line.quantity} x {line.title}</li>)}</ul></td>
            <td>{data.status}</td>
            <td>{money(ctx, data.net_minor, data.currency)}</td>
            {shipping ? (
              <td>
                {data.status === "open" || data.status === "paid" ? (
                  <form method="post" action={`${BASE}/portal/ship`} class="sellers-ship">
                    <input type="hidden" name="split" value={id} />
                    <label>Courier <input name="courier" maxlength="120" /></label>
                    <label>Tracking number <input name="tracking" maxlength="180" /></label>
                    <button type="submit" class="sellers-button">Mark as shipped</button>
                  </form>
                ) : "-"}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function dashboard(ctx: PluginContext, id: string, seller: Seller) {
  const recent = await splits(ctx).query({ where: { seller_id: id }, orderBy: { field: "created_at", direction: "desc" }, limit: 50 });
  const live = recent.records.filter((record) => record.data.status !== "cancelled" && record.data.status !== "refunded");
  const currency = live[0]?.data.currency ?? ctx.store.currency;
  const sales = live.reduce((sum, record) => sum + record.data.subtotal_minor, 0);
  const net = live.reduce((sum, record) => sum + record.data.net_minor, 0);
  const toShip = live.filter((record) => record.data.status === "open" || record.data.status === "paid");
  return page(`${seller.name}: seller dashboard`, (
    <section class="sellers-page">
      <h1>{seller.name}</h1>
      <Status seller={seller} />
      <Nav current="home" />
      <dl class="sellers-stats">
        <div><dt>Recent sales</dt><dd>{money(ctx, sales, currency)}</dd></div>
        <div><dt>Your net</dt><dd>{money(ctx, net, currency)}</dd></div>
        <div><dt>To ship</dt><dd>{toShip.length}</dd></div>
      </dl>
      <h2>To ship</h2>
      <SplitTable ctx={ctx} rows={toShip.slice(0, 10)} shipping />
      <p><a href={`${BASE}/store/${seller.handle}`}>See your public shop page</a></p>
    </section>
  ));
}

async function ordersPage(ctx: PluginContext, id: string, seller: Seller, cursor: string | null) {
  const page_ = await splits(ctx).query({ where: { seller_id: id }, orderBy: { field: "created_at", direction: "desc" }, limit: 25, cursor });
  return page(`${seller.name}: orders`, (
    <section class="sellers-page">
      <h1>Orders</h1>
      <Nav current="orders" />
      <SplitTable ctx={ctx} rows={page_.records} shipping />
      {page_.nextCursor ? <p><a href={`${BASE}/portal/orders?cursor=${encodeURIComponent(page_.nextCursor)}`}>Older orders</a></p> : null}
    </section>
  ));
}

async function productsPage(ctx: PluginContext, id: string, seller: Seller) {
  const owned = await productSellers(ctx).query({ where: { seller_id: id }, orderBy: { field: "assigned_at", direction: "desc" }, limit: 50 });
  return page(`${seller.name}: products`, (
    <section class="sellers-page">
      <h1>Products</h1>
      <Nav current="products" />
      <p>The store lists your products. To add or change one, contact the store: sellers cannot edit the catalogue yet.</p>
      {owned.records.length === 0 ? <p class="sellers-empty">No products yet.</p> : (
        <ul class="sellers-list">{owned.records.map((record) => <li>{record.id}</li>)}</ul>
      )}
    </section>
  ));
}

async function payoutsPage(ctx: PluginContext, id: string, seller: Seller) {
  const page_ = await payouts(ctx).query({ where: { seller_id: id }, orderBy: { field: "created_at", direction: "desc" }, limit: 25 });
  return page(`${seller.name}: payouts`, (
    <section class="sellers-page">
      <h1>Payouts</h1>
      <Nav current="payouts" />
      {page_.records.length === 0 ? <p class="sellers-empty">No payouts yet. Fulfilled orders are paid out each week.</p> : (
        <table class="sellers-table">
          <thead><tr><th scope="col">Period to</th><th scope="col">Orders</th><th scope="col">Sales</th><th scope="col">Commission</th><th scope="col">Net</th><th scope="col">Status</th></tr></thead>
          <tbody>{page_.records.map(({ data }) => (
            <tr>
              <td>{day(ctx, data.period_end)}</td>
              <td>{data.split_count}</td>
              <td>{money(ctx, data.gross_minor, data.currency)}</td>
              <td>{money(ctx, data.commission_minor, data.currency)}</td>
              <td>{money(ctx, data.net_minor, data.currency)}</td>
              <td>{data.status === "paid" && data.reference ? `paid (${data.reference})` : data.status}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  ));
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
  if (!customerId) return SignIn();
  const mine = await sellerOfCustomer(ctx, customerId);
  if (!mine) return { body: { redirect: `${BASE}/apply` } };
  const section = request.subpath.replace(/^\/+|\/+$/g, "");
  if (request.method === "POST") {
    if (section === "ship" && mine.seller.status === "approved") return ship(ctx, request, mine.id);
    return { body: { redirect: `${BASE}/portal` } };
  }
  if (section === "orders") return ordersPage(ctx, mine.id, mine.seller, request.query.cursor ?? null);
  if (section === "products") return productsPage(ctx, mine.id, mine.seller);
  if (section === "payouts") return payoutsPage(ctx, mine.id, mine.seller);
  return dashboard(ctx, mine.id, mine.seller);
}

function ApplyForm({ errors = {}, values = {} }: { errors?: Record<string, string>; values?: Record<string, string> }) {
  const field = (name: string, label: string, input: Renderable) => (
    <p class="sellers-field">
      <label for={`sellers-${name}`}>{label}</label>
      {input}
      {errors[name] ? <span class="sellers-error" role="alert">{errors[name]}</span> : null}
    </p>
  );
  return (
    <form method="post" action={`${BASE}/apply`} class="sellers-form">
      {field("name", "Shop name", <input id="sellers-name" name="name" required maxlength="80" value={values.name ?? ""} />)}
      {field("handle", "Shop address (letters, digits and dashes)", <input id="sellers-handle" name="handle" maxlength="50" pattern="[a-z0-9-]+" value={values.handle ?? ""} />)}
      {field("email", "Email for order notices", <input id="sellers-email" name="email" type="email" required maxlength="200" value={values.email ?? ""} />)}
      {field("about", "About your shop", <textarea id="sellers-about" name="about" maxlength="600" rows="4">{values.about ?? ""}</textarea>)}
      <button type="submit" class="sellers-button">Apply to sell</button>
    </form>
  );
}

export async function applyRoute(request: PluginRouteRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const customerId = request.customer?.id ?? null;
  if (!customerId) return SignIn();
  const mine = await sellerOfCustomer(ctx, customerId);
  if (mine) return { body: { redirect: `${BASE}/portal` } };
  if (ctx.settings.applications_open === false) {
    return page("Sell with us", <section class="sellers-page"><h1>Sell with us</h1><p>The store is not taking new sellers right now.</p></section>);
  }
  if (request.method !== "POST") {
    return page("Sell with us", (
      <section class="sellers-page">
        <h1>Sell with us</h1>
        <p>Open your own shop on {ctx.store.name}. The store reviews every application.</p>
        <ApplyForm />
      </section>
    ));
  }
  const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const values = { name: plain(body.name, 80), handle: plain(body.handle, 50), email: plain(body.email, 200), about: plain(body.about, 600) };
  const result = await createSeller(ctx, { ...values, customerId }, "pending");
  if (!result.ok) {
    return { status: 422, ...page("Sell with us", <section class="sellers-page"><h1>Sell with us</h1><ApplyForm errors={result.errors} values={values} /></section>) };
  }
  await ctx.messaging.notifyStaff({ title: "A new seller applied", body: `${result.seller.name} wants to sell on the store.`, url: "/admin/apps/scalius.sellers/pages/sellers" })
    .catch(() => undefined);
  return { body: { redirect: `${BASE}/portal` } };
}

/** The seller's public page: name, about, and its products (bounded). */
export async function storeRoute(request: PluginRouteRequest, ctx: PluginContext): Promise<PluginRouteResponse> {
  const handle = request.subpath.replace(/^\/+|\/+$/g, "");
  const notFound = { status: 404, ...page("Shop not found", <section class="sellers-page"><h1>Shop not found</h1><p>This shop does not exist or is closed.</p></section>) };
  if (!HANDLE_PATTERN.test(handle)) return notFound;
  const profile = await profiles(ctx).getByHandle(handle);
  if (!profile || profile.status !== "published") return notFound;
  const seller = await sellers(ctx).get(String(profile.data.seller_id ?? ""));
  if (!seller || seller.status !== "approved") return notFound;
  const owned = await productSellers(ctx).query({ where: { seller_id: String(profile.data.seller_id) }, orderBy: { field: "assigned_at", direction: "desc" }, limit: 12 });
  const products: Array<{ name: string; url: string; price: string; image: string | null }> = [];
  for (const record of owned.records) {
    const result = await ctx.api.call<{ data?: { name?: string; slug?: string; status?: string; priceMinor?: number; currency?: string; imageUrl?: string | null; deletedAt?: string | null } }>(
      "dashboard.resources.products.get", { path: { id: record.id } });
    const product = result.data?.data;
    if (!result.ok || !product?.slug || !product.name || product.deletedAt || (product.status && product.status !== "active")) continue;
    products.push({
      name: product.name,
      url: `/products/${product.slug}`,
      price: typeof product.priceMinor === "number" ? money(ctx, product.priceMinor, product.currency ?? ctx.store.currency) : "",
      image: product.imageUrl && /^https?:\/\//.test(product.imageUrl) ? product.imageUrl : null,
    });
  }
  const response = page(seller.name, (
    <section class="sellers-page sellers-shop">
      <h1>{seller.name}</h1>
      {seller.about ? <p class="sellers-about">{seller.about}</p> : null}
      {products.length === 0 ? <p class="sellers-empty">No products yet.</p> : (
        <ul class="sellers-products">
          {products.map((product) => (
            <li>
              <a href={product.url}>
                {product.image ? <img src={product.image} alt="" loading="lazy" width="240" height="240" /> : null}
                <span class="sellers-product-name">{product.name}</span>
                {product.price ? <span class="sellers-product-price">{product.price}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  ), seller.about ? plain(seller.about, 300) : `Products sold by ${seller.name}.`);
  return { ...response, headers: { "cache-control": "public, max-age=60" } };
}
