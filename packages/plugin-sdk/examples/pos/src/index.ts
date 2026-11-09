// Point of sale (`acme.pos`): an in-person till on the stable app API only
// (app operation names through `ctx.api.call`):
//
// - The app declares its own sales channel, `acme.pos:counter`, so its sales
//   sell from it and from the shops linked to it.
// - `cashiers` (GET) lists who can ring up a sale (`staff.list`, active
//   only): names and roles, never an email or a sign-in.
// - `sell` (POST) rings up a sale: `orders.create` with `pointOfSale` (the
//   shop the goods leave from, the cashier, the tenders), under an
//   Idempotency-Key from the till's own sale id, so a retried tap after a
//   lost response sells nothing twice. The answer is the receipt: the order
//   number, the lines, the total and tax, each tender, the change and the
//   cashier's name.
// - `counters` (GET) lists the shops the till sells from: `inventory_locations.list`
//   filtered to the app's channel, active only.
// - `quote` (POST) prices the basket before money changes hands
//   (`orders.quote`: the same pricing path as the sale, nothing written), with
//   the tenders taken so far: the total, tax, discounts, what is still due and
//   the change. `sell` sends the quoted total as `expectedTotalMinor`, so a
//   price that moved in between is refused rather than charged.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.pos",
  name: "Point of Sale",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Rings up in-person sales at the store's shops.",
  author: { name: "Acme" },
  scopes: ["read_products", "read_orders", "write_orders", "read_staff"],
  salesChannels: [{ id: "counter", name: "Shop counter" }],
  routes: {
    admin: [
      { name: "cashiers", methods: ["GET"], description: "Who can ring up a sale." },
      { name: "counters", methods: ["GET"], description: "The shops this till sells from." },
      { name: "quote", methods: ["POST"], description: "Price a basket before taking money." },
      { name: "sell", methods: ["POST"], description: "Ring up an in-person sale and print its receipt." },
    ],
  },
} satisfies PluginManifestInput;

/** The app's own sales channel (`<app id>:<channel>`). */
export const POS_SALES_CHANNEL_ID = `${manifest.id}:counter`;

type Tender = { via: "cash" | "card_terminal" | "mobile_wallet" | "other"; amountMinor: number; reference?: string | null };
export type SaleInput = {
  /** The till's own id for this sale: retrying it rings up nothing twice. */
  saleId: string;
  locationId: string;
  cashierId?: string;
  buyer: { name: string; phone: string };
  items: Array<{ productId: string; variantId: string; quantity: number }>;
  tenders: Tender[];
  /** The total the cashier was quoted: another total now is refused (`manual_order_total_changed`). */
  expectedTotalMinor?: number;
};
/** A basket to price: a sale without its id or buyer, tenders so far optional. */
export type QuoteInput = Pick<SaleInput, "locationId" | "items"> & { cashierId?: string; tenders?: Tender[] };
/** `orders.quote`'s answer. */
export type SaleQuote = {
  currency: string;
  lines: Array<{ productId: string; variantId: string; title: string; quantity: number; unitPriceMinor: number; totalMinor: number }>;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  pointOfSale: { locationId: string; tenderedMinor: number; changeMinor: number; dueMinor: number } | null;
};

type StaffMember = { id: string; name: string; active: boolean; roles: Array<{ displayName: string }> };
/** An order as the app reads it (`OrderResource`). */
export type SaleOrder = {
  id: string;
  orderNumber: number | null;
  channel: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  salesChannelId: string;
  fulfillmentLocationId: string | null;
  currency: string;
  totalMinor: number;
  taxMinor: number;
  paidMinor: number;
  balanceDueMinor: number;
  lines: Array<{ id: string; variantId: string | null; title: string | null; quantity: number; unitPriceMinor: number; fulfilledQuantity: number }>;
  pointOfSale: { locationId: string; staffMemberId: string | null; tenders: Tender[]; tenderedMinor: number; changeMinor: number } | null;
};

async function cashiers(ctx: PluginContext) {
  const page = await ctx.api.call<{ staffMembers: StaffMember[]; nextCursor: string | null }>("staff.list", { query: { active: "true", limit: 50 } });
  if (!page.ok || !page.data) return { error: page.error?.code ?? `http_${page.status}`, cashiers: [] };
  return { error: null, cashiers: page.data.staffMembers.map((member) => ({ id: member.id, name: member.name, roles: member.roles.map((role) => role.displayName) })) };
}

async function counters(ctx: PluginContext) {
  const page = await ctx.api.call<{ locations: Array<{ id: string; name: string }>; nextCursor: string | null }>("inventory_locations.list", {
    query: { salesChannelId: POS_SALES_CHANNEL_ID, status: "active", limit: 100 },
  });
  if (!page.ok || !page.data) return { error: page.error?.code ?? `http_${page.status}`, counters: [] };
  return { error: null, counters: page.data.locations.map((location) => ({ id: location.id, name: location.name })) };
}

async function quote(ctx: PluginContext, basket: QuoteInput) {
  const priced = await ctx.api.call<{ quote: SaleQuote }>("orders.quote", {
    body: {
      items: basket.items,
      shippingMinor: 0,
      salesChannelId: POS_SALES_CHANNEL_ID,
      pointOfSale: { locationId: basket.locationId, staffMemberId: basket.cashierId ?? null, tenders: basket.tenders ?? [] },
    },
  });
  if (!priced.ok || !priced.data) return { error: priced.error?.code ?? `http_${priced.status}`, quote: null };
  return { error: null, quote: priced.data.quote };
}

async function sell(ctx: PluginContext, sale: SaleInput) {
  const placed = await ctx.api.call<{ order: SaleOrder }>("orders.create", {
    body: {
      contact: sale.buyer,
      items: sale.items,
      shippingMinor: 0,
      salesChannelId: POS_SALES_CHANNEL_ID,
      pointOfSale: { locationId: sale.locationId, staffMemberId: sale.cashierId ?? null, tenders: sale.tenders },
      ...(sale.expectedTotalMinor !== undefined ? { expectedTotalMinor: sale.expectedTotalMinor } : {}),
    },
    idempotencyKey: `acme-pos-sale-${sale.saleId}`,
  });
  if (!placed.ok || !placed.data) return { error: placed.error?.code ?? `http_${placed.status}`, order: null, receipt: null };
  const order = placed.data.order;
  let cashier: string | null = null;
  if (order.pointOfSale?.staffMemberId) {
    const member = await ctx.api.call<{ staffMember: StaffMember }>("staff.get", { path: { id: order.pointOfSale.staffMemberId } });
    cashier = member.ok && member.data ? member.data.staffMember.name : null;
  }
  return {
    error: null,
    order,
    receipt: {
      orderNumber: order.orderNumber,
      currency: order.currency,
      lines: order.lines.map((line) => ({ title: line.title, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor })),
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
      tenders: order.pointOfSale?.tenders ?? [],
      changeMinor: order.pointOfSale?.changeMinor ?? 0,
      cashier,
    },
  };
}

export default definePlugin({
  manifest,
  routes: {
    admin: {
      cashiers: async (_request, ctx) => ({ body: await cashiers(ctx) }),
      counters: async (_request, ctx) => ({ body: await counters(ctx) }),
      quote: async (request, ctx) => {
        const body = (request.body ?? {}) as Partial<QuoteInput>;
        if (!body.locationId || !body.items?.length) return { status: 400, body: { error: "locationId and items are required" } };
        return { body: await quote(ctx, body as QuoteInput) };
      },
      sell: async (request, ctx) => {
        const body = (request.body ?? {}) as Partial<SaleInput>;
        if (!body.saleId || !body.locationId || !body.buyer || !body.items?.length || !body.tenders?.length) {
          return { status: 400, body: { error: "saleId, locationId, buyer, items and tenders are required" } };
        }
        return { body: await sell(ctx, body as SaleInput) };
      },
    },
  },
});
