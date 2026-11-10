// Protection Plans (`scaliuslabs.protection`): a buyer adds a one-year,
// two-year or lifetime protection plan to an item the merchant marked
// eligible, the plan is priced as a share of the item, and every plan sold
// is the store's own warranty: one record per protected unit, with a
// buyer-facing ID, that the buyer sees in their account and claims like any
// warranty (COMMERCE-HOOKS H21). The app keeps no coverage store of its own.
//
// - The plan is the app's own line input (`checkout.lineInputs`, a select
//   under `scaliuslabs.protection.plan`), shown on products whose `eligible`
//   flag is on, a SKU's own `eligible` flag over its product's (one offer of
//   a product takes plans, another does not). Checkout refuses a plan on a
//   line it does not apply to. It shares the line with any other app's
//   input or purchase option.
// - A buyer may decline a plan ("No protection"): the store asks them to
//   agree to the decline agreement first (the choice's `confirm`) and the
//   order line keeps the agreement; a declined line is priced and covered
//   like no plan. The cart offers "Add a 1-year plan to all eligible items"
//   and "Remove all protection" (the input's `bulk`).
// - The merchant writes the decline agreement (`decline_text`, per store
//   language; the choice's `confirm.textSetting`). Changing the words changes
//   the input's revision, so a decline given to older words (a cart kept
//   since) is refused by checkout until the buyer agrees again.
// - With "Buyers must choose a plan or decline it" on (`require_decision`,
//   the input's `decision`), checkout refuses an eligible line with neither;
//   pressing Place order with such lines asks the buyer once to agree to the
//   decline and declines them all.
// - `cart.line_prices` prices the plan as a share (`percent`) of the item as
//   checkout prices it, so it is right in every currency and on any app's
//   price; `cart.validate` refuses a plan the merchant set no price for.
//   Pricing blocks on failure: a plan never sells unpaid.
// - Coverage follows its order: once the order is paid, each protected unit
//   gets a record (`warranties.issue`, the plan's terms: 1 or 2 years, or
//   lifetime); units cancelled, refunded or returned are voided
//   (`warranties.void`). Every order, refund and return event recomputes the
//   targets from what the order says now (`orders.get`, `refunds.list`,
//   `returns.list`), and both writes set a target, so events may arrive late,
//   twice or out of order. A refund and a return of the same units count
//   once (the larger of the two ends the units). An order's first read marks
//   whether it has a plan (`ctx.kv`, 30 days); a later event of an order
//   marked without one reads nothing, so orders without plans cost one API
//   call each.
// - Prices are a share of the item, or (`pricing: tiers`) a price table in the
//   store's currency (`tiers`), looked up on the item's store-currency price
//   (`lines[].storeUnitPrice`) and answered `currency: "store"`, so a USD
//   market pays the BDT table's price converted once at checkout's rate.
// - The product page shows the plan's price and the offers that take it
//   (`plan_price`, a `product.buy_box.after` part reading the app's public
//   settings and its own per-SKU `eligible` flag).
// - Offering plans on a page of products writes the app's flag on each.
//   One run makes at most 50 platform calls on Free, so up to 45 products
//   are written at once and a larger selection waits in a queue a
//   background job (`set_eligible`) writes, 43 products a step. Each action
//   takes its products out of every older one in the queue, so the
//   merchant's last action on a product wins, whatever order steps run in.
import {
  adminContext,
  adminLocale,
  defineManifest,
  definePlugin,
  PLUGIN_API_VERSION,
  textFor,
  ui,
  type OrderRepresentation,
  type OrderRepresentationLine,
  type PluginAdminLocale,
  type PluginContextOf,
  type PluginEvent,
  type RefundRepresentation,
  type ReturnRepresentation,
} from "@scalius/plugin-sdk";
import { APP_ID, DECLINE_TEXT, DECLINED, isPlan, PLAN_KEY, PLAN_TERMS, planPercent, planSells, PLANS, parsePriceTiers, tierPrice, type PlanId } from "./plans";

export * from "./plans";

export const manifest = defineManifest({
  id: APP_ID,
  name: "Protection Plans",
  version: "1.4.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sell one-year, two-year and lifetime protection plans on the products and offers you choose, priced as a share of the item. Every plan sold is your store's own warranty, with a protection ID buyers claim.",
  author: { name: "Scalius Labs" },
  tagline: "Protection plans on the items you choose",
  categories: ["checkout", "support"],
  scopes: ["read_orders", "write_warranties"],
  // A coverage follows its order's payment, cancellation, refunds and returns.
  events: ["order.created", "order.paid", "order.cancelled", "order.refunded", "refund.created", "refund.updated", "return.updated"],
  settings: [
    { key: "one_year_percent", label: "1-year plan price (% of the item)", type: "number", default: 8, public: true, help: "A share of what the buyer pays for the item, in any market. 0 stops selling it." },
    { key: "two_years_percent", label: "2-year plan price (% of the item)", type: "number", default: 12, public: true, help: "A share of what the buyer pays for the item, in any market. 0 stops selling it." },
    { key: "lifetime_percent", label: "Lifetime plan price (% of the item)", type: "number", default: 0, public: true, help: "A share of what the buyer pays for the item, in any market. 0 (the default) does not sell it." },
    {
      key: "pricing", label: "How plans are priced", type: "select", default: "percent", public: true,
      options: [{ value: "percent", label: "A share of the item" }, { value: "tiers", label: "From the price table" }],
      help: "With the price table, every plan sold (a share above 0) costs the table's price for the item.",
    },
    {
      key: "tiers", label: "Price table (store currency)", type: "textarea", maxLength: 1000, public: true,
      help: "One line each, cheapest first: the item's price up to = the plan's price, then above = the price for dearer items. For example 1000=250, 3000=350, above=500.",
    },
    {
      key: "decline_text", label: "Decline agreement", type: "textarea", maxLength: 1000, translatable: true,
      help: "What a buyer who skips protection agrees to. Changing it asks buyers who already declined to agree again. Empty: the app's own words.",
    },
    {
      key: "require_decision", label: "Buyers must choose a plan or decline it", type: "boolean", default: false,
      help: "Checkout asks for a plan or the decline agreement on every item that offers plans before the order is placed.",
    },
    { key: "policy_url", label: "Protection policy link", type: "url", public: true, help: "Where \"Learn more\" goes on the product page." },
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
    {
      ownerType: "variant",
      key: "eligible",
      name: "Protection plans offered",
      type: "boolean",
      description: "Buyers can add a protection plan to this offer. Unset, it follows its product.",
      storefrontVisible: true,
    },
  ],
  functions: [
    // A plan must never sell unpaid: if pricing fails, checkout stops instead of
    // freezing the plan without its add-on (the default, skip, would).
    { point: "cart.line_prices", priority: 300, onError: "block" },
    { point: "cart.validate", priority: 300 },
  ],
  checkout: {
    lineInputs: [{
      key: "plan",
      label: "Protection plan",
      type: "select",
      options: [
        { value: "one_year", label: "1 year" },
        { value: "two_years", label: "2 years" },
        { value: "lifetime", label: "Lifetime" },
        // Declining is a decision the buyer agrees to; the store asks before it is taken and keeps the agreement on the order.
        {
          value: DECLINED,
          label: "No protection",
          confirm: {
            title: "Continue without protection?",
            text: DECLINE_TEXT,
            // The merchant's own words (`decline_text`); these are the default.
            textSetting: "decline_text",
            agree: "I agree and want to continue",
          },
        },
      ],
      help: "Covers accidental damage and defects. Leave it empty for no plan.",
      bulk: {
        apply: { label: "Add a 1-year plan to all eligible items", value: "one_year" },
        clear: { label: "Remove all protection" },
      },
      products: { customField: "eligible" },
      variants: { customField: "eligible" },
      // With `require_decision` on, every eligible line needs a plan or the decline before checkout;
      // Place order with undecided lines asks for the decline once and declines them all.
      decision: { requiredSetting: "require_decision", proceedWith: DECLINED },
    }],
  },
  storefront: {
    components: [{
      type: "plan_price",
      name: "Protection plan price",
      targets: ["product.buy_box.after"],
      settings: [],
    }],
  },
  routes: {
    admin: [
      { name: "coverages", methods: ["GET"], description: "Every protection record sold, across the store." },
      { name: "order_coverage", methods: ["GET"], description: "The protection records of one order." },
      { name: "product_plans", methods: ["GET"], description: "Whether a product offers protection plans." },
      { name: "set_eligible", methods: ["POST"], description: "Offer or stop offering protection plans on products." },
    ],
    public: [],
    webhooks: [],
  },
  // Offering or stopping plans on more products than one run can write.
  jobs: [{ name: "set_eligible", title: "Offer or stop protection plans" }],
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
  translations: {
    bn: {
      name: "প্রোটেকশন প্ল্যান",
      tagline: "আপনার বেছে নেওয়া পণ্যে প্রোটেকশন প্ল্যান",
      description: "আপনার বেছে নেওয়া পণ্যে এক ও দুই বছরের প্রোটেকশন প্ল্যান বিক্রি করুন, দাম পণ্যের দামের একটি অংশ, আর বিক্রি হওয়া প্রতিটি প্ল্যানের একটি কভারেজ রেকর্ড থাকে।",
      pages: { coverages: "প্রোটেকশন প্ল্যান" },
      cards: { order_coverage: "প্রোটেকশন প্ল্যান", product_plans: "প্রোটেকশন প্ল্যান" },
      actions: { offer_plans: "প্রোটেকশন প্ল্যান অফার করুন", stop_plans: "প্রোটেকশন প্ল্যান অফার বন্ধ করুন" },
      settings: {
        one_year_percent: {
          label: "১ বছরের প্ল্যানের দাম (পণ্যের দামের %)",
          help: "ক্রেতা পণ্যের জন্য যা দেন তার একটি অংশ, যেকোনো মার্কেটে। ০ দিলে এটি বিক্রি বন্ধ।",
        },
        pricing: {
          label: "প্ল্যানের দাম কীভাবে ঠিক হয়",
          help: "দামের তালিকায় বিক্রি হওয়া প্রতিটি প্ল্যানের (অংশ ০-এর বেশি) দাম তালিকা থেকে পণ্যের দাম অনুযায়ী হয়।",
          options: { percent: "পণ্যের দামের একটি অংশ", tiers: "দামের তালিকা থেকে" },
        },
        tiers: {
          label: "দামের তালিকা (স্টোরের মুদ্রায়)",
          help: "প্রতি লাইনে একটি, সস্তা থেকে: পণ্যের দাম পর্যন্ত = প্ল্যানের দাম, শেষে above = এর বেশি দামের পণ্যের দাম। যেমন 1000=250, 3000=350, above=500।",
        },
        decline_text: {
          label: "প্রোটেকশন না নেওয়ার সম্মতি",
          help: "প্রোটেকশন না নিলে ক্রেতা যাতে সম্মত হন। বদলালে যাঁরা আগে না করেছেন তাঁদের আবার সম্মতি দিতে হবে। খালি রাখলে অ্যাপের নিজের লেখা দেখাবে।",
        },
        policy_url: { label: "প্রোটেকশন নীতির লিংক", help: "প্রোডাক্ট পেজে \"আরও জানুন\" যেখানে নিয়ে যায়।" },
        require_decision: {
          label: "ক্রেতাকে প্ল্যান বেছে নিতে বা না করতে হবে",
          help: "অর্ডার দেওয়ার আগে চেকআউট প্ল্যান অফার করা প্রতিটি পণ্যে একটি প্ল্যান অথবা না করার সম্মতি চায়।",
        },
        two_years_percent: {
          label: "২ বছরের প্ল্যানের দাম (পণ্যের দামের %)",
          help: "ক্রেতা পণ্যের জন্য যা দেন তার একটি অংশ, যেকোনো মার্কেটে। ০ দিলে এটি বিক্রি বন্ধ।",
        },
        lifetime_percent: {
          label: "আজীবন প্ল্যানের দাম (পণ্যের দামের %)",
          help: "ক্রেতা পণ্যের জন্য যা দেন তার একটি অংশ, যেকোনো মার্কেটে। ০ (ডিফল্ট) দিলে এটি বিক্রি হয় না।",
        },
      },
      // What the buyer sees on a Bangla page.
      checkout: {
        lineInputs: {
          plan: {
            label: "প্রোটেকশন প্ল্যান",
            help: "দুর্ঘটনাজনিত ক্ষতি ও ত্রুটি কভার করে। প্ল্যান না চাইলে খালি রাখুন।",
            options: { one_year: "১ বছর", two_years: "২ বছর", lifetime: "আজীবন", declined: "প্রোটেকশন নেই" },
            confirm: {
              declined: {
                title: "প্রোটেকশন ছাড়াই চালিয়ে যাবেন?",
                text: "আমার প্রোটেকশন দরকার নেই। আমার নিজের অ্যাকাউন্ট বা ডিভাইসের কারণে পণ্যটি ক্ষতিগ্রস্ত বা হারিয়ে গেলে দায় আমার।",
                agree: "আমি সম্মত এবং চালিয়ে যেতে চাই",
              },
            },
            bulk: { apply: "সব যোগ্য পণ্যে ১ বছরের প্ল্যান যোগ করুন", clear: "সব প্রোটেকশন সরান" },
          },
        },
      },
      customFields: {
        product: { eligible: { name: "প্রোটেকশন প্ল্যান অফার করা হয়", description: "ক্রেতারা এই পণ্যে প্রোটেকশন প্ল্যান যোগ করতে পারবেন।" } },
        variant: { eligible: { name: "প্রোটেকশন প্ল্যান অফার করা হয়", description: "ক্রেতারা এই অফারে প্রোটেকশন প্ল্যান যোগ করতে পারবেন। খালি রাখলে পণ্যের মতোই চলে।" } },
      },
      jobs: { set_eligible: "প্রোটেকশন প্ল্যান চালু বা বন্ধ করুন" },
    },
  },
});

type Context = PluginContextOf<typeof manifest>;
/** One add-on a `cart.line_prices` answer gives a line. */
type AddOn = { lineId: string; percent: number; title: string } | { lineId: string; amountMinor: number; currency: "store"; title: string };
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
  /** Null for a lifetime plan. */
  ends_at: string | null;
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
    const years = PLANS[plan].years;
    const endsAt = years === null ? null : new Date(startsAt);
    endsAt?.setUTCFullYear(endsAt.getUTCFullYear() + years!);
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
      ends_at: endsAt?.toISOString() ?? null,
    }];
  });
}

/**
 * The store's warranty records a coverage stands for, as targets on its
 * line: once paid, each unit bought is covered (`issue`) and the units no
 * longer covered are void (`void`); a void coverage voids every unit it
 * covered; nothing is issued before payment.
 */
export function warrantyTargetsOf(coverage: Pick<Coverage, "status" | "quantity_bought" | "quantity">): { issue: number; void: number } {
  if (coverage.status === "pending") return { issue: 0, void: 0 };
  if (coverage.status === "void") return { issue: 0, void: coverage.quantity_bought };
  return { issue: coverage.quantity_bought, void: coverage.quantity_bought - coverage.quantity };
}

/** A plan's terms as its warranty records freeze them. */
export function planPolicy(plan: PlanId) {
  const years = PLANS[plan].years;
  return years === null
    ? { key: plan, name: PLANS[plan].name, durationUnit: "lifetime" as const, terms: PLAN_TERMS }
    : { key: plan, name: PLANS[plan].name, durationUnit: "years" as const, durationValue: years, terms: PLAN_TERMS };
}
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

/** What an order's first read found: whether it has a plan. Kept 30 days; a missing mark reads the order again. */
export const orderMarkKey = (orderId: string) => `order:${orderId}`;
const ORDER_MARK_TTL_SECONDS = 30 * 24 * 60 * 60;
type OrderMark = "plan" | "none";

/**
 * Recomputes the order's coverages from what it says now and sets each
 * line's warranty records to them (`warranties.issue`, `warranties.void`:
 * targets, so a repeat changes nothing). No event relies on an earlier one:
 * an event may run before the order's `order.created`.
 * `order.created` always reads the order; a later event reads it only when
 * the order has, or may have, a plan: not when its first read marked it
 * without one. Orders without plans then cost one API call in all, so a busy
 * store stays far inside the app's 60 API calls a minute.
 */
export async function syncCoverages(ctx: Context, orderId: string, created = false): Promise<number> {
  if (!created && await ctx.kv.get<OrderMark>(orderMarkKey(orderId)) === "none") return 0;
  const read = await ctx.api.call<{ order: OrderRead }>("orders.get", { path: { id: orderId } });
  if (!read.ok || !read.data?.order) throw new Error(`orders.get failed: ${read.error?.code ?? read.status}`);
  const order = read.data.order;
  const hasPlan = coveragesOf(order).length > 0;
  await ctx.kv.set(orderMarkKey(orderId), (hasPlan ? "plan" : "none") satisfies OrderMark, { ttlSeconds: ORDER_MARK_TTL_SECONDS });
  if (!hasPlan) return 0;
  const [refunds, returns] = await Promise.all([
    listAll<RefundRead>(ctx, "refunds.list", "refunds", orderId),
    listAll<ReturnRead>(ctx, "returns.list", "returns", orderId),
  ]);
  const coverages = coveragesOf(order, refunds, returns);
  for (const coverage of coverages) {
    const target = warrantyTargetsOf(coverage);
    if (target.issue > 0) {
      const issued = await ctx.api.call("warranties.issue", {
        body: { orderItemId: coverage.order_item_id, quantity: Math.min(target.issue, 100), policy: planPolicy(coverage.plan) },
        idempotencyKey: `protection-issue-${coverage.order_item_id}-${coverage.plan}-${target.issue}`,
      });
      if (!issued.ok) throw new Error(`warranties.issue failed: ${issued.error?.code ?? issued.status}`);
    }
    if (target.void > 0) {
      const voided = await ctx.api.call("warranties.void", {
        body: { orderItemId: coverage.order_item_id, quantity: Math.min(target.void, 100) },
        idempotencyKey: `protection-void-${coverage.order_item_id}-${target.void}`,
      });
      if (!voided.ok) throw new Error(`warranties.void failed: ${voided.error?.code ?? voided.status}`);
    }
  }
  return coverages.length;
}

/**
 * Flags a route writes at once: inside the 50 platform calls of a Free run
 * with the queue read. A larger selection, or one that touches a product
 * still queued, goes to the queue the `set_eligible` job writes.
 */
export const FLAGS_PER_RUN = 45;
/** Flags one job step writes: with its queue read and up to three saves, inside 50. */
export const FLAGS_PER_STEP = 43;
/** Products the queue holds at most (well inside a 64 KiB key-value entry). */
export const MAX_QUEUED_PRODUCTS = 1_500;
/** How many flag writes run at once. */
const FLAG_WRITES_AT_ONCE = 15;
const QUEUE_KEY = "flag-queue";

async function writeFlags(ctx: Context, ids: readonly string[], offer: boolean): Promise<void> {
  for (let start = 0; start < ids.length; start += FLAG_WRITES_AT_ONCE) {
    await Promise.all(ids.slice(start, start + FLAG_WRITES_AT_ONCE).map((productId) => ctx.customFields.set("product", productId, { eligible: offer })));
  }
}

/** One merchant action not yet written: its products and whether it offers plans. */
export interface FlagIntent { seq: number; ids: string[]; offer: boolean }
/** Flag changes waiting for the job, oldest first. A product is in at most one intent. */
export interface FlagQueue { seq: number; intents: FlagIntent[] }
export const EMPTY_QUEUE: FlagQueue = { seq: 0, intents: [] };

function flagQueue(value: unknown): FlagQueue {
  const queue = value as Partial<FlagQueue> | null;
  return queue && typeof queue.seq === "number" && Array.isArray(queue.intents) ? { seq: queue.seq, intents: queue.intents } : EMPTY_QUEUE;
}

/** The queue after a new action: its products leave every older intent, so its intent is the one that stands. */
export function enqueueFlags(queue: FlagQueue, ids: readonly string[], offer: boolean): FlagQueue {
  const latest = new Set(ids);
  const seq = queue.seq + 1;
  const older = queue.intents
    .map((intent) => ({ ...intent, ids: intent.ids.filter((id) => !latest.has(id)) }))
    .filter((intent) => intent.ids.length > 0);
  return { seq, intents: [...older, { seq, ids: [...latest], offer }] };
}

/** The writes of the queue's head, oldest intent first, at most `limit` products. */
export function nextFlagWrites(queue: FlagQueue, limit: number): FlagIntent[] {
  const writes: FlagIntent[] = [];
  let left = limit;
  for (const intent of queue.intents) {
    if (left === 0) break;
    const ids = intent.ids.slice(0, left);
    writes.push({ ...intent, ids });
    left -= ids.length;
  }
  return writes;
}

/** The queue after `written`: each product leaves the intent it was written for, if it is still in it. */
export function afterFlagWrites(queue: FlagQueue, written: readonly FlagIntent[]): FlagQueue {
  const done = new Map(written.map((intent) => [intent.seq, new Set(intent.ids)]));
  return {
    seq: queue.seq,
    intents: queue.intents
      .map((intent) => ({ ...intent, ids: intent.ids.filter((id) => !done.get(intent.seq)?.has(id)) }))
      .filter((intent) => intent.ids.length > 0),
  };
}

const queuedCount = (queue: FlagQueue) => queue.intents.reduce((sum, intent) => sum + intent.ids.length, 0);
const isKvConflict = (error: unknown) => (error as { code?: unknown }).code === "kv_conflict";

/** Starts the queue's job when none is running (a running job reads every intent before it finishes). */
async function ensureFlagJob(ctx: Context, queueWasEmpty: boolean): Promise<void> {
  if (!queueWasEmpty) {
    const running = await ctx.jobs.list({ name: "set_eligible", limit: 5 });
    if (running.some((job) => job.status === "running")) return;
  }
  try {
    await ctx.jobs.start("set_eligible");
  } catch (error) {
    // A job still running reads the queue: the change is not lost.
    if ((error as { code?: unknown }).code !== "jobs_limit") throw error;
  }
}

const COPY = {
  en: {
    item: "Item", unit: "Unit", id: "Protection ID", plan: "Plan", ends: "Ends", status: "Status", lifetime: "Lifetime", order: "Order",
    title: "Protection plans", description: "Every protection record sold: its ID, item and order, and whether it still covers the unit. Claims arrive in the inbox like any warranty claim.",
    emptyTitle: "No protection sold yet", emptyText: "Offer plans on your products (Products → select → Offer protection plans); each paid unit gets a protection ID here.",
    statuses: { active: "Active", expired: "Ended", voided: "Void: cancelled, refunded or returned" },
    none: "No protection plan on this order.",
    offered: "Buyers can add a protection plan to this product.", notOffered: "This product offers no protection plan.",
    offer: "Offer protection plans", stop: "Stop offering", saved: "Saved for {n} product(s).", select: "Select at least one product.",
    saving: "Saving for {n} products. It finishes in a few minutes; refresh to see every product.",
    busy: "Other product updates are still saving. Try again in a few minutes.",
  },
  bn: {
    item: "পণ্য", unit: "ইউনিট", id: "প্রোটেকশন আইডি", plan: "প্ল্যান", ends: "শেষ", status: "অবস্থা", lifetime: "আজীবন", order: "অর্ডার",
    title: "প্রোটেকশন প্ল্যান", description: "বিক্রি হওয়া প্রতিটি প্রোটেকশন রেকর্ড: এর আইডি, পণ্য ও অর্ডার, এবং এখনও ইউনিটটি কভার করে কি না। ক্লেইম অন্য যেকোনো ওয়ারেন্টি ক্লেইমের মতো ইনবক্সে আসে।",
    emptyTitle: "এখনও কোনো প্রোটেকশন বিক্রি হয়নি", emptyText: "পণ্যে প্ল্যান চালু করুন (পণ্য → বেছে নিন → প্রোটেকশন প্ল্যান চালু করুন); পেমেন্ট হওয়া প্রতিটি ইউনিট এখানে একটি প্রোটেকশন আইডি পায়।",
    statuses: { active: "চালু", expired: "শেষ হয়েছে", voided: "বাতিল: অর্ডার বাতিল, টাকা ফেরত বা পণ্য ফেরত" },
    none: "এই অর্ডারে কোনো প্রোটেকশন প্ল্যান নেই।",
    offered: "ক্রেতারা এই পণ্যে প্রোটেকশন প্ল্যান যোগ করতে পারবেন।", notOffered: "এই পণ্যে কোনো প্রোটেকশন প্ল্যান নেই।",
    offer: "প্রোটেকশন প্ল্যান চালু করুন", stop: "বন্ধ করুন", saved: "{n}টি পণ্যে সংরক্ষিত হয়েছে।", select: "অন্তত একটি পণ্য বেছে নিন।",
    saving: "{n}টি পণ্যে সংরক্ষণ হচ্ছে। কয়েক মিনিটে শেষ হবে; সব পণ্য দেখতে রিফ্রেশ করুন।",
    busy: "অন্য পণ্যের পরিবর্তন এখনও সংরক্ষণ হচ্ছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।",
  },
} satisfies Record<PluginAdminLocale, unknown>;

/** A protection record as `warranties.list` answers it (the store's own warranty, issued by this app). */
type WarrantyRead = {
  id: string; code: string | null; appId: string | null; orderId: string; orderNumber: number | null; orderItemId: string; unitNumber: number | null;
  item: { title: string | null; variantLabel: string | null };
  status: "active" | "expired" | "voided"; expiresAt: string | null; policy: { name: string; durationUnit: string };
};

/** Protection records: one row per protected unit, with its ID and whether it is live (`withOrder`: the store-wide page). */
function warrantyTable(records: readonly WarrantyRead[], copy: (typeof COPY)[PluginAdminLocale], withOrder: boolean) {
  return ui.table({
    columns: [
      ...(withOrder ? [{ key: "order", label: copy.order }] : []),
      { key: "item", label: copy.item },
      { key: "unit", label: copy.unit, align: "end" as const },
      { key: "id", label: copy.id },
      { key: "plan", label: copy.plan },
      { key: "status", label: copy.status },
      { key: "ends", label: copy.ends },
    ],
    rows: records.map((record) => ({
      id: record.id,
      cells: {
        ...(withOrder ? { order: { text: record.orderNumber ? `#${record.orderNumber}` : record.orderId, to: { kind: "resource" as const, resource: "order" as const, id: record.orderId } } } : {}),
        item: [record.item.title ?? "", record.item.variantLabel].filter(Boolean).join(" · "),
        unit: record.unitNumber ?? 1,
        id: record.code ?? "",
        plan: record.policy.name,
        status: { badge: copy.statuses[record.status], tone: record.status === "active" ? "success" as const : "critical" as const },
        ends: record.expiresAt ? { date: record.expiresAt } : copy.lifetime,
      },
    })),
    ...(withOrder ? { empty: { title: copy.emptyTitle, text: copy.emptyText } } : {}),
  });
}

/** What the buyer reads at checkout (the add-on's title and the refusal), in their language (`input.language`). */
export const BUYER_COPY = {
  en: {
    one_year: "1-year protection plan", two_years: "2-year protection plan", lifetime: "Lifetime protection plan",
    unavailable: "A protection plan isn't offered for this item. Remove the plan to continue.",
  },
  bn: {
    one_year: "১ বছরের প্রোটেকশন প্ল্যান", two_years: "২ বছরের প্রোটেকশন প্ল্যান", lifetime: "আজীবন প্রোটেকশন প্ল্যান",
    unavailable: "এই পণ্যে প্রোটেকশন প্ল্যান দেওয়া হয় না। চালিয়ে যেতে প্ল্যানটি সরিয়ে দিন।",
  },
};

export default definePlugin({
  manifest,

  functions: {
    // The plan is a share of each unit as checkout prices it (any app's price, any currency). Checkout
    // takes the plan only on a line it applies to (the product's or SKU's flag), so every plan is answered.
    // With the price table, the plan is the table's price for the item in the store's currency
    // (`storeUnitPrice`), answered in it: checkout converts it once for the buyer's market.
    "cart.line_prices": ({ cart, lines, language }, settings) => {
      const tiers = settings.pricing === "tiers" ? parsePriceTiers(settings.tiers, cart.storeCurrency.decimalPlaces) : null;
      const facts = new Map(lines.map((line) => [line.lineId, line]));
      return {
        prices: [],
        adjustments: cart.lines.flatMap((line): AddOn[] => {
          const plan = line.properties[PLAN_KEY];
          if (!isPlan(plan) || !planSells(plan, settings, cart.storeCurrency.decimalPlaces)) return [];
          const title = textFor(language, BUYER_COPY)[plan];
          if (!tiers) return [{ lineId: line.lineId, percent: planPercent(plan, settings), title }];
          const item = facts.get(line.lineId)?.storeUnitPrice;
          // No store price to look up: the plan must not sell unpaid (pricing blocks on failure).
          if (!item) throw new Error(`Line ${line.lineId} has no store-currency price to price its plan.`);
          return [{ lineId: line.lineId, amountMinor: tierPrice(tiers, item.amountMinor), currency: "store" as const, title }];
        }),
      };
    },
    // A plan sells only at a price the merchant set (checkout already keeps it to eligible lines). Checkout
    // itself takes a decline only at the agreement shown now and refuses an undecided line when the merchant
    // requires a decision, so neither needs the app.
    "cart.validate": ({ cart, language }, settings) => ({
      errors: cart.lines.flatMap((line) => {
        const plan = line.properties[PLAN_KEY];
        if (isPlan(plan) && !planSells(plan, settings, cart.storeCurrency.decimalPlaces)) {
          return [{ code: "protection_unavailable", message: textFor(language, BUYER_COPY).unavailable, lineId: line.lineId }];
        }
        return [];
      }),
    }),
  },

  // Each event recomputes the order's coverages from the order as it is now, in whatever order the events come.
  events: {
    "order.created": async (event, ctx) => { await syncCoverages(ctx, event.resource.id, true); },
    "order.paid": async (event, ctx) => { await syncCoverages(ctx, event.resource.id); },
    "order.cancelled": async (event, ctx) => { await syncCoverages(ctx, event.resource.id); },
    "order.refunded": async (event, ctx) => { await syncCoverages(ctx, event.resource.id); },
    "refund.created": async (event, ctx) => { const orderId = orderIdOf(event); if (orderId) await syncCoverages(ctx, orderId); },
    "refund.updated": async (event, ctx) => { const orderId = orderIdOf(event); if (orderId) await syncCoverages(ctx, orderId); },
    "return.updated": async (event, ctx) => { const orderId = orderIdOf(event); if (orderId) await syncCoverages(ctx, orderId); },
  },

  jobs: {
    // Writes the queue's head, FLAGS_PER_STEP products a step, then takes them out of the queue with a
    // compare-and-set: an action queued meanwhile has already moved its products to its own intent.
    // A repeated step reads the queue again and writes the same flags again.
    set_eligible: async (ctx: Context) => {
      let current = await ctx.kv.getVersion<FlagQueue>(QUEUE_KEY);
      const writes = nextFlagWrites(flagQueue(current?.value), FLAGS_PER_STEP);
      if (writes.length === 0) return { done: true };
      for (const intent of writes) await writeFlags(ctx, intent.ids, intent.offer);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = afterFlagWrites(flagQueue(current?.value), writes);
        try {
          await ctx.kv.compareAndSet(QUEUE_KEY, current?.revision ?? null, next);
          const left = queuedCount(next);
          return { progress: { done: writes.reduce((sum, intent) => sum + intent.ids.length, 0), total: left + writes.reduce((sum, intent) => sum + intent.ids.length, 0) }, done: left === 0 };
        } catch (error) {
          if (!isKvConflict(error)) throw error;
          current = await ctx.kv.getVersion<FlagQueue>(QUEUE_KEY);
        }
      }
      // Still contended: the step repeats, writing the same flags.
      throw new Error("The flag queue kept changing; the step runs again.");
    },
  },

  routes: {
    admin: {
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
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await ctx.kv.getVersion<FlagQueue>(QUEUE_KEY);
          const queue = flagQueue(current?.value);
          const queued = new Set(queue.intents.flatMap((intent) => intent.ids));
          // Nothing queued touches these products: written now, and a later action still wins.
          if (ids.length <= FLAGS_PER_RUN && !ids.some((id) => queued.has(id))) {
            await writeFlags(ctx, ids, offer);
            return { body: ui.result({ toast: copy.saved.replace("{n}", String(ids.length)), refresh: true }) };
          }
          const next = enqueueFlags(queue, ids, offer);
          if (queuedCount(next) > MAX_QUEUED_PRODUCTS) return { status: 409, body: ui.result({ toast: { message: copy.busy, tone: "critical" } }) };
          try {
            await ctx.kv.compareAndSet(QUEUE_KEY, current?.revision ?? null, next);
          } catch (error) {
            if (isKvConflict(error)) continue;
            throw error;
          }
          // The job writes the queue a step at a time, starting right after this answer.
          await ensureFlagJob(ctx, queue.intents.length === 0);
          return { body: ui.result({ toast: copy.saving.replace("{n}", String(ids.length)), refresh: true }) };
        }
        return { status: 409, body: ui.result({ toast: { message: copy.busy, tone: "critical" } }) };
      },
      order_coverage: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { id } = adminContext(request);
        if (!id) return { body: ui.view([ui.text(copy.none)]) };
        const listed = await ctx.api.call<{ warranties: WarrantyRead[] }>("warranties.list", { query: { orderId: id, limit: "50" } });
        const records = (listed.ok ? listed.data?.warranties ?? [] : []).filter((record) => record.appId === APP_ID);
        if (records.length === 0) return { body: ui.view([ui.text(copy.none)]) };
        return { body: ui.view([warrantyTable(records, copy, false)]) };
      },
      // Every record the app issued, across the store (`warranties.list` without an order: its own only), a page at a time.
      coverages: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const cursor = adminContext(request).cursor;
        const listed = await ctx.api.call<{ warranties: WarrantyRead[]; nextCursor: string | null }>("warranties.list", {
          query: { limit: "25", ...(cursor ? { cursor } : {}) },
        });
        const table = warrantyTable(listed.ok ? listed.data?.warranties ?? [] : [], copy, true);
        return { body: ui.page([{ ...table, pagination: { next: listed.ok ? listed.data?.nextCursor ?? null : null } } as typeof table], { title: copy.title, description: copy.description }) };
      },
    },
  },
});
