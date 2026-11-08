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

async function sell(ctx: PluginContext, sale: SaleInput) {
  const placed = await ctx.api.call<{ order: SaleOrder }>("orders.create", {
    body: {
      contact: sale.buyer,
      items: sale.items,
      shippingMinor: 0,
      salesChannelId: POS_SALES_CHANNEL_ID,
      pointOfSale: { locationId: sale.locationId, staffMemberId: sale.cashierId ?? null, tenders: sale.tenders },
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
