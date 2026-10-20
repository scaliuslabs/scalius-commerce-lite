// Sellers (`scalius.sellers`): a multi-vendor marketplace on one store.
//
// - Accounts: sellers apply from the storefront (`/apps/scalius.sellers/apply`,
//   a signed-in customer) or staff add them; staff approve, suspend or
//   reject them on the app's page. A seller signs in with their customer
//   account and works in the seller portal (`/apps/scalius.sellers/portal`):
//   sales, net, orders with what to ship, "Mark as shipped", payouts.
// - Catalogue: staff give a product to a seller from the product page's
//   card. The seller shows as "by <seller>" on cards (themes that read the
//   public field, Bazaar) and "Sold by" in the buy box (this app's block),
//   and the seller has a public page (`/apps/scalius.sellers/store/<handle>`).
// - Checkout: `cart.validate` refuses lines of a suspended seller, from a
//   declared per-line read (no I/O at checkout).
// - Orders: `order.created` splits the order by seller (the seller's lines,
//   subtotal, the store's commission and the seller's net), notes it on the
//   order's timeline and emails each seller; later order events move the
//   splits. Payouts settle fulfilled splits weekly (cron) or on demand, and
//   staff approve them and record the transfer.
//
// Everything the app stores is in its Objects (sellers, seller profiles,
// product sellers, order splits, payouts); money is integer minor units.

import {
  adminContext,
  definePlugin,
  PLUGIN_API_VERSION,
  readMany,
  ui,
  type PluginContext,
  type PluginManifestInput,
  type PluginRouteRequest,
} from "@scalius/plugin-sdk";
import { assignProduct, createSeller, setSellerStatus } from "./accounts";
import {
  PAYOUT_STATUSES,
  SELLER_STATUSES,
  SPLIT_STATUSES,
  errorCode,
  payouts,
  plain,
  productSellers,
  sellers,
  splits,
  type ProductSeller,
  type SellerStatus,
} from "./model";
import { applyRoute, portalRoute, storeRoute } from "./portal";
import { draftPayouts, moveSplits, setPayoutStatus, splitOrder } from "./splits";

const choices = (values: readonly string[]) => ({ choices: [...values] });

export const manifest = {
  id: "scalius.sellers",
  name: "Sellers",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Turn the store into a marketplace: seller applications and approval, a seller portal with orders, shipping and payouts, products sold by sellers with \"Sold by\" on the product page, orders split per seller with commissions, and weekly payout reports.",
  tagline: "Sellers, order splits, commissions and payouts",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  categories: ["operations", "finances", "orders"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  scopes: ["write_orders", "write_fulfillments", "write_products"],
  events: ["order.created", "order.paid", "order.fulfilled", "order.cancelled", "order.refunded"],
  timeline: [{ kind: "split", title: "Marketplace split" }],
  functions: [{
    point: "cart.validate",
    priority: 20,
    onError: "skip",
    reads: [{ as: "owners", object: "product_sellers", key: "line.productId", max: 50 }],
  }],
  objects: {
    sellers: {
      name: "Sellers",
      description: "Seller accounts and applications.",
      fields: [
        { key: "name", name: "Shop name", type: "single_line_text", required: true },
        { key: "handle", name: "Shop address", type: "single_line_text", required: true },
        { key: "email", name: "Notice email", type: "single_line_text" },
        { key: "customer_id", name: "Customer account", type: "single_line_text" },
        { key: "status", name: "Status", type: "single_line_text", required: true, validations: choices(SELLER_STATUSES) },
        { key: "commission_bps", name: "Commission (basis points)", type: "integer" },
        { key: "about", name: "About", type: "multi_line_text" },
        { key: "created_at", name: "Applied at", type: "integer" },
        { key: "approved_at", name: "Approved at", type: "integer" },
      ],
      display: "name",
      indexes: [["status", "created_at"], "customer_id", "email"],
      unique: ["handle"],
      admin: "read",
    },
    seller_profiles: {
      name: "Seller profiles",
      description: "The public part of an approved seller, for the storefront.",
      fields: [
        { key: "name", name: "Shop name", type: "single_line_text", required: true },
        { key: "about", name: "About", type: "multi_line_text" },
        { key: "seller_id", name: "Seller", type: "single_line_text" },
      ],
      display: "name",
      handle: true,
      storefront: true,
      admin: "read",
    },
    product_sellers: {
      name: "Product sellers",
      description: "Which seller sells a product (record id: the product id).",
      fields: [
        { key: "seller_id", name: "Seller", type: "single_line_text", required: true },
        { key: "seller_name", name: "Seller name", type: "single_line_text", required: true },
        { key: "seller_status", name: "Seller status", type: "single_line_text", validations: choices(SELLER_STATUSES) },
        { key: "assigned_at", name: "Assigned at", type: "integer" },
      ],
      display: "seller_name",
      indexes: [["seller_id", "assigned_at"]],
      admin: "read",
    },
    order_splits: {
      name: "Order splits",
      description: "Each seller's part of an order: lines, subtotal, commission and net.",
      fields: [
        { key: "order_id", name: "Order", type: "single_line_text", required: true },
        { key: "order_number", name: "Order number", type: "integer" },
        { key: "seller_id", name: "Seller", type: "single_line_text", required: true },
        { key: "status", name: "Status", type: "single_line_text", validations: choices(SPLIT_STATUSES) },
        { key: "lines", name: "Lines", type: "json" },
        { key: "item_count", name: "Items", type: "integer" },
        { key: "subtotal_minor", name: "Subtotal (minor units)", type: "integer" },
        { key: "commission_minor", name: "Commission (minor units)", type: "integer" },
        { key: "net_minor", name: "Seller net (minor units)", type: "integer" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "created_at", name: "Placed at", type: "integer" },
        { key: "payout_id", name: "Payout", type: "single_line_text" },
      ],
      display: "order_id",
      indexes: [["seller_id", "created_at"], "order_id", ["seller_id", "payout_id", "created_at"]],
      admin: "read",
    },
    payouts: {
      name: "Seller payouts",
      description: "Settlements of sellers' fulfilled orders.",
      fields: [
        { key: "seller_id", name: "Seller", type: "single_line_text", required: true },
        { key: "period_end", name: "Period to", type: "integer" },
        { key: "gross_minor", name: "Sales (minor units)", type: "integer" },
        { key: "commission_minor", name: "Commission (minor units)", type: "integer" },
        { key: "net_minor", name: "Net (minor units)", type: "integer" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "split_count", name: "Orders", type: "integer" },
        { key: "status", name: "Status", type: "single_line_text", validations: choices(PAYOUT_STATUSES) },
        { key: "created_at", name: "Drafted at", type: "integer" },
        { key: "paid_at", name: "Paid at", type: "integer" },
        { key: "reference", name: "Transfer reference", type: "single_line_text" },
      ],
      indexes: [["seller_id", "created_at"], ["status", "created_at"]],
      admin: "read",
    },
  },
  messaging: { recipients: [{ object: "sellers", field: "email" }] },
  customFields: [
    { ownerType: "product", key: "seller_name", name: "Sold by", type: "single_line_text", storefrontVisible: true, description: "Set by the Sellers app." },
    { ownerType: "product", key: "seller_handle", name: "Seller shop address", type: "single_line_text", storefrontVisible: true, description: "Set by the Sellers app." },
    { ownerType: "product", key: "seller_id", name: "Seller id", type: "single_line_text", description: "Set by the Sellers app." },
  ],
  settings: [
    { key: "default_commission_bps", label: "Commission (basis points)", type: "number", integer: true, min: 0, max: 10000, default: 1000, help: "1000 is 10% of each seller's order subtotal. A seller's own rate wins." },
    { key: "applications_open", label: "Take seller applications", type: "boolean", default: true },
    { key: "payout_hold_days", label: "Days before a fulfilled order is paid out", type: "number", integer: true, min: 0, max: 60, default: 7 },
  ],
  routes: {
    admin: [
      { name: "applications", description: "Seller applications to review." },
      { name: "sellers", description: "Every seller." },
      { name: "payouts", description: "Payouts to review and record." },
      { name: "commissions", description: "Commission and sales by seller." },
      { name: "seller-status", methods: ["POST"], description: "Approves, suspends, reinstates or rejects a seller." },
      { name: "seller-add", methods: ["POST"], description: "Adds an approved seller." },
      { name: "payouts-draft", methods: ["POST"], description: "Drafts payouts of fulfilled orders now." },
      { name: "payout-status", methods: ["POST"], description: "Approves a payout or records it as paid." },
      { name: "product-card", description: "The product's seller." },
      { name: "product-assign", methods: ["POST"], description: "Gives the product to a seller." },
      { name: "order-card", description: "How the order split between sellers." },
    ],
    public: [
      { name: "portal", methods: ["GET", "POST"], description: "The seller portal." },
      { name: "apply", methods: ["GET", "POST"], description: "The seller application." },
      { name: "store", methods: ["GET"], description: "A seller's public page." },
    ],
  },
  cron: [{ name: "payouts", schedule: "0 3 * * 1" }],
  admin: {
    pages: [{
      id: "sellers",
      title: "Sellers",
      route: "applications",
      tabs: [
        { id: "applications", title: "Applications", route: "applications" },
        { id: "sellers", title: "Sellers", route: "sellers" },
        { id: "payouts", title: "Payouts", route: "payouts" },
        { id: "commissions", title: "Commissions", route: "commissions" },
      ],
    }],
    cards: [
      { id: "product_seller", target: "product", title: "Seller", route: "product-card" },
      { id: "order_sellers", target: "order", title: "Sellers", route: "order-card" },
    ],
    listColumns: [
      { id: "seller", resource: "product", title: "Seller", type: "text", source: { kind: "object", object: "product_sellers", field: "seller_name" } },
    ],
  },
  storefront: {
    proxy: true,
    sections: [{
      type: "seller_directory",
      name: "Seller directory",
      description: "The store's approved sellers with links to their pages, and an invitation to apply.",
      settings: [
        { key: "heading", label: "Heading", type: "text", default: "Our sellers", maxLength: 80 },
        { key: "text", label: "Text", type: "textarea", maxLength: 240 },
        { key: "apply_label", label: "Apply link text", type: "text", default: "Sell with us", maxLength: 40 },
      ],
      reads: [{ object: "seller_profiles", limit: 24 }],
    }],
    components: [
      { type: "sold_by", name: "Sold by", targets: ["product.buy_box.before"], settings: [{ key: "label", label: "Label", type: "text", default: "Sold by", maxLength: 30 }] },
      { type: "about_seller", name: "About the seller", targets: ["product.below"], settings: [] },
      // The proxy pages' bodies (src/pages.tsx), drawn from the routes' props.
      { type: "seller_portal", name: "Seller portal", targets: ["page"] },
      { type: "seller_shop", name: "Seller shop page", targets: ["page"] },
    ],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

// ── Dashboard ──────────────────────────────────────────────────────────────

const statusTone = (status: string) => (status === "approved" || status === "paid" || status === "fulfilled" ? "success"
  : status === "pending" || status === "draft" || status === "open" ? "warning"
    : status === "suspended" || status === "rejected" || status === "cancelled" || status === "refunded" ? "critical" : "info") as "success" | "warning" | "critical" | "info";

function bodyOf(request: PluginRouteRequest): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
}

/** The product card's select value for "the store sells it" (select values cannot be empty). */
const STORE_SELLS = "store";

const percent = (bps: number | null) => (bps === null ? "Default" : `${bps / 100}%`);

function sellerRows(records: Array<{ id: string; data: { name: string; handle: string; email: string | null; status: SellerStatus; commission_bps: number | null; created_at: number } }>) {
  return records.map((record) => ({
    id: record.id,
    cells: {
      name: record.data.name,
      handle: record.data.handle,
      email: record.data.email ?? "",
      status: { badge: record.data.status, tone: statusTone(record.data.status) },
      commission: percent(record.data.commission_bps),
      at: { date: new Date(record.data.created_at || 0).toISOString() },
    },
  }));
}

const SELLER_COLUMNS = [
  { key: "name", label: "Shop" }, { key: "handle", label: "Address" }, { key: "email", label: "Email" },
  { key: "status", label: "Status" }, { key: "commission", label: "Commission" }, { key: "at", label: "Applied" },
];

/** Status buttons for one seller (tables carry no buttons: each row's actions are buttons under the table). */
function sellerButtons(id: string, name: string, status: SellerStatus) {
  const button = (label: string, next: SellerStatus, tone?: "critical" | "primary") =>
    ui.button(`${label}: ${name}`.slice(0, 80), ui.route("seller-status", { body: { sellerId: id, status: next } }), {
      ...(tone ? { tone } : {}),
      ...(next === "suspended" || next === "rejected" ? { confirm: { title: `${label} ${name}?`.slice(0, 80), text: next === "suspended" ? "Buyers can no longer check out their products until you reinstate them." : "The application is closed.", confirmLabel: label, destructive: true } } : {}),
    });
  if (status === "pending") return [button("Approve", "approved", "primary"), button("Reject", "rejected", "critical")];
  if (status === "approved") return [button("Suspend", "suspended", "critical")];
  if (status === "suspended") return [button("Reinstate", "approved", "primary")];
  return [];
}

async function applicationsPage(request: PluginRouteRequest, ctx: PluginContext) {
  const page = await sellers(ctx).query({ where: { status: "pending" }, orderBy: { field: "created_at", direction: "asc" }, limit: 25, cursor: adminContext(request).cursor });
  return {
    body: ui.page([
      ui.card("Applications", [
        ui.table({
          columns: SELLER_COLUMNS,
          rows: sellerRows(page.records),
          pagination: { next: page.nextCursor },
          empty: { title: "No applications", text: "Customers apply at /apps/scalius.sellers/apply." },
        }),
        ...page.records.slice(0, 8).flatMap((record) => [ui.stack(sellerButtons(record.id, record.data.name, record.data.status), { direction: "horizontal" })]),
      ]),
    ], { title: "Sellers", description: "Review applications. Approved sellers can be given products and open their seller dashboard." }),
  };
}

async function sellersPage(request: PluginRouteRequest, ctx: PluginContext) {
  const [approved, suspended] = await Promise.all([
    sellers(ctx).query({ where: { status: "approved" }, orderBy: { field: "created_at", direction: "desc" }, limit: 25, cursor: adminContext(request).cursor }),
    sellers(ctx).query({ where: { status: "suspended" }, orderBy: { field: "created_at", direction: "desc" }, limit: 25 }),
  ]);
  const rows = [...approved.records, ...suspended.records];
  return {
    body: ui.page([
      ui.card("Sellers", [
        ui.table({
          columns: SELLER_COLUMNS,
          rows: sellerRows(rows),
          pagination: { next: approved.nextCursor },
          empty: { title: "No sellers yet", text: "Approve an application or add a seller below." },
        }),
        ...rows.slice(0, 8).flatMap((record) => sellerButtons(record.id, record.data.name, record.data.status)),
      ]),
      ui.card("Add a seller", [
        ui.form(ui.route("seller-add"), "Add seller", [
          ui.textField("name", "Shop name", { required: true }),
          ui.textField("handle", "Shop address", { help: "Lower-case letters, digits and dashes. Empty: from the name." }),
          ui.textField("email", "Notice email"),
          ui.numberField("commission", "Commission (basis points)", { help: "Empty: the app's default." }),
        ]),
      ]),
    ], { title: "Sellers" }),
  };
}

async function payoutsPage(request: PluginRouteRequest, ctx: PluginContext) {
  const [drafts, approved, paid] = await Promise.all([
    payouts(ctx).query({ where: { status: "draft" }, orderBy: { field: "created_at", direction: "desc" }, limit: 25, cursor: adminContext(request).cursor }),
    payouts(ctx).query({ where: { status: "approved" }, orderBy: { field: "created_at", direction: "desc" }, limit: 25 }),
    payouts(ctx).query({ where: { status: "paid" }, orderBy: { field: "created_at", direction: "desc" }, limit: 10 }),
  ]);
  const table = (records: typeof drafts.records, title: string) => ui.table({
    caption: title,
    columns: [{ key: "seller", label: "Seller" }, { key: "orders", label: "Orders", align: "end" }, { key: "gross", label: "Sales", align: "end" }, { key: "commission", label: "Commission", align: "end" }, { key: "net", label: "Net", align: "end" }, { key: "status", label: "Status" }, { key: "ref", label: "Reference" }],
    rows: records.map((record) => ({
      id: record.id,
      cells: {
        seller: record.data.seller_id,
        orders: record.data.split_count,
        gross: { money: record.data.gross_minor, currency: record.data.currency },
        commission: { money: record.data.commission_minor, currency: record.data.currency },
        net: { money: record.data.net_minor, currency: record.data.currency },
        status: { badge: record.data.status, tone: statusTone(record.data.status) },
        ref: record.data.reference ?? "",
      },
    })),
    empty: { title: `No ${title.toLowerCase()}` },
  });
  return {
    body: ui.page([
      ui.card("To approve", [
        table(drafts.records, "Draft payouts"),
        ...drafts.records.slice(0, 8).map((record) => ui.button(`Approve ${record.data.seller_id}`.slice(0, 80), ui.route("payout-status", { body: { payoutId: record.id, status: "approved" } }))),
      ]),
      ui.card("To pay", [
        table(approved.records, "Approved payouts"),
        ...approved.records.slice(0, 5).map((record) => ui.form(ui.route("payout-status", { body: { payoutId: record.id, status: "paid" } }), `Record paid: ${record.data.seller_id}`.slice(0, 80), [
          ui.textField("reference", "Transfer reference", { help: "Your bank or wallet transfer id." }),
        ])),
      ]),
      ui.card("Paid", [table(paid.records, "Paid payouts")]),
    ], {
      title: "Payouts",
      description: "Fulfilled orders are drafted into payouts every Monday (after the hold days in the settings). Approve them, transfer the net, then record the transfer.",
      actions: [ui.button("Draft payouts now", ui.route("payouts-draft"), { tone: "primary" })],
    }),
  };
}

async function commissionsPage(_request: PluginRouteRequest, ctx: PluginContext) {
  const approved = await sellers(ctx).query({ where: { status: "approved" }, orderBy: { field: "created_at", direction: "desc" }, limit: 20 });
  const rows = [];
  for (const seller of approved.records) {
    const recent = await splits(ctx).query({ where: { seller_id: seller.id }, orderBy: { field: "created_at", direction: "desc" }, limit: 100 });
    const live = recent.records.filter((record) => record.data.status !== "cancelled" && record.data.status !== "refunded");
    const currency = live[0]?.data.currency ?? ctx.store.currency;
    rows.push({
      id: seller.id,
      cells: {
        seller: seller.data.name,
        orders: live.length,
        gross: { money: live.reduce((sum, record) => sum + record.data.subtotal_minor, 0), currency },
        commission: { money: live.reduce((sum, record) => sum + record.data.commission_minor, 0), currency },
        unpaid: { money: live.filter((record) => !record.data.payout_id).reduce((sum, record) => sum + record.data.net_minor, 0), currency },
      },
    });
  }
  return {
    body: ui.page([
      ui.card("By seller (last 100 orders each)", [ui.table({
        columns: [{ key: "seller", label: "Seller" }, { key: "orders", label: "Orders", align: "end" }, { key: "gross", label: "Sales", align: "end" }, { key: "commission", label: "Commission", align: "end" }, { key: "unpaid", label: "Net not yet paid out", align: "end" }],
        rows,
        empty: { title: "No sales yet" },
      })]),
    ], { title: "Commissions" }),
  };
}

const routes = {
  applications: applicationsPage,
  sellers: sellersPage,
  payouts: payoutsPage,
  commissions: commissionsPage,
  "seller-status": async (request: PluginRouteRequest, ctx: PluginContext) => {
    const body = bodyOf(request);
    const id = plain(body.sellerId, 128);
    const status = plain(body.status, 20) as SellerStatus;
    if (!id || !(SELLER_STATUSES as readonly string[]).includes(status)) return { status: 422, body: ui.result({ toast: { message: "Choose a seller and a status.", tone: "critical" } }) };
    const seller = await setSellerStatus(ctx, id, status);
    if (!seller) return { status: 404, body: ui.result({ toast: { message: "That seller no longer exists.", tone: "critical" } }) };
    if (status === "approved" && seller.email) {
      await ctx.messaging.email({
        to: seller.email,
        subject: plain(`Your shop ${seller.name} is open on ${ctx.store.name}`, 200),
        text: `Your seller application was approved. Open your seller dashboard at ${ctx.store.url ?? ""}/apps/scalius.sellers/portal.`,
        html: `<p>Your seller application was approved.</p><p>Open your seller dashboard from your account on the store.</p>`,
      }).catch((error: unknown) => ctx.log.warn("An approval notice was not sent", { code: errorCode(error) }));
    }
    return { body: ui.result({ toast: `${seller.name}: ${status}.`, refresh: true }) };
  },
  "seller-add": async (request: PluginRouteRequest, ctx: PluginContext) => {
    const { values } = adminContext(request);
    const commission = values.commission === null || values.commission === undefined || values.commission === "" ? null : Number(values.commission);
    const result = await createSeller(ctx, { name: plain(values.name, 80), handle: plain(values.handle, 50), email: plain(values.email, 200) || null, commissionBps: commission }, "approved");
    if (!result.ok) return { status: 422, body: ui.result({ errors: result.errors }) };
    return { body: ui.result({ toast: `${result.seller.name} added.`, refresh: true }) };
  },
  "payouts-draft": async (_request: PluginRouteRequest, ctx: PluginContext) => {
    const hold = Math.max(0, Number(ctx.settings.payout_hold_days ?? 7)) * 86_400_000;
    const drafted = await draftPayouts(ctx, Date.now() - hold, `m${Date.now().toString(36)}`);
    return { body: ui.result({ toast: drafted.length === 0 ? { message: "No fulfilled orders are due for a payout.", tone: "info" } : `Drafted ${drafted.length} payouts.`, refresh: true }) };
  },
  "payout-status": async (request: PluginRouteRequest, ctx: PluginContext) => {
    const body = bodyOf(request);
    const { values } = adminContext(request);
    const id = plain(body.payoutId, 300);
    const status = plain(body.status, 20);
    if (!id || (status !== "approved" && status !== "paid")) return { status: 422, body: ui.result({ toast: { message: "Choose a payout.", tone: "critical" } }) };
    const reference = plain(values.reference, 80) || null;
    if (status === "paid" && !reference) return { status: 422, body: ui.result({ errors: { reference: "Enter the transfer reference." } }) };
    const payout = await setPayoutStatus(ctx, id, status, reference);
    if (!payout) return { status: 404, body: ui.result({ toast: { message: "That payout no longer exists.", tone: "critical" } }) };
    return { body: ui.result({ toast: `Payout ${payout.status}.`, refresh: true }) };
  },
  "product-card": async (request: PluginRouteRequest, ctx: PluginContext) => {
    const { id } = adminContext(request);
    if (!id) return { body: ui.view([ui.text("Open a product to see its seller.")]) };
    const [current, approved] = await Promise.all([
      productSellers(ctx).get(id),
      sellers(ctx).query({ where: { status: "approved" }, orderBy: { field: "created_at", direction: "asc" }, limit: 100 }),
    ]);
    return {
      body: ui.view([
        current
          ? ui.keyValue([{ label: "Sold by", value: current.seller_name }, { label: "Seller status", value: current.seller_status }])
          : ui.text("The store sells this product itself.", { tone: "neutral", size: "sm" }),
        approved.records.length > 0 ? ui.form(ui.route("product-assign"), "Save seller", [
          ui.select("seller", "Seller", [{ value: STORE_SELLS, label: "The store" }, ...approved.records.map((record) => ({ value: record.id, label: record.data.name.slice(0, 80) }))], { value: current?.seller_id ?? STORE_SELLS }),
        ]) : ui.text("Approve a seller to give them products.", { tone: "neutral", size: "sm" }),
      ]),
    };
  },
  "product-assign": async (request: PluginRouteRequest, ctx: PluginContext) => {
    const { id, values } = adminContext(request);
    if (!id) return { status: 422, body: ui.result({ toast: { message: "Open a product first.", tone: "critical" } }) };
    const chosen = plain(values.seller, 128);
    const result = await assignProduct(ctx, id, chosen && chosen !== STORE_SELLS ? chosen : null);
    return { status: result.ok ? 200 : 422, body: ui.result({ toast: { message: result.message, tone: result.ok ? "success" : "critical" }, refresh: result.ok }) };
  },
  "order-card": async (request: PluginRouteRequest, ctx: PluginContext) => {
    const { id } = adminContext(request);
    const page = id ? await splits(ctx).query({ where: { order_id: id }, limit: 20 }) : { records: [] };
    if (page.records.length === 0) return { body: ui.view([ui.text("No seller lines: the store sells everything in this order.", { tone: "neutral", size: "sm" })]) };
    return {
      body: ui.view([ui.table({
        columns: [{ key: "seller", label: "Seller" }, { key: "items", label: "Items", align: "end" }, { key: "net", label: "Seller net", align: "end" }, { key: "commission", label: "Commission", align: "end" }, { key: "status", label: "Status" }],
        rows: page.records.map((record) => ({
          id: record.id,
          cells: {
            seller: record.data.seller_id,
            items: record.data.item_count,
            net: { money: record.data.net_minor, currency: record.data.currency },
            commission: { money: record.data.commission_minor, currency: record.data.currency },
            status: { badge: record.data.status, tone: statusTone(record.data.status) },
          },
        })),
      })]),
    };
  },
};

export default definePlugin({
  manifest,
  events: {
    "order.created": async (event, ctx) => {
      const created = await splitOrder(ctx, event);
      if (created.length > 0) ctx.log.info("Split an order between sellers", { orderId: event.resource.id, sellers: created.length });
    },
    "order.paid": async (event, ctx) => { await moveSplits(ctx, event); },
    "order.fulfilled": async (event, ctx) => { await moveSplits(ctx, event); },
    "order.cancelled": async (event, ctx) => { await moveSplits(ctx, event); },
    "order.refunded": async (event, ctx) => { await moveSplits(ctx, event); },
  },
  functions: {
    // A suspended (or not yet approved) seller's products cannot be bought.
    "cart.validate": ({ cart, reads }) => {
      const owners = readMany<ProductSeller>(reads, "owners");
      const errors = cart.lines.flatMap((line) => {
        const owner = owners[line.productId]?.data;
        return owner && owner.seller_status && owner.seller_status !== "approved"
          ? [{ code: "seller_unavailable", lineId: line.lineId, message: `${line.title.slice(0, 120)} is not available from its seller right now.` }]
          : [];
      });
      return { errors: errors.slice(0, 20) };
    },
  },
  routes: {
    admin: routes,
    public: { portal: portalRoute, apply: applyRoute, store: storeRoute },
  },
  cron: {
    payouts: async (ctx, run) => {
      const hold = Math.max(0, Number(ctx.settings.payout_hold_days ?? 7)) * 86_400_000;
      const drafted = await draftPayouts(ctx, Date.parse(run.scheduledAt) - hold, `c${Date.parse(run.scheduledAt).toString(36)}`);
      if (drafted.length > 0) {
        await ctx.messaging.notifyStaff({ title: "Seller payouts to approve", body: `${drafted.length} payouts are ready for review.`, url: "/admin/apps/scalius.sellers/pages/sellers" }).catch(() => undefined);
      }
    },
  },
});
