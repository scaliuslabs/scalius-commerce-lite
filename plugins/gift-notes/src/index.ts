// Gift Notes (`scaliuslabs.gift-notes`): a buyer adds a gift message and gift
// wrap to any item, and staff get a packing slip for every gift.
//
// - Per-line inputs (`checkout.lineInputs`): the message and the wrap are the
//   app's own inputs on the line, drawn on the buy form after the product's
//   own, under `scaliuslabs.gift-notes.<key>`. Another app's inputs on the same
//   line (a protection plan, an engraving) never collide with them.
// - The wrap is priced as an add-on (`cart.line_prices` adjustments): core
//   prices nothing for an app's input. Pricing blocks on failure, and a
//   bundle line's wrap is answered too, so checkout refuses it: a wrap never
//   sells unpaid. A free wrap is answered as a 0 add-on, so the order line
//   records every wrap sold, and the slip wraps a line only when it carries
//   the wrap's add-on: what checkout froze, never today's settings.
// - A checkout answer (`checkout.attributes`) says the parcel is a gift, so
//   the slip leaves prices off.
// - On `order.created` the app reads the order back (`orders.get`): the
//   order shows it its own answers (the line inputs and the checkout answer)
//   and the product's, never another app's, and it writes one slip per gift
//   order. Delivery is at least once: the slip is keyed by the order.
import { adminContext, adminLocale, defineManifest, definePlugin, PLUGIN_API_VERSION, ui, type FunctionCart, type OrderRepresentation, type OrderRepresentationLine, type PluginAdminLocale, type PluginContextOf } from "@scalius/plugin-sdk";

export const APP_ID = "scaliuslabs.gift-notes";
/** The keys the app's inputs travel under on a line and an order. */
export const MESSAGE_KEY = `${APP_ID}.message`;
export const WRAP_KEY = `${APP_ID}.wrap`;
export const GIFT_RECEIPT_KEY = `${APP_ID}.gift_receipt`;

export const manifest = defineManifest({
  id: APP_ID,
  name: "Gift Notes",
  version: "1.0.3",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers add a gift message and gift wrap to any item. Staff get a packing slip for every gift, with the prices left off when the buyer asks.",
  author: { name: "Scalius Labs" },
  tagline: "Gift messages and gift wrap on every item",
  categories: ["checkout", "orders"],
  scopes: ["read_orders"],
  events: ["order.created"],
  settings: [
    {
      key: "wrap_fee",
      label: "Gift wrap price",
      type: "number",
      default: 50,
      help: "Added to each wrapped item, in your store's currency; a market that sells in another converts it at checkout. 0 wraps for free.",
    },
  ],
  // "block": if pricing fails, checkout stops. The default, "skip", would sell the wrap without its fee.
  functions: [{ point: "cart.line_prices", priority: 200, onError: "block" }],
  checkout: {
    attributes: [
      { key: "gift_receipt", label: "This is a gift: leave the prices off the packing slip", type: "boolean" },
    ],
    lineInputs: [
      { key: "message", label: "Gift message", type: "textarea", maxLength: 200, help: "We print it on a card in the parcel." },
      { key: "wrap", label: "Gift wrap", type: "checkbox", help: "Wrapped in recycled paper with a ribbon." },
    ],
  },
  objects: {
    slips: {
      name: "Gift slips",
      admin: "read",
      fields: [
        { key: "order_id", name: "Order", type: "order_reference", required: true },
        { key: "order_number", name: "Order number", type: "integer" },
        /** `SlipLine[]`: what to put in the parcel. */
        { key: "lines", name: "Items", type: "json" },
        { key: "gift_receipt", name: "Prices left off", type: "boolean" },
        { key: "currency", name: "Currency", type: "single_line_text" },
      ],
      indexes: ["order_number"],
    },
  },
  routes: {
    admin: [
      { name: "slips", methods: ["GET"], description: "Every gift slip, newest order first." },
      { name: "order_slip", methods: ["GET"], description: "The gift slip of one order." },
    ],
    public: [],
    webhooks: [],
  },
  admin: {
    pages: [{ id: "slips", title: "Gift slips", route: "slips", placement: "orders" }],
    cards: [{ id: "order_slip", target: "order", title: "Gift slip", route: "order_slip" }],
  },
  translations: {
    bn: {
      name: "গিফট নোট",
      tagline: "প্রতিটি পণ্যে গিফট বার্তা আর গিফট র‍্যাপ",
      description: "ক্রেতারা যেকোনো পণ্যে গিফট বার্তা আর গিফট র‍্যাপ যোগ করেন। স্টাফরা প্রতিটি গিফটের জন্য একটি প্যাকিং স্লিপ পান, আর ক্রেতা চাইলে তাতে দাম থাকে না।",
      pages: { slips: "গিফট স্লিপ" },
      cards: { order_slip: "গিফট স্লিপ" },
      settings: {
        wrap_fee: {
          label: "গিফট র‍্যাপের দাম",
          help: "প্রতিটি র‍্যাপ করা পণ্যে যোগ হয়, আপনার স্টোরের মুদ্রায়; অন্য মুদ্রায় বিক্রি করা মার্কেট চেকআউটে রূপান্তর করে। ০ দিলে র‍্যাপ ফ্রি।",
        },
      },
    },
  },
  storefront: {
    extensions: [{ target: "checkout.contact.after", reads: [] }],
  },
});

type Context = PluginContextOf<typeof manifest>;

/** One item of a slip. */
export interface SlipLine {
  orderItemId: string;
  title: string;
  quantity: number;
  message: string | null;
  wrap: boolean;
  /** What the item cost, per unit, in minor units; null on a gift receipt. */
  unitPriceMinor: number | null;
}

/** The parts of the order representation the app reads (`orders.get`). */
export type OrderRead = Pick<OrderRepresentation, "id" | "orderNumber" | "currency" | "attributes"> & {
  lines: Array<Pick<OrderRepresentationLine, "id" | "title" | "variantLabel" | "quantity" | "unitPriceMinor"> & {
    properties: Array<Pick<OrderRepresentationLine["properties"][number], "key" | "value" | "appId">>;
    adjustments: Array<Pick<OrderRepresentationLine["adjustments"][number], "appId" | "amountMinor">>;
  }>;
};

/**
 * The slip of an order, or null when no line is a gift. A line is wrapped
 * only when the buyer asked and the order line carries the wrap's add-on
 * (0 when the wrap was free at checkout): a wrap the order holds without it
 * is never delivered, whatever the fee is now. `unpaidWraps` lists the lines
 * left unwrapped so.
 */
export function slipOf(order: OrderRead, unpaidWraps: string[] = []): { order_id: string; order_number: number | null; lines: SlipLine[]; gift_receipt: boolean; currency: string } | null {
  const giftReceipt = order.attributes[GIFT_RECEIPT_KEY] === "true";
  const lines: SlipLine[] = [];
  for (const line of order.lines) {
    const own = new Map(line.properties.filter((property) => property.appId === APP_ID).map((property) => [property.key, property.value]));
    const message = own.get(MESSAGE_KEY) ?? null;
    const asked = own.get(WRAP_KEY) === "true";
    const sold = line.adjustments.some((adjustment) => adjustment.appId === APP_ID);
    const wrap = asked && sold;
    if (asked && !wrap) unpaidWraps.push(line.id);
    if (!message && !wrap) continue;
    lines.push({
      orderItemId: line.id,
      title: [line.title ?? "Item", line.variantLabel].filter(Boolean).join(" · "),
      quantity: line.quantity,
      message,
      wrap,
      unitPriceMinor: giftReceipt ? null : line.unitPriceMinor,
    });
  }
  if (lines.length === 0) return null;
  return { order_id: order.id, order_number: order.orderNumber, lines, gift_receipt: giftReceipt, currency: order.currency };
}

/** The dashboard's words, in the staff member's language. */
const COPY = {
  en: {
    receipt: "The buyer asked for a gift receipt: leave the prices off.",
    item: "Item", quantity: "Qty", wrap: "Wrap", message: "Message", wrapBadge: "Wrap",
    none: "No gift message or gift wrap on this order.",
    order: "Order", items: "Gift items", prices: "Prices", leftOff: "Left off", shown: "Shown",
    emptyTitle: "No gift orders yet", emptyText: "Orders with a gift message or gift wrap appear here.",
    title: "Gift slips", description: "What to put in each gift parcel.",
  },
  bn: {
    receipt: "ক্রেতা গিফট রসিদ চেয়েছেন: দাম লিখবেন না।",
    item: "পণ্য", quantity: "পরিমাণ", wrap: "র‍্যাপ", message: "বার্তা", wrapBadge: "র‍্যাপ",
    none: "এই অর্ডারে কোনো গিফট বার্তা বা গিফট র‍্যাপ নেই।",
    order: "অর্ডার", items: "গিফট পণ্য", prices: "দাম", leftOff: "বাদ", shown: "দেখানো",
    emptyTitle: "এখনও কোনো গিফট অর্ডার নেই", emptyText: "গিফট বার্তা বা গিফট র‍্যাপসহ অর্ডার এখানে দেখা যাবে।",
    title: "গিফট স্লিপ", description: "প্রতিটি গিফট পার্সেলে কী দিতে হবে।",
  },
} satisfies Record<PluginAdminLocale, Record<string, string>>;

function slipView(slip: { lines: SlipLine[]; gift_receipt: boolean }, copy: (typeof COPY)[PluginAdminLocale]) {
  return [
    ...(slip.gift_receipt ? [ui.banner("info", copy.receipt)] : []),
    ui.table({
      columns: [
        { key: "item", label: copy.item },
        { key: "quantity", label: copy.quantity, align: "end" },
        { key: "wrap", label: copy.wrap },
        { key: "message", label: copy.message },
      ],
      rows: slip.lines.map((line) => ({
        id: line.orderItemId,
        cells: { item: line.title, quantity: line.quantity, wrap: line.wrap ? { badge: copy.wrapBadge, tone: "info" } : null, message: line.message },
      })),
    }),
  ];
}

/**
 * The wrap fee on each wrapped line, as store-currency minor units for
 * checkout to convert. Every wrap is answered: a free one (a fee of 0, or
 * one too small for a minor unit) as a 0 add-on, so the order line records
 * it. A bundle line is answered too: it takes no add-on, so checkout refuses
 * it (`add_on_unavailable`) and the buyer removes the wrap, where skipping
 * it would freeze the wrap without its fee.
 */
export function wrapFeeAdjustments(
  cart: FunctionCart,
  settings: { wrap_fee?: unknown },
): Array<{ lineId: string; amountMinor: number; currency: "store"; title: string }> {
  const fee = Number(settings.wrap_fee ?? 0);
  const amountMinor = Number.isFinite(fee) && fee > 0 ? Math.round(fee * 10 ** cart.storeCurrency.decimalPlaces) : 0;
  return cart.lines
    .filter((line) => line.properties[WRAP_KEY] === "true")
    .map((line) => ({ lineId: line.lineId, amountMinor, currency: "store" as const, title: "Gift wrap" }));
}

export default definePlugin({
  manifest,

  functions: {
    // Gift wrap is the app's add-on: each wrapped unit takes the wrap fee. The fee is
    // the merchant's, in the store's currency: checkout converts it for a market that
    // sells in another, at the order's rate, as it does a product price.
    "cart.line_prices": ({ cart }, settings) => ({
      prices: [],
      adjustments: wrapFeeAdjustments(cart, settings),
    }),
  },

  extensions: {
    // The gift receipt question, drawn by the store as its own checkbox.
    "checkout.contact.after": () => ({ ui: ui.view([ui.field("gift_receipt")]) }),
  },

  events: {
    "order.created": async (event, ctx) => {
      const read = await ctx.api.call<{ order: OrderRead }>("orders.get", { path: { id: event.resource.id } });
      if (!read.ok || !read.data?.order) throw new Error(`orders.get failed: ${read.error?.code ?? read.status}`);
      const unpaid: string[] = [];
      const slip = slipOf(read.data.order, unpaid);
      // The merchant sees why a wrap the buyer chose is not on the slip.
      if (unpaid.length > 0) ctx.log.warn("A gift wrap on the order has no wrap add-on on its line; the slip leaves it unwrapped.", { orderId: read.data.order.id, lines: unpaid.length });
      if (!slip) return;
      // Keyed by the order: a redelivered event writes the same slip again.
      await ctx.objects.slips.put(slip.order_id, slip);
    },
  },

  routes: {
    admin: {
      slips: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { records, nextCursor } = await ctx.objects.slips.query({ orderBy: { field: "order_number", direction: "desc" }, limit: 25, cursor: adminContext(request).cursor });
        return {
          body: ui.page([
            ui.table({
              columns: [
                { key: "order", label: copy.order },
                { key: "items", label: copy.items, align: "end" },
                { key: "receipt", label: copy.prices },
              ],
              rows: records.map((record) => ({
                id: record.id,
                cells: {
                  order: { text: record.data.order_number ? `#${record.data.order_number}` : record.id, to: { kind: "resource", resource: "order", id: record.data.order_id as string } },
                  items: Array.isArray(record.data.lines) ? (record.data.lines as SlipLine[]).length : 0,
                  receipt: record.data.gift_receipt ? { badge: copy.leftOff, tone: "info" } : { badge: copy.shown },
                },
              })),
              pagination: { next: nextCursor },
              empty: { title: copy.emptyTitle, text: copy.emptyText },
            }),
          ], { title: copy.title, description: copy.description }),
        };
      },
      order_slip: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { id } = adminContext(request);
        const slip = id ? await ctx.objects.slips.get(id) : null;
        if (!slip) return { body: ui.view([ui.text(copy.none)]) };
        return { body: ui.view(slipView({ lines: (slip.lines ?? []) as SlipLine[], gift_receipt: Boolean(slip.gift_receipt) }, copy)) };
      },
    },
  },
});
