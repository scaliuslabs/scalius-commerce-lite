// Scalius Order tagger: a small, realistic plugin built only on the public
// plugin API. When an order is paid it reads the order through the store's
// own operations (`ctx.api`, as the dashboard and agents do), adds a note to
// the order's timeline, sets its own `tag` custom field on the order, and
// remembers the order so a redelivered event changes nothing.
//
// Idempotent three ways, as every event handler should be: its own record
// (checked first), the timeline note's request key (derived from the event
// id, so the API returns the first note on a replay) and the custom field
// (setting the same value again is a no-op for the merchant).

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "scalius.order-tagger",
  name: "Order tagger",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Tags new paid orders and notes them on the order timeline, so your team sees at a glance what to pack.",
  author: { name: "Scalius" },
  permissions: ["orders.view", "orders.edit"],
  events: ["order.paid"],
  routes: {
    admin: [{ name: "summary", methods: ["GET"] }],
    public: [],
    webhooks: [],
  },
  storage: {
    tagged: { indexes: ["taggedAt"] },
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
  },
} satisfies PluginManifestInput;

interface TaggedRecord extends Record<string, unknown> {
  orderId: string;
  /** Null when the order was below the minimum and left alone. */
  tag: string | null;
  taggedAt: number;
}

function tagged(ctx: PluginContext) {
  const collection = ctx.storage.tagged;
  if (!collection) throw new Error("The tagged collection is not declared.");
  return collection;
}

export default definePlugin({
  manifest,

  events: {
    "order.paid": async (event, ctx) => {
      const orderId = event.resource.id;
      if (await tagged(ctx).get(orderId)) return;

      const order = await ctx.api.call<{ totalAmount?: number }>("dashboard.orders.get", { path: { id: orderId } });
      if (!order.ok) throw new Error(`The order could not be read (${order.error?.code ?? order.status}).`);
      const taggedAt = Date.parse(event.occurredAt) || 0;
      const minimum = Number(ctx.settings.min_total ?? 0);
      if (Number(order.data?.totalAmount ?? 0) < minimum) {
        await tagged(ctx).put(orderId, { orderId, tag: null, taggedAt } satisfies TaggedRecord);
        ctx.log.info("Left an order below the minimum untagged", { orderId });
        return;
      }

      const tag = String(ctx.settings.tag ?? "").trim() || "paid";
      const note = String(ctx.settings.note ?? "").trim();
      const comment = await ctx.api.call("dashboard.orders.comment_add", {
        path: { id: orderId },
        body: { body: note ? `#${tag} · ${note}` : `#${tag}`, requestKey: `order-tagger_${event.id}` },
      });
      if (!comment.ok) throw new Error(`The timeline note could not be added (${comment.error?.code ?? comment.status}).`);
      await ctx.customFields.set("order", orderId, { tag });
      await tagged(ctx).put(orderId, { orderId, tag, taggedAt } satisfies TaggedRecord);
      ctx.log.info("Tagged a paid order", { orderId, tag });
    },
  },

  routes: {
    admin: {
      summary: async (_request, ctx) => {
        const [count, recent] = await Promise.all([
          tagged(ctx).count(),
          tagged(ctx).query({ orderBy: { field: "taggedAt", direction: "desc" }, limit: 10 }),
        ]);
        return {
          body: {
            type: "page",
            title: "Order tagger",
            children: [
              { type: "stat", label: "Orders handled", value: count },
              {
                type: "list",
                items: recent.records.map((record) => ({
                  id: record.id,
                  title: String(record.data.orderId),
                  subtitle: record.data.tag === null ? "Below the minimum" : `#${String(record.data.tag)}`,
                })),
              },
            ],
          },
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
