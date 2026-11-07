// A complete app that asks the buyer one line input, prices it and reads it back on the order.
import { defineManifest, definePlugin, PLUGIN_API_VERSION, type OrderRepresentation } from "@scalius/plugin-sdk";

const APP_ID = "acme.engraving";
const TEXT = `${APP_ID}.text`;

export const manifest = defineManifest({
  id: APP_ID,
  name: "Engraving",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Engrave a name on any item, priced per letter.",
  author: { name: "Acme" },
  scopes: ["read_orders"],
  events: ["order.created"],
  settings: [{ key: "per_letter", label: "Price per letter (store currency)", type: "number", default: 20 }],
  functions: [{ point: "cart.line_prices" }],
  checkout: {
    // Drawn on the buy form after the product's own inputs, under `acme.engraving.text`.
    lineInputs: [{ key: "text", label: "Engraving", type: "text", maxLength: 20, help: "Up to 20 letters." }],
  },
  objects: {
    engravings: {
      name: "Engravings",
      fields: [
        { key: "order_id", name: "Order", type: "order_reference", required: true },
        { key: "text", name: "Text", type: "single_line_text", required: true },
      ],
      indexes: ["order_id"],
    },
  },
});

export default definePlugin({
  manifest,
  functions: {
    // The fee is the merchant's, in the store's currency: checkout converts it for any market.
    "cart.line_prices": ({ cart, lines }, settings) => {
      const perLetter = Math.round(Number(settings.per_letter ?? 0) * 10 ** cart.storeCurrency.decimalPlaces);
      const bundled = new Set(lines.filter((line) => line.bundle).map((line) => line.lineId));
      return {
        prices: [],
        adjustments: cart.lines.flatMap((line) => {
          const letters = (line.properties[TEXT] ?? "").replace(/\s/gu, "").length;
          if (letters === 0 || perLetter <= 0 || bundled.has(line.lineId)) return [];
          return [{ lineId: line.lineId, amountMinor: perLetter * letters, currency: "store" as const, title: `Engraving, ${letters} letters` }];
        }),
      };
    },
  },
  events: {
    // Read the answer back from the order line: yours and the store's, never another app's.
    "order.created": async (event, ctx) => {
      const read = await ctx.api.call<{ order: OrderRepresentation }>("orders.get", { path: { id: event.resource.id } });
      if (!read.ok || !read.data) throw new Error(`orders.get failed: ${read.error?.code ?? read.status}`);
      const order = read.data.order;
      for (const line of order.lines) {
        const text = line.properties.find((property) => property.key === TEXT)?.value;
        // Keyed by the order line: a redelivered event writes the same record again.
        if (text) await ctx.objects.engravings.put(line.id, { order_id: order.id, text });
      }
    },
  },
});
