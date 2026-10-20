// The Sellers app's proxy pages, drawn by the store inside its layout
// (`storefront.components` targeting `page`) from what the public routes
// answer as `props` (src/portal.ts builds them):
//
// - `seller_portal`: the sign-in prompt, the application form, and the
//   seller's dashboard, orders (with a "Mark as shipped" form per split),
//   products and payouts;
// - `seller_shop`: a seller's public page with its products.
//
// The store draws the page title as the h1. Every string is escaped by the
// SDK's JSX. The forms are plain posts to the app's own routes
// (`/apps/scalius.sellers/...`), so they work without JavaScript; the store
// adds its form token.

import { formatDate, formatMoney, type ComponentProps, type Renderable, type StorefrontRenderContext } from "@scalius/plugin-sdk/storefront";

const BASE = "/apps/scalius.sellers";

import type { PageMoney, PagePayout, PageSeller, PageSplit, SellerPortalProps, SellerShopProps } from "./page-props";

export type { PageMoney, PagePayout, PageSeller, PageSplit, SellerPortalProps, SellerShopProps } from "./page-props";

function money(context: StorefrontRenderContext, value: PageMoney): string {
  return formatMoney({ ...context, store: { ...context.store, currency: value.currency } }, value.amount);
}

function day(context: StorefrontRenderContext, at: number): string {
  return formatDate(context, at, { dateStyle: "medium" });
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

const STATUS_WORDS: Record<string, string> = {
  pending: "Your application is being reviewed. We will email you when it is approved.",
  approved: "Your shop is open.",
  suspended: "Your shop is paused: buyers cannot order your products. Contact the store.",
  rejected: "Your application was not approved.",
};

function Status({ seller }: { seller: PageSeller }) {
  return <p class={`sellers-status is-${seller.status}`}>{STATUS_WORDS[seller.status] ?? seller.status}</p>;
}

function SplitTable({ context, rows }: { context: StorefrontRenderContext; rows: PageSplit[] }) {
  if (rows.length === 0) return <p class="sellers-empty">No orders yet.</p>;
  return (
    <table class="sellers-table">
      <thead><tr><th scope="col">Order</th><th scope="col">Placed</th><th scope="col">Items</th><th scope="col">Status</th><th scope="col">Your net</th><th scope="col">Ship</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            <td>{row.order}</td>
            <td>{day(context, row.placedAt)}</td>
            <td><ul class="sellers-lines">{row.lines.map((line) => <li>{line.quantity} x {line.title}</li>)}</ul></td>
            <td>{row.status}</td>
            <td>{money(context, row.net)}</td>
            <td>
              {row.shippable ? (
                <form method="post" action={`${BASE}/portal/ship`} class="sellers-ship">
                  <input type="hidden" name="split" value={row.id} />
                  <label>Courier <input name="courier" maxlength="120" /></label>
                  <label>Tracking number <input name="tracking" maxlength="180" /></label>
                  <button type="submit" class="sellers-button">Mark as shipped</button>
                </form>
              ) : "-"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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

function portalBody(props: SellerPortalProps, context: StorefrontRenderContext): Renderable {
  switch (props.view) {
    case "sign-in":
      return (
        <>
          <p>Sign in to your account to open your seller dashboard or apply to sell.</p>
          <p><a class="sellers-button" href={props.signIn}>Sign in</a></p>
        </>
      );
    case "apply":
      if (!props.open) return <p>The store is not taking new sellers right now.</p>;
      return (
        <>
          {props.errors && Object.keys(props.errors).length > 0 ? null : <p>Open your own shop on {props.storeName}. The store reviews every application.</p>}
          <ApplyForm errors={props.errors} values={props.values} />
        </>
      );
    case "home":
      return (
        <>
          <Status seller={props.seller} />
          <Nav current="home" />
          <dl class="sellers-stats">
            <div><dt>Recent sales</dt><dd>{money(context, props.sales)}</dd></div>
            <div><dt>Your net</dt><dd>{money(context, props.net)}</dd></div>
            <div><dt>To ship</dt><dd>{props.toShipCount}</dd></div>
          </dl>
          <h2>To ship</h2>
          <SplitTable context={context} rows={props.toShip} />
          <p><a href={`${BASE}/store/${props.seller.handle}`}>See your public shop page</a></p>
        </>
      );
    case "orders":
      return (
        <>
          <Nav current="orders" />
          {props.notice === "shipped" ? <p class="sellers-status is-approved" role="status">Marked as shipped.</p> : null}
          {props.notice === "not_shipped" ? <p class="sellers-status is-suspended" role="alert">The shipment could not be recorded. Try again, or contact the store.</p> : null}
          <SplitTable context={context} rows={props.orders} />
          {props.older ? <p><a href={props.older}>Older orders</a></p> : null}
        </>
      );
    case "products":
      return (
        <>
          <Nav current="products" />
          <p>The store lists your products. To add or change one, contact the store: sellers cannot edit the catalogue yet.</p>
          {props.products.length === 0 ? <p class="sellers-empty">No products yet.</p> : (
            <ul class="sellers-list">{props.products.map((product) => <li>{product.name}{product.status ? ` (${product.status})` : ""}</li>)}</ul>
          )}
        </>
      );
    case "payouts":
      return (
        <>
          <Nav current="payouts" />
          {props.payouts.length === 0 ? <p class="sellers-empty">No payouts yet. Fulfilled orders are paid out each week.</p> : (
            <table class="sellers-table">
              <thead><tr><th scope="col">Period to</th><th scope="col">Orders</th><th scope="col">Sales</th><th scope="col">Commission</th><th scope="col">Net</th><th scope="col">Status</th></tr></thead>
              <tbody>{props.payouts.map((payout) => (
                <tr>
                  <td>{day(context, payout.periodEnd)}</td>
                  <td>{payout.orders}</td>
                  <td>{money(context, payout.gross)}</td>
                  <td>{money(context, payout.commission)}</td>
                  <td>{money(context, payout.net)}</td>
                  <td>{payout.status === "paid" && payout.reference ? `paid (${payout.reference})` : payout.status}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      );
  }
}

export function SellerPortal(input: ComponentProps<Record<string, never>, SellerPortalProps>) {
  if (input.target !== "page") return null;
  return <section class="sellers-page">{portalBody(input.props, input.context)}</section>;
}

export function SellerShop(input: ComponentProps<Record<string, never>, SellerShopProps>) {
  if (input.target !== "page") return null;
  const { props, context } = input;
  if (!props.found) return <section class="sellers-page"><p>This shop does not exist or is closed.</p></section>;
  return (
    <section class="sellers-page sellers-shop">
      {props.about ? <p class="sellers-about">{props.about}</p> : null}
      {props.products.length === 0 ? <p class="sellers-empty">No products yet.</p> : (
        <ul class="sellers-products">
          {props.products.map((product) => (
            <li>
              <a href={product.url}>
                {product.image ? <img src={product.image} alt="" loading="lazy" width="240" height="240" /> : null}
                <span class="sellers-product-name">{product.name}</span>
                {product.price ? <span class="sellers-product-price">{money(context, product.price)}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
