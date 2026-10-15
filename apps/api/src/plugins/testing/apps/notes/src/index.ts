// Buyer UI dogfood: core owns the delivery input; account notes arrive as a
// customer-scoped snapshot. Neither surface returns HTML or runs browser code.
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Shows short notes at checkout and in customer accounts.",
  author: { name: "Acme" },
  objects: { notes: { name: "Notes", fields: [{ key: "text", name: "Text", type: "multi_line_text" }] } },
  settings: [{ key: "delivery_note", label: "Delivery note", type: "text", default: "Orders before 2 pm ship today." }],
  checkout: { attributes: [{ key: "delivery_instructions", label: "Delivery instructions", type: "multiline", maxLength: 500 }] },
  functions: [{
    point: "buyer.ui",
    targets: ["purchase.checkout.contact.render-after", "customer-account.order-index.block.render"],
    snapshot: { object: "notes" },
  }],
} satisfies PluginManifestInput;

export default definePlugin({
  manifest,
  functions: {
    "buyer.ui": ({ target, snapshot }, settings) => {
      if (target === "customer-account.order-index.block.render") {
        return { ui: { type: "text", text: typeof snapshot?.data.text === "string" ? snapshot.data.text : "Earn points on every order." } };
      }
      return { ui: { type: "stack", children: [
        { type: "text", text: String(settings.delivery_note ?? "") },
        { type: "field", attribute: "delivery_instructions" },
      ] } };
    },
  },
});
