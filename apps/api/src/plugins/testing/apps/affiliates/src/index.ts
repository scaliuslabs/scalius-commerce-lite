// Affiliates (`acme.affiliates`): an affiliate and referral app on the stable
// app API only (app operation names through `ctx.api.call`):
//
// - `affiliates` (POST) gives an affiliate their own discount code: a code
//   discount made with `discounts.create` (under an Idempotency-Key from the
//   affiliate's id, so asking again makes nothing twice) and switched on with
//   `discounts.activate` under the revision it answered.
// - `commission` (GET) pays the affiliate: it walks the orders that redeemed
//   the code (`orders.list` with `discountCode`, page by page) and owes a
//   share, in basis points, of what each order's merchandise sold for after
//   discounts, per currency. A cancelled order earns nothing. It reads the
//   code each order used from the order's own `discountApplications`, never
//   from a buyer's contact details: the app holds no `read_customer_*` scope.

import { definePlugin, PLUGIN_API_VERSION, type PluginApiResult, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.affiliates",
  name: "Affiliates",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Gives each affiliate a discount code and pays them a commission on the orders that used it.",
  author: { name: "Acme" },
  scopes: ["write_discounts", "read_orders"],
  routes: {
    admin: [
      { name: "affiliates", methods: ["POST"], description: "Give an affiliate their discount code." },
      { name: "commission", methods: ["GET"], description: "What an affiliate earned on the orders that used their code." },
    ],
  },
} satisfies PluginManifestInput;

/** The code an affiliate shares: `REF-` and their id, as checkout matches codes (upper case, A-Z, 0-9, - and _). */
export const affiliateCode = (affiliateId: string) => `REF-${affiliateId.toUpperCase().replace(/[^A-Z0-9_-]/gu, "")}`;

type Discount = { id: string; revision: number; status: string };
type DiscountApplication = { code: string | null; method: string; amountMinor: number; shippingAmountMinor: number };
/** An order as the app reads it (`OrderResource`). */
export type AffiliateOrder = {
  id: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  discountApplications: DiscountApplication[];
};
type OrderPage = { orders: AffiliateOrder[]; nextCursor: string | null };

async function createCode(ctx: PluginContext, affiliateId: string, percentOff: number) {
  const code = affiliateCode(affiliateId);
  const created = await ctx.api.call<{ discount: Discount }>("discounts.create", {
    body: {
      name: `Affiliate ${affiliateId}`,
      method: "code",
      codes: [{ code }],
      effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: percentOff * 100 } }],
    },
    idempotencyKey: `acme-affiliates-code-${affiliateId}`,
  });
  if (!created.ok || !created.data) return { code, discountId: null, status: null, error: created.error?.code ?? `http_${created.status}` };
  let discount = created.data.discount;
  if (discount.status !== "active") {
    const activated = await ctx.api.call<{ discount: Discount }>("discounts.activate", {
      path: { id: discount.id },
      body: { expectedRevision: discount.revision },
      idempotencyKey: `acme-affiliates-activate-${discount.id}-${discount.revision}`,
    });
    if (!activated.ok || !activated.data) return { code, discountId: discount.id, status: discount.status, error: activated.error?.code ?? `http_${activated.status}` };
    discount = activated.data.discount;
  }
  return { code, discountId: discount.id, status: discount.status, error: null };
}

async function commission(ctx: PluginContext, code: string, rateBps: number, pageSize: number) {
  const orderIds: string[] = [];
  const owed: Record<string, number> = {};
  let pages = 0;
  let cursor: string | null = null;
  do {
    const page: PluginApiResult<OrderPage> = await ctx.api.call<OrderPage>("orders.list", {
      query: { discountCode: code, limit: pageSize, ...(cursor ? { cursor } : {}) },
    });
    if (!page.ok || !page.data) return { code, error: page.error?.code ?? `http_${page.status}`, orderIds, pages, owedMinor: owed };
    pages += 1;
    for (const order of page.data.orders) {
      // The order says which codes it used: count only an order that used this one.
      if (!order.discountApplications.some((application) => application.method === "code" && application.code === code)) continue;
      orderIds.push(order.id);
      if (order.status === "cancelled") continue;
      const base = Math.max(0, order.subtotalMinor - order.discountMinor);
      owed[order.currency] = (owed[order.currency] ?? 0) + Math.floor((base * rateBps) / 10_000);
    }
    cursor = page.data.nextCursor;
  } while (cursor);
  return { code, error: null, orderIds, pages, owedMinor: owed };
}

export default definePlugin({
  manifest,
  routes: {
    admin: {
      affiliates: async (request, ctx) => {
        const body = (request.body ?? {}) as { affiliateId?: string; percentOff?: number };
        if (!body.affiliateId) return { status: 400, body: { error: "affiliateId is required" } };
        return { body: await createCode(ctx, body.affiliateId, body.percentOff ?? 10) };
      },
      commission: async (request, ctx) => {
        const query = request.query as Record<string, string | undefined>;
        if (!query.code) return { status: 400, body: { error: "code is required" } };
        return { body: await commission(ctx, query.code, Number(query.rateBps ?? 1_000), Number(query.pageSize ?? 50)) };
      },
    },
  },
});
