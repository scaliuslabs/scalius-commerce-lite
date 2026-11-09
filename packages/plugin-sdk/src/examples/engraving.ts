// A complete app that asks the buyer one line input, prices it and reads it back on the order.
import { defineManifest, definePlugin, PLUGIN_API_VERSION, textFor, type OrderRepresentation } from "@scalius/plugin-sdk";

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
  // "block": if pricing fails, checkout stops. The default, "skip", would sell the engraving without its fee.
  functions: [{ point: "cart.line_prices", onError: "block" }],
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
  // Every word in Bangla too: a Bangla buyer's buy form, cart and order line, and a Bangla dashboard.
  translations: {
    bn: {
      name: "খোদাই",
      description: "যেকোনো পণ্যে নাম খোদাই করুন, দাম প্রতি অক্ষরে।",
      settings: { per_letter: { label: "প্রতি অক্ষরের দাম (স্টোরের মুদ্রায়)" } },
      checkout: { lineInputs: { text: { label: "খোদাই", help: "সর্বোচ্চ ২০টি অক্ষর।" } } },
      objects: { engravings: { name: "খোদাই", fields: { order_id: { name: "অর্ডার" }, text: { name: "লেখা" } } } },
    },
  },
});

export default definePlugin({
  manifest,
  functions: {
    // The fee is the merchant's, in the store's currency: checkout converts it for any market.
    // Every engraved line is answered, a free one as 0 and a bundle line too: the order line
    // records what was sold, and checkout refuses an add-on a line can't take.
    "cart.line_prices": ({ cart, language }, settings) => {
      const perLetter = Math.max(0, Math.round(Number(settings.per_letter ?? 0) * 10 ** cart.storeCurrency.decimalPlaces) || 0);
      return {
        prices: [],
        adjustments: cart.lines.flatMap((line) => {
          const letters = (line.properties[TEXT] ?? "").replace(/\s/gu, "").length;
          if (letters === 0) return [];
          // The add-on's title is the buyer's, in their language (`input.language`).
          const title = textFor(language, { en: `Engraving, ${letters} letters`, bn: `খোদাই, ${letters}টি অক্ষর` });
          return [{ lineId: line.lineId, amountMinor: perLetter * letters, currency: "store" as const, title }];
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
        // Engrave only what checkout sold: your add-on is on the line (0 when it was free).
        const sold = line.adjustments.some((adjustment) => adjustment.appId === APP_ID);
        // Keyed by the order line: a redelivered event writes the same record again.
        if (text && sold) await ctx.objects.engravings.put(line.id, { order_id: order.id, text });
      }
    },
  },
});
