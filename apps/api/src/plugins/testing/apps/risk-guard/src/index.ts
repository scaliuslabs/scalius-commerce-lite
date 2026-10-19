// Risk guard (`acme.risk-guard`): order risk as a reaction after commit. A
// decision inside a request is a function; a provider of a capability is a
// port; a reaction after the order commits is an event. This app handles
// `order.created`, reads the buyer's earlier orders (counts only), records
// its advice on the order and holds a risky one for staff review. Every
// action is idempotent per order and app, so a redelivered event changes
// nothing.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.risk-guard",
  name: "Risk guard",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Rates every new order from the buyer's earlier cancellations and returns, and holds risky ones for review.",
  author: { name: "Acme" },
  scopes: ["read_orders", "write_orders"],
  events: ["order.created"],
  settings: [{ key: "hold_after", label: "Hold after this many cancelled or returned orders", type: "number", integer: true, min: 1, max: 100, default: 2 }],
} satisfies PluginManifestInput;

export default definePlugin({
  manifest,
  events: {
    "order.created": async (event, ctx) => {
      const orderId = event.resource.id;
      const history = await ctx.orders.riskHistory(orderId);
      const troubled = history.cancelled + history.returnedToSender;
      const holdAfter = typeof ctx.settings.hold_after === "number" ? ctx.settings.hold_after : 2;
      const level = troubled >= holdAfter ? "high" : troubled > 0 ? "medium" : "low";
      const reasons = troubled > 0 ? [`${troubled} of ${history.orders} earlier orders were cancelled or returned.`] : [];
      await ctx.orders.assessRisk({ orderId, level, reasons });
      if (level === "high") await ctx.orders.hold({ orderId, reason: reasons[0]! });
    },
  },
});
