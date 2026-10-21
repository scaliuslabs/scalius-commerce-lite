// Scalius Order tagger: a small, realistic plugin built only on the public
// plugin API. When an order is paid it reads the order through the store's
// own operations (`ctx.api`, as the dashboard and agents do), adds a typed
// line to the order's timeline (`ctx.timeline`), sets its own `tag` custom
// field on the order, and remembers the order so a redelivered event changes
// nothing.
//
// Idempotent three ways, as every event handler should be: its own record
// (checked first), the timeline line's idempotency key (the event id, so a
// replay adds nothing) and the custom field (setting the same value again is
// a no-op for the merchant).

import { adminContext, definePlugin, PLUGIN_API_VERSION, ui, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.order-tagger",
  name: "Order tagger",
  version: "0.1.3",
  apiVersion: PLUGIN_API_VERSION,
  description: "Tags new paid orders and notes them on the order timeline, so your team sees at a glance what to pack.",
  author: { name: "Scalius" },
  tagline: "Tag paid orders so your team knows what to pack",
  categories: ["orders",  "operations"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  scopes: ["write_orders"],
  events: ["order.paid"],
  routes: {
    admin: [{ name: "summary", methods: ["GET"] }],
    public: [],
    webhooks: [],
  },
  objects: {
    tagged: {
      name: "Tagged orders",
      fields: [
        { key: "order_id", name: "Order", type: "single_line_text" },
        { key: "order_number", name: "Order number", type: "integer" },
        { key: "tag", name: "Tag", type: "single_line_text" },
        { key: "tagged_at", name: "Tagged at", type: "integer" },
      ],
      indexes: ["tagged_at"],
    },
  },
  customFields: [
    { ownerType: "order", key: "tag", name: "Tag", type: "single_line_text", description: "Set by Order tagger when the order is paid." },
  ],
  settings: [
    { key: "tag", label: "Tag", type: "text", required: true, default: "paid", maxLength: 40, help: "Shown on the order and at the start of the timeline note." },
    { key: "note", label: "Timeline note", type: "textarea", default: "Payment received. Ready to pack.", maxLength: 500 },
    { key: "min_total", label: "Only orders of at least", type: "number", min: 0, default: 0, help: "In your store currency. 0 tags every paid order." },
  ],
  admin: {
    pages: [{ id: "overview", title: "Order tagger", route: "summary" }],
    timeline: [{ kind: "tagged", title: "Order tagged" }],
  },
  translations: {
    bn: {
      name: "অর্ডার ট্যাগার",
      tagline: "পেমেন্ট হওয়া অর্ডারে ট্যাগ, যাতে টিম জানে কী প্যাক করতে হবে",
      description: "পেমেন্ট হওয়া নতুন অর্ডারে ট্যাগ দেয় আর অর্ডারের টাইমলাইনে নোট রাখে, যাতে আপনার টিম এক নজরে বোঝে কী প্যাক করতে হবে।",
      pages: { overview: "অর্ডার ট্যাগার" },
      timeline: { tagged: "অর্ডারে ট্যাগ দেওয়া হয়েছে" },
    },
  },
} satisfies PluginManifestInput;

interface TaggedRecord extends Record<string, unknown> {
  order_id: string;
  /** The order's number staff know it by (#1073); missing on records kept before 0.1.2. */
  order_number?: number | null;
  /** Null when the order was below the minimum and left alone. */
  tag: string | null;
  tagged_at: number;
}

/** The dashboard page's words, in the staff member's dashboard language (`adminContext().locale`). */
const ADMIN_TEXT = {
  en: {
    title: "Order tagger",
    description: "Paid orders this app tagged and noted on their timeline.",
    handled: "Orders handled",
    recent: "Recent orders",
    order: "Order",
    tag: "Tag",
    paid: "Paid",
    openOrder: "Open order",
    belowMinimum: "Below the minimum",
    emptyTitle: "No paid orders yet",
    emptyText: "Orders show here once they are paid.",
  },
  bn: {
    title: "অর্ডার ট্যাগার",
    description: "পেমেন্ট হওয়া যে অর্ডারে এই অ্যাপ ট্যাগ দিয়েছে আর টাইমলাইনে নোট রেখেছে।",
    handled: "যত অর্ডার দেখা হয়েছে",
    recent: "সাম্প্রতিক অর্ডার",
    order: "অর্ডার",
    tag: "ট্যাগ",
    paid: "পেমেন্ট",
    openOrder: "অর্ডার খুলুন",
    belowMinimum: "সর্বনিম্ন অঙ্কের কম",
    emptyTitle: "এখনও পেমেন্ট হওয়া কোনো অর্ডার নেই",
    emptyText: "পেমেন্ট হলে অর্ডারগুলো এখানে দেখা যাবে।",
  },
} as const;

function tagged(ctx: PluginContext) {
  const collection = ctx.objects.tagged;
  if (!collection) throw new Error("The tagged object is not declared.");
  return collection;
}

export default definePlugin({
  manifest,

  events: {
    "order.paid": async (event, ctx) => {
      const orderId = event.resource.id;
      if (await tagged(ctx).get(orderId)) return;

      const read = await ctx.api.call<{ order?: { totalMinor?: number; orderNumber?: number | null } }>("orders.get", { path: { id: orderId } });
      if (!read.ok) throw new Error(`The order could not be read (${read.error?.code ?? read.status}).`);
      const order = read.data?.order;
      const taggedAt = Date.parse(event.occurredAt) || 0;
      const orderNumber = typeof order?.orderNumber === "number" ? order.orderNumber : null;
      // The setting is in major units of the store currency; the order is in minor units.
      const minimumMinor = Math.round(Number(ctx.settings.min_total ?? 0) * 10 ** ctx.store.decimalPlaces);
      if (Number(order?.totalMinor ?? 0) < minimumMinor) {
        await tagged(ctx).put(orderId, { order_id: orderId, order_number: orderNumber, tag: null, tagged_at: taggedAt } satisfies TaggedRecord);
        ctx.log.info("Left an order below the minimum untagged", { orderId });
        return;
      }

      const tag = String(ctx.settings.tag ?? "").trim() || "paid";
      const note = String(ctx.settings.note ?? "").trim();
      await ctx.timeline.add({
        orderId,
        kind: "tagged",
        message: note ? `#${tag} · ${note}` : `#${tag}`,
        fields: { tag },
        idempotencyKey: event.id,
      });
      await ctx.customFields.set("order", orderId, { tag });
      await tagged(ctx).put(orderId, { order_id: orderId, order_number: orderNumber, tag, tagged_at: taggedAt } satisfies TaggedRecord);
      ctx.log.info("Tagged a paid order", { orderId, tag });
    },
  },

  routes: {
    admin: {
      // A UI document (`ui.page`), which the dashboard checks and draws with its own components.
      summary: async (request, ctx) => {
        const { cursor, locale } = adminContext(request);
        const t = ADMIN_TEXT[locale];
        const [count, recent] = await Promise.all([
          tagged(ctx).count(),
          tagged(ctx).query({ orderBy: { field: "tagged_at", direction: "desc" }, limit: 10, cursor }),
        ]);
        return {
          body: ui.page([
            ui.stat(t.handled, count),
            ui.card(t.recent, [
              ui.table({
                columns: [{ key: "order", label: t.order }, { key: "tag", label: t.tag }, { key: "at", label: t.paid }],
                rows: recent.records.map((record) => {
                  const orderId = String(record.data.order_id);
                  const orderNumber = Number(record.data.order_number);
                  return {
                    id: record.id,
                    to: ui.to.resource("order", orderId),
                    cells: {
                      // Staff know an order by its number, never its internal id.
                      order: { text: orderNumber > 0 ? `#${orderNumber}` : t.openOrder, to: ui.to.resource("order", orderId) },
                      tag: record.data.tag == null
                        ? { badge: t.belowMinimum, tone: "neutral" as const }
                        : { badge: `#${String(record.data.tag)}`, tone: "success" as const },
                      at: { date: new Date(Number(record.data.tagged_at) || 0).toISOString() },
                    },
                  };
                }),
                pagination: { next: recent.nextCursor },
                empty: { title: t.emptyTitle, text: t.emptyText },
              }),
            ]),
          ], { title: t.title, description: t.description }),
        };
      },
    },
  },

  lifecycle: {
    activate: (ctx) => {
      ctx.log.info("Order tagger is on", { tag: ctx.settings.tag });
    },
  },
});
