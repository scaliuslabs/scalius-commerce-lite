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
// - `cart.line_prices` prices the plan as a share (`percent`) of the item as
//   checkout prices it, so it is right in every currency and on any app's
//   price; `cart.validate` refuses a plan on a product that is not eligible
//   or that the merchant set no price for (read with a declared read, so a
//   forged plan never sells). Pricing blocks on failure: a plan never sells
//   unpaid.
// - A coverage follows its order: it is pending until the order is paid,
//   active once paid, and void once the order is cancelled or its protected
//   units are refunded or returned. Every order, refund and return event
//   recomputes the order's coverages from what the order says now
//   (`orders.get`, `refunds.list`, `returns.list`), so events may arrive
//   late, twice or out of order. A refund and a return of the same units
//   count once (the larger of the two ends the units).
import {
  adminContext,
  adminLocale,
  defineManifest,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  type OrderRepresentation,
  type OrderRepresentationLine,
  type PluginAdminLocale,
  type PluginContextOf,
  type PluginEvent,
  type RefundRepresentation,
  type ReturnRepresentation,
} from "@scalius/plugin-sdk";

export const APP_ID = "scaliuslabs.protection";
/** The key the plan travels under on a line and an order. */
export const PLAN_KEY = `${APP_ID}.plan`;
export const PLANS = { one_year: { years: 1, setting: "one_year_percent" }, two_years: { years: 2, setting: "two_years_percent" } } as const;
export type PlanId = keyof typeof PLANS;

export const manifest = defineManifest({
  id: APP_ID,
  name: "Protection Plans",
  version: "1.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sell one- and two-year protection plans on the products you choose, priced as a share of the item, with a coverage record for every plan sold.",
  author: { name: "Scalius Labs" },
  tagline: "Protection plans on the items you choose",
  categories: ["checkout", "support"],
  scopes: ["read_orders"],
  // A coverage follows its order's payment, cancellation, refunds and returns.
  events: ["order.created", "order.paid", "order.cancelled", "order.refunded", "refund.created", "refund.updated", "return.updated"],
  settings: [
    { key: "one_year_percent", label: "1-year plan price (% of the item)", type: "number", default: 8, help: "A share of what the buyer pays for the item, in any market. 0 stops selling it." },
    { key: "two_years_percent", label: "2-year plan price (% of the item)", type: "number", default: 12, help: "A share of what the buyer pays for the item, in any market. 0 stops selling it." },
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
    // A plan must never sell unpaid: if pricing fails, checkout stops instead of
    // freezing the plan without its add-on (the default, skip, would).
    { point: "cart.line_prices", priority: 300, onError: "block", reads: [{ as: "flags", customFields: ["product:eligible"] }] },
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
        /** `pending` until the order is paid, `active` once paid, `void` once cancelled, refunded or returned. */
        { key: "status", name: "Status", type: "single_line_text" },
        /** Why a void coverage ended: `cancelled`, `refunded` or `returned`; null otherwise. */
        { key: "void_reason", name: "Ended because", type: "single_line_text" },
        { key: "quantity_bought", name: "Units bought", type: "integer" },
        /** The units still covered: bought less those refunded or returned. */
        { key: "quantity", name: "Units covered", type: "integer" },
        /** What the buyer paid for the plans of the line, in minor units of `currency`. */
        { key: "plan_paid_minor", name: "Plan paid", type: "integer" },
        /** One covered unit: the item's price the plan was a share of (its price and surcharges, without add-ons), in minor units of `currency`. */
        { key: "covered_unit_minor", name: "Covered value per unit", type: "integer" },
        { key: "currency", name: "Currency", type: "single_line_text" },
        { key: "starts_at", name: "Starts", type: "date_time" },
        { key: "ends_at", name: "Ends", type: "date_time" },
      ],
      indexes: ["order_id", "order_number", "status"],
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

/** A plan's price as a share of the item, at most two decimals; 0 when the merchant set none (the plan is not sold). */
export function planPercent(plan: PlanId, settings: Settings): number {
  const percent = Number(settings[PLANS[plan].setting] ?? 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(1_000, Math.round(percent * 100) / 100);
}

type Flags = Record<string, { data: { eligible?: unknown } }>;
const eligibleOf = (reads: Record<string, unknown>, productId: string) => (reads.flags as Flags | undefined)?.[productId]?.data.eligible === true;

/** The parts of the order representation the app reads (`orders.get`), typed from the SDK's. */
export type OrderRead = Pick<OrderRepresentation, "id" | "orderNumber" | "currency" | "createdAt" | "status" | "paymentStatus"> & {
  lines: Array<Pick<OrderRepresentationLine, "id" | "productId" | "title" | "variantLabel" | "quantity" | "unitPriceMinor" | "purchaseOptions"> & {
    properties: Array<Pick<OrderRepresentationLine["properties"][number], "key" | "value" | "appId">>;
    adjustments: Array<Pick<OrderRepresentationLine["adjustments"][number], "appId" | "title" | "amountMinor">>;
  }>;
};
export type RefundRead = Pick<RefundRepresentation, "status" | "lines">;
export type ReturnRead = Pick<ReturnRepresentation, "status"> & { lines: Array<Pick<ReturnRepresentation["lines"][number], "orderItemId" | "receivedQuantity">> };

export const COVERAGE_STATUSES = ["pending", "active", "void"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export type VoidReason = "cancelled" | "refunded" | "returned";

export interface Coverage extends Record<string, unknown> {
  order_id: string;
  order_number: number | null;
  order_item_id: string;
  product_id: string;
  title: string;
  plan: PlanId;
  status: CoverageStatus;
  void_reason: VoidReason | null;
  quantity_bought: number;
  quantity: number;
  plan_paid_minor: number;
  covered_unit_minor: number;
  currency: string;
  starts_at: string;
  ends_at: string;
}

/** The order's payment says the plans were paid for. */
const PAID_STATUSES: ReadonlySet<string> = new Set(["paid", "partially_refunded"]);

/** Units of each line given back: refunded (any refund that has not failed) and returned (received back). */
function unitsEnded(refunds: readonly RefundRead[], returns: readonly ReturnRead[]) {
  const refunded = new Map<string, number>();
  const returned = new Map<string, number>();
  for (const refund of refunds) {
    if (refund.status === "failed") continue;
    for (const line of refund.lines) refunded.set(line.orderItemId, (refunded.get(line.orderItemId) ?? 0) + Math.max(0, line.quantity));
  }
  for (const entry of returns) {
    if (entry.status === "cancelled" || entry.status === "rejected") continue;
    for (const line of entry.lines) returned.set(line.orderItemId, (returned.get(line.orderItemId) ?? 0) + Math.max(0, line.receivedQuantity));
  }
  return { refunded, returned };
}

/**
 * One coverage per paid-for plan of the order, as the order stands now: what
 * the buyer chose and paid (its own answer and add-on: no add-on, no
 * coverage), the item it covers (the price the plan was a share of), and its
 * status from the order's payment, cancellation, refunds and returns.
 */
export function coveragesOf(order: OrderRead, refunds: readonly RefundRead[] = [], returns: readonly ReturnRead[] = []): Coverage[] {
  const startsAt = new Date(order.createdAt);
  const ended = unitsEnded(refunds, returns);
  return order.lines.flatMap((line): Coverage[] => {
    const plan = line.properties.find((property) => property.appId === APP_ID && property.key === PLAN_KEY)?.value;
    if (!isPlan(plan) || line.quantity <= 0) return [];
    const planPerUnit = line.adjustments.filter((adjustment) => adjustment.appId === APP_ID).reduce((total, adjustment) => total + adjustment.amountMinor, 0);
    if (planPerUnit <= 0) return [];
    const endsAt = new Date(startsAt);
    endsAt.setUTCFullYear(endsAt.getUTCFullYear() + PLANS[plan].years);
    // The item the plan was a share of: the unit price less every add-on (this plan's and any
    // other app's: a gift wrap is not the item), as checkout priced it.
    const addOnsPerUnit = line.adjustments.reduce((total, adjustment) => total + adjustment.amountMinor, 0);
    const refunded = ended.refunded.get(line.id) ?? 0;
    const returned = ended.returned.get(line.id) ?? 0;
    // A refund and a return of the same units count once.
    const covered = Math.max(0, line.quantity - Math.max(refunded, returned));
    const voidReason: VoidReason | null = order.status === "cancelled" ? "cancelled"
      : covered === 0 || order.paymentStatus === "refunded" ? (returned > refunded || order.status === "returned" ? "returned" : "refunded")
        : order.status === "returned" ? "returned"
          : null;
    const status: CoverageStatus = voidReason ? "void" : PAID_STATUSES.has(order.paymentStatus) ? "active" : "pending";
    return [{
      order_id: order.id,
      order_number: order.orderNumber,
      order_item_id: line.id,
      product_id: line.productId,
      title: [line.title ?? "Item", line.variantLabel].filter(Boolean).join(" · "),
      plan,
      status,
      void_reason: voidReason,
      quantity_bought: line.quantity,
      quantity: voidReason ? 0 : covered,
      plan_paid_minor: planPerUnit * line.quantity,
      covered_unit_minor: Math.max(0, line.unitPriceMinor - addOnsPerUnit),
      currency: order.currency,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    }];
  });
}

/** Writes per batch (`ctx.objects.batch` takes at most 25). */
const BATCH_MAX = 25;
/** Pages of refunds or returns read for one order (100 a page). */
const PAGES_MAX = 10;

/** The order an event is about: the order itself, or the order a refund or return belongs to. */
export function orderIdOf(event: Pick<PluginEvent, "resource" | "facts">): string | null {
  if (event.resource.type === "order") return event.resource.id;
  const orderId = event.facts.orderId;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : null;
}

async function listAll<T>(ctx: Context, operation: "refunds.list" | "returns.list", key: "refunds" | "returns", orderId: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const query: Record<string, string> = cursor ? { limit: "100", cursor } : { limit: "100" };
    const read = await ctx.api.call<Record<string, unknown> & { nextCursor: string | null }>(operation, { path: { id: orderId }, query });
    if (!read.ok || !read.data) throw new Error(`${operation} failed: ${read.error?.code ?? read.status}`);
    items.push(...((read.data[key] as T[] | undefined) ?? []));
    const next: string | null = read.data.nextCursor;
    if (!next) break;
    cursor = next;
  }
  return items;
}

/**
 * Recomputes the order's coverages from what it says now and writes them,
 * keyed by order line, in batches of 25. `create` is the order's first
 * event; any later event touches only an order that already has coverages.
 */
export async function syncCoverages(ctx: Context, orderId: string, create: boolean): Promise<number> {
  if (!create) {
    const existing = await ctx.objects.coverages.query({ where: { order_id: orderId }, limit: 1 });
    if (existing.records.length === 0) return 0;
  }
  const read = await ctx.api.call<{ order: OrderRead }>("orders.get", { path: { id: orderId } });
  if (!read.ok || !read.data?.order) throw new Error(`orders.get failed: ${read.error?.code ?? read.status}`);
  const order = read.data.order;
  if (coveragesOf(order).length === 0) return 0;
  const [refunds, returns] = await Promise.all([
    listAll<RefundRead>(ctx, "refunds.list", "refunds", orderId),
    listAll<ReturnRead>(ctx, "returns.list", "returns", orderId),
  ]);
  const coverages = coveragesOf(order, refunds, returns);
  for (let start = 0; start < coverages.length; start += BATCH_MAX) {
    await ctx.objects.batch(coverages.slice(start, start + BATCH_MAX).map((coverage) => ({
      op: "put" as const, object: "coverages", id: `${coverage.order_id}:${coverage.order_item_id}`, record: coverage,
    })));
  }
  return coverages.length;
}

/** How many flag writes run at once: a bulk action of 250 products finishes well inside the route's budget. */
const FLAG_WRITES_AT_ONCE = 25;

const COPY = {
  en: {
    item: "Item", plan: "Plan", units: "Units", paid: "Plan paid", covered: "Covered value", ends: "Ends", order: "Order", status: "Status",
    plans: { one_year: "1 year", two_years: "2 years" },
    statuses: { pending: "Awaiting payment", active: "Active", void: "Void" },
    reasons: { cancelled: "Void: order cancelled", refunded: "Void: refunded", returned: "Void: returned" },
    none: "No protection plan on this order.",
    emptyTitle: "No plans sold yet", emptyText: "Offer plans on your products (Products → select → Offer protection plans), and buyers can add one to them.",
    title: "Protection plans", description: "Every plan sold, with what it covers and until when.",
    offered: "Buyers can add a protection plan to this product.", notOffered: "This product offers no protection plan.",
    offer: "Offer protection plans", stop: "Stop offering", saved: "Saved for {n} product(s).", select: "Select at least one product.",
  },
  bn: {
    item: "পণ্য", plan: "প্ল্যান", units: "সংখ্যা", paid: "প্ল্যানের দাম", covered: "কভার মূল্য", ends: "শেষ", order: "অর্ডার", status: "অবস্থা",
    plans: { one_year: "১ বছর", two_years: "২ বছর" },
    statuses: { pending: "পেমেন্টের অপেক্ষায়", active: "চালু", void: "বাতিল" },
    reasons: { cancelled: "বাতিল: অর্ডার বাতিল হয়েছে", refunded: "বাতিল: টাকা ফেরত দেওয়া হয়েছে", returned: "বাতিল: পণ্য ফেরত এসেছে" },
    none: "এই অর্ডারে কোনো প্রোটেকশন প্ল্যান নেই।",
    emptyTitle: "এখনও কোনো প্ল্যান বিক্রি হয়নি", emptyText: "পণ্যে প্ল্যান চালু করুন (পণ্য → বেছে নিন → প্রোটেকশন প্ল্যান চালু করুন), তাহলে ক্রেতারা প্ল্যান যোগ করতে পারবেন।",
    title: "প্রোটেকশন প্ল্যান", description: "বিক্রি হওয়া প্রতিটি প্ল্যান, কী কভার করে এবং কতদিন।",
    offered: "ক্রেতারা এই পণ্যে প্রোটেকশন প্ল্যান যোগ করতে পারবেন।", notOffered: "এই পণ্যে কোনো প্রোটেকশন প্ল্যান নেই।",
    offer: "প্রোটেকশন প্ল্যান চালু করুন", stop: "বন্ধ করুন", saved: "{n}টি পণ্যে সংরক্ষিত হয়েছে।", select: "অন্তত একটি পণ্য বেছে নিন।",
  },
} satisfies Record<PluginAdminLocale, unknown>;

type CoverageRecord = { id: string; data: { [K in keyof Coverage]?: (K extends "plan" | "status" | "void_reason" ? string : Coverage[K]) | null } };

/** What a claim desk needs first: is this coverage live, and if not, why not. */
function statusCell(status: unknown, reason: unknown, copy: (typeof COPY)[PluginAdminLocale]) {
  if (status === "active") return { badge: copy.statuses.active, tone: "success" as const };
  if (status === "void") {
    const text = reason === "cancelled" || reason === "refunded" || reason === "returned" ? copy.reasons[reason] : copy.statuses.void;
    return { badge: text, tone: "critical" as const };
  }
  // Records from before the lifecycle read as awaiting payment until their next event.
  return { badge: copy.statuses.pending, tone: "warning" as const };
}

function coverageTable(records: readonly CoverageRecord[], copy: (typeof COPY)[PluginAdminLocale], withOrder: boolean) {
  return ui.table({
    columns: [
      ...(withOrder ? [{ key: "order", label: copy.order }] : []),
      { key: "item", label: copy.item },
      { key: "plan", label: copy.plan },
      { key: "status", label: copy.status },
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
        status: statusCell(data.status, data.void_reason, copy),
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
    // The plan is a share of each unit as checkout prices it (any app's price, any currency), on an eligible product only.
    "cart.line_prices": ({ cart, reads }, settings) => ({
      prices: [],
      adjustments: cart.lines.flatMap((line) => {
        const plan = line.properties[PLAN_KEY];
        if (!isPlan(plan) || !eligibleOf(reads, line.productId)) return [];
        const percent = planPercent(plan, settings);
        return percent > 0 ? [{ lineId: line.lineId, percent, title: plan === "one_year" ? "1-year protection plan" : "2-year protection plan" }] : [];
      }),
    }),
    // A plan sells only on a product the merchant marked eligible, at a price the merchant set.
    "cart.validate": ({ cart, reads }, settings) => ({
      errors: cart.lines.flatMap((line) => {
        const plan = line.properties[PLAN_KEY];
        return isPlan(plan) && (!eligibleOf(reads, line.productId) || planPercent(plan, settings) === 0)
          ? [{ code: "protection_unavailable", message: "A protection plan isn't offered for this item. Remove the plan to continue.", lineId: line.lineId }]
          : [];
      }),
    }),
  },

  // Each event recomputes the order's coverages from the order as it is now.
  events: {
    "order.created": async (event, ctx) => { await syncCoverages(ctx, event.resource.id, true); },
    "order.paid": async (event, ctx) => { await syncCoverages(ctx, event.resource.id, false); },
    "order.cancelled": async (event, ctx) => { await syncCoverages(ctx, event.resource.id, false); },
    "order.refunded": async (event, ctx) => { await syncCoverages(ctx, event.resource.id, false); },
    "refund.created": async (event, ctx) => { const orderId = orderIdOf(event); if (orderId) await syncCoverages(ctx, orderId, false); },
    "refund.updated": async (event, ctx) => { const orderId = orderIdOf(event); if (orderId) await syncCoverages(ctx, orderId, false); },
    "return.updated": async (event, ctx) => { const orderId = orderIdOf(event); if (orderId) await syncCoverages(ctx, orderId, false); },
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
        for (let start = 0; start < ids.length; start += FLAG_WRITES_AT_ONCE) {
          await Promise.all(ids.slice(start, start + FLAG_WRITES_AT_ONCE).map((productId) => ctx.customFields.set("product", productId, { eligible: offer })));
        }
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
