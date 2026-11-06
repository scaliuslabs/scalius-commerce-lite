// Protection Plans (`scaliuslabs.protection`): a buyer adds a one- or
// two-year protection plan to an item the merchant marked eligible, the plan
// is priced as a share of the item, and every plan sold becomes a coverage
// record staff can look up when a claim comes in.
//
// - The plan is the app's own line input (`checkout.lineInputs`, a select
//   under `scaliuslabs.protection.plan`), shown only on products whose
//   `eligible` flag (the app's own storefront-visible product field) is on.
//   It shares the line with any other app's input or purchase option: a
//   subscription priced by another app keeps its price and takes the plan
//   as an add-on.
// - `cart.line_prices` prices the plan as an add-on; `cart.validate` refuses
//   a plan on a product that is not eligible (the flag is read with a
//   declared read, so a forged plan never sells).
// - On `order.created` the app reads the order back (`orders.get`): its own
//   plan answers, its own add-ons (what the buyer paid for each plan) and the
//   discounts that applied to each line (what the covered item really cost),
//   and records one coverage per protected line. Delivery is at least once:
//   a coverage is keyed by its order line.
import { adminContext, adminLocale, defineManifest, definePlugin, PLUGIN_API_VERSION, ui, type PluginAdminLocale, type PluginContextOf } from "@scalius/plugin-sdk";

export const APP_ID = "scaliuslabs.protection";
/** The key the plan travels under on a line and an order. */
export const PLAN_KEY = `${APP_ID}.plan`;
export const PLANS = { one_year: { years: 1, setting: "one_year_percent" }, two_years: { years: 2, setting: "two_years_percent" } } as const;
export type PlanId = keyof typeof PLANS;

export const manifest = defineManifest({
  id: APP_ID,
  name: "Protection Plans",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sell one- and two-year protection plans on the products you choose, priced as a share of the item, with a coverage record for every plan sold.",
  author: { name: "Scalius Labs" },
  tagline: "Protection plans on the items you choose",
  categories: ["checkout", "support"],
  scopes: ["read_orders"],
  events: ["order.created"],
  settings: [
    { key: "one_year_percent", label: "1-year plan price (% of the item)", type: "number", default: 8 },
    { key: "two_years_percent", label: "2-year plan price (% of the item)", type: "number", default: 12 },
  ],
  customFields: [
    {
      ownerType: "product",
      key: "eligible",
      name: "Protection plans offered",
      type: "boolean",
      description: "Buyers can add a protection plan to this product.",
      storefrontVisible: true,
    },
  ],
  functions: [
    { point: "cart.line_prices", priority: 300, reads: [{ as: "flags", customFields: ["product:eligible"] }] },
    { point: "cart.validate", priority: 300, reads: [{ as: "flags", customFields: ["product:eligible"] }] },
  ],
  checkout: {
    lineInputs: [{
      key: "plan",
      label: "Protection plan",
      type: "select",
      options: [{ value: "one_year", label: "1 year" }, { value: "two_years", label: "2 years" }],
      help: "Covers accidental damage and defects. Leave it empty for no plan.",
      products: { customField: "eligible" },
    }],
  },
  objects: {
    coverages: {
      name: "Coverages",
      admin: "read",
      fields: [
        { key: "order_id", name: "Order", type: "order_reference", required: true },
        { key: "order_number", name: "Order number", type: "integer" },
        { key: "order_item_id", name: "Order line", type: "single_line_text", required: true },
        { key: "product_id", name: "Product", type: "single_line_text" },
        { key: "title", name: "Item", type: "single_line_text" },
        { key: "plan", name: "Plan", type: "single_line_text", required: true },
        { key: "quantity", name: "Units covered", type: "integer" },
        /** What the buyer paid for the plans of the line, in minor units of `currency`. */
        { key: "plan_paid_minor", name: "Plan paid", type: "integer" },
        /** What one covered unit cost after the order's discounts, in minor units of `currency`. */
        { key: "covered_unit_minor", name: "Covered value per unit", type: "integer" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "starts_at", name: "Starts", type: "date_time" },
        { key: "ends_at", name: "Ends", type: "date_time" },
      ],
      indexes: ["order_id", "order_number"],
    },
  },
  routes: {
    admin: [
      { name: "coverages", methods: ["GET"], description: "Every coverage sold, newest order first." },
      { name: "order_coverage", methods: ["GET"], description: "The coverages of one order." },
      { name: "product_plans", methods: ["GET"], description: "Whether a product offers protection plans." },
      { name: "set_eligible", methods: ["POST"], description: "Offer or stop offering protection plans on products." },
    ],
    public: [],
    webhooks: [],
  },
  admin: {
    pages: [{ id: "coverages", title: "Protection plans", route: "coverages", placement: "orders" }],
    cards: [
      { id: "order_coverage", target: "order", title: "Protection plans", route: "order_coverage" },
      { id: "product_plans", target: "product", title: "Protection plans", route: "product_plans" },
    ],
    actions: [
      { id: "offer_plans", target: "product", label: "Offer protection plans", route: "set_eligible", bulk: true },
      { id: "stop_plans", target: "product", label: "Stop offering protection plans", route: "set_eligible", bulk: true },
    ],
  },
});

type Context = PluginContextOf<typeof manifest>;
type Settings = { one_year_percent?: number | null; two_years_percent?: number | null };

function isPlan(value: unknown): value is PlanId {
  return value === "one_year" || value === "two_years";
}

/** A plan's price for one unit: its percentage of the unit price, rounded to minor units; 0 when the merchant set none. */
export function planPriceMinor(plan: PlanId, unitPriceMinor: number, settings: Settings): number {
  const percent = Number(settings[PLANS[plan].setting] ?? 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.round((unitPriceMinor * percent) / 100);
}

type Flags = Record<string, { data: { eligible?: unknown } }>;
const eligibleOf = (reads: Record<string, unknown>, productId: string) => (reads.flags as Flags | undefined)?.[productId]?.data.eligible === true;

/** The parts of the order representation the app reads (`orders.get`). */
interface OrderRead {
  id: string;
  orderNumber: number | null;
  currency: string;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string;
    title: string | null;
    variantLabel: string | null;
    quantity: number;
    unitPriceMinor: number;
    properties: Array<{ key: string; value: string; appId: string | null }>;
    adjustments: Array<{ appId: string | null; title: string; amountMinor: number }>;
  }>;
  discountApplications: Array<{ lines: Array<{ orderItemId: string; amountMinor: number }> }>;
}

export interface Coverage extends Record<string, unknown> {
  order_id: string;
  order_number: number | null;
  order_item_id: string;
  product_id: string;
  title: string;
  plan: PlanId;
  quantity: number;
  plan_paid_minor: number;
  covered_unit_minor: number;
  currency: string;
  starts_at: string;
  ends_at: string;
}

/** One coverage per protected line of the order, from what the order says the buyer chose and paid. */
export function coveragesOf(order: OrderRead): Coverage[] {
  const discountByLine = new Map<string, number>();
  for (const application of order.discountApplications) {
    for (const line of application.lines) discountByLine.set(line.orderItemId, (discountByLine.get(line.orderItemId) ?? 0) + line.amountMinor);
  }
  const startsAt = new Date(order.createdAt);
  return order.lines.flatMap((line): Coverage[] => {
    const plan = line.properties.find((property) => property.appId === APP_ID && property.key === PLAN_KEY)?.value;
    if (!isPlan(plan) || line.quantity <= 0) return [];
    const planPerUnit = line.adjustments.filter((adjustment) => adjustment.appId === APP_ID).reduce((total, adjustment) => total + adjustment.amountMinor, 0);
    const endsAt = new Date(startsAt);
    endsAt.setUTCFullYear(endsAt.getUTCFullYear() + PLANS[plan].years);
    // The item's own price: the unit price less the plan, less its share of the order's discounts.
    const itemUnit = line.unitPriceMinor - planPerUnit;
    return [{
      order_id: order.id,
      order_number: order.orderNumber,
      order_item_id: line.id,
      product_id: line.productId,
      title: [line.title ?? "Item", line.variantLabel].filter(Boolean).join(" · "),
      plan,
      quantity: line.quantity,
      plan_paid_minor: planPerUnit * line.quantity,
      covered_unit_minor: Math.max(0, itemUnit - Math.floor((discountByLine.get(line.id) ?? 0) / line.quantity)),
      currency: order.currency,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    }];
  });
}

const COPY = {
  en: {
    item: "Item", plan: "Plan", units: "Units", paid: "Plan paid", covered: "Covered value", ends: "Ends", order: "Order",
    plans: { one_year: "1 year", two_years: "2 years" },
    none: "No protection plan on this order.",
    emptyTitle: "No plans sold yet", emptyText: "Offer plans on your products (Products → select → Offer protection plans), and buyers can add one to them.",
    title: "Protection plans", description: "Every plan sold, with what it covers and until when.",
    offered: "Buyers can add a protection plan to this product.", notOffered: "This product offers no protection plan.",
    offer: "Offer protection plans", stop: "Stop offering", saved: "Saved for {n} product(s).", select: "Select at least one product.",
  },
  bn: {
    item: "পণ্য", plan: "প্ল্যান", units: "সংখ্যা", paid: "প্ল্যানের দাম", covered: "কভার মূল্য", ends: "শেষ", order: "অর্ডার",
    plans: { one_year: "১ বছর", two_years: "২ বছর" },
    none: "এই অর্ডারে কোনো প্রোটেকশন প্ল্যান নেই।",
    emptyTitle: "এখনও কোনো প্ল্যান বিক্রি হয়নি", emptyText: "পণ্যে প্ল্যান চালু করুন (পণ্য → বেছে নিন → প্রোটেকশন প্ল্যান চালু করুন), তাহলে ক্রেতারা প্ল্যান যোগ করতে পারবেন।",
    title: "প্রোটেকশন প্ল্যান", description: "বিক্রি হওয়া প্রতিটি প্ল্যান, কী কভার করে এবং কতদিন।",
    offered: "ক্রেতারা এই পণ্যে প্রোটেকশন প্ল্যান যোগ করতে পারবেন।", notOffered: "এই পণ্যে কোনো প্রোটেকশন প্ল্যান নেই।",
    offer: "প্রোটেকশন প্ল্যান চালু করুন", stop: "বন্ধ করুন", saved: "{n}টি পণ্যে সংরক্ষিত হয়েছে।", select: "অন্তত একটি পণ্য বেছে নিন।",
  },
} satisfies Record<PluginAdminLocale, unknown>;

type CoverageRecord = { id: string; data: { [K in keyof Coverage]?: (K extends "plan" ? string : Coverage[K]) | null } };

function coverageTable(records: readonly CoverageRecord[], copy: (typeof COPY)[PluginAdminLocale], withOrder: boolean) {
  return ui.table({
    columns: [
      ...(withOrder ? [{ key: "order", label: copy.order }] : []),
      { key: "item", label: copy.item },
      { key: "plan", label: copy.plan },
      { key: "units", label: copy.units, align: "end" as const },
      { key: "paid", label: copy.paid, align: "end" as const },
      { key: "covered", label: copy.covered, align: "end" as const },
      { key: "ends", label: copy.ends },
    ],
    rows: records.map(({ id, data }) => ({
      id,
      cells: {
        ...(withOrder ? { order: { text: data.order_number ? `#${data.order_number}` : String(data.order_id ?? id), to: { kind: "resource" as const, resource: "order" as const, id: String(data.order_id) } } } : {}),
        item: data.title ?? "",
        plan: isPlan(data.plan) ? copy.plans[data.plan] : null,
        units: data.quantity ?? 0,
        paid: { amountMinor: data.plan_paid_minor ?? 0, currency: data.currency ?? "BDT" },
        covered: { amountMinor: data.covered_unit_minor ?? 0, currency: data.currency ?? "BDT" },
        ends: data.ends_at ? { date: data.ends_at } : null,
      },
    })),
    empty: { title: copy.emptyTitle, text: copy.emptyText },
  });
}

export default definePlugin({
  manifest,

  functions: {
    // The plan is an add-on to each unit, on an eligible product only.
    "cart.line_prices": ({ cart, reads }, settings) => ({
      prices: [],
      adjustments: cart.lines.flatMap((line) => {
        const plan = line.properties[PLAN_KEY];
        if (!isPlan(plan) || !eligibleOf(reads, line.productId)) return [];
        const amountMinor = planPriceMinor(plan, line.unitPriceMinor, settings);
        return amountMinor > 0 ? [{ lineId: line.lineId, amountMinor, title: plan === "one_year" ? "1-year protection plan" : "2-year protection plan" }] : [];
      }),
    }),
    // A plan on a product the merchant did not mark eligible never sells.
    "cart.validate": ({ cart, reads }) => ({
      errors: cart.lines.flatMap((line) => isPlan(line.properties[PLAN_KEY]) && !eligibleOf(reads, line.productId)
        ? [{ code: "protection_unavailable", message: "A protection plan isn't offered for this item. Remove the plan to continue.", lineId: line.lineId }]
        : []),
    }),
  },

  events: {
    "order.created": async (event, ctx) => {
      const read = await ctx.api.call<{ order: OrderRead }>("orders.get", { path: { id: event.resource.id } });
      if (!read.ok || !read.data?.order) throw new Error(`orders.get failed: ${read.error?.code ?? read.status}`);
      const coverages = coveragesOf(read.data.order);
      if (coverages.length === 0) return;
      // Keyed by the order line: a redelivered event writes the same coverages again, in one batch.
      await ctx.objects.batch(coverages.map((coverage) => ({ op: "put" as const, object: "coverages", id: `${coverage.order_id}:${coverage.order_item_id}`, record: coverage })));
    },
  },

  routes: {
    admin: {
      coverages: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { records, nextCursor } = await ctx.objects.coverages.query({ orderBy: { field: "order_number", direction: "desc" }, limit: 25, cursor: adminContext(request).cursor });
        const table = coverageTable(records, copy, true);
        return { body: ui.page([{ ...table, pagination: { next: nextCursor } } as typeof table], { title: copy.title, description: copy.description }) };
      },
      // The flag the buy form reads: the merchant turns it on here, the app writes its own field.
      product_plans: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { id } = adminContext(request);
        const offered = id ? (await ctx.customFields.get("product", id)).eligible === true : false;
        return {
          body: ui.view([
            ui.text(offered ? copy.offered : copy.notOffered),
            ...(id ? [ui.button(offered ? copy.stop : copy.offer, ui.route("set_eligible", { body: { ids: [id], offer: !offered } }), { tone: offered ? "secondary" : "primary" })] : []),
          ]),
        };
      },
      set_eligible: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { ids, action } = adminContext(request);
        const body = (request.body ?? {}) as { offer?: unknown };
        const offer = action === "offer_plans" || (action === null && body.offer === true);
        if (ids.length === 0) return { status: 422, body: ui.result({ toast: { message: copy.select, tone: "critical" } }) };
        for (const productId of ids) await ctx.customFields.set("product", productId, { eligible: offer });
        return { body: ui.result({ toast: copy.saved.replace("{n}", String(ids.length)), refresh: true }) };
      },
      order_coverage: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { id } = adminContext(request);
        const { records } = id ? await ctx.objects.coverages.query({ where: { order_id: id }, limit: 50 }) : { records: [] };
        if (records.length === 0) return { body: ui.view([ui.text(copy.none)]) };
        return { body: ui.view([coverageTable(records, copy, false)]) };
      },
    },
  },
});
