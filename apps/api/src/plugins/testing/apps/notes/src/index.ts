// Buyer UI dogfood: core owns the delivery input; account notes arrive as the
// buyer's `notes` record (a declared read). Neither surface returns HTML or
// runs browser code.
import { definePlugin, PLUGIN_API_VERSION, readOne, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.notes",
  name: "Notes",
  version: "1.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Shows short notes at checkout and in customer accounts.",
  author: { name: "Acme" },
  objects: { notes: { name: "Notes", fields: [{ key: "text", name: "Text", type: "multi_line_text" }] } },
  settings: [{ key: "delivery_note", label: "Delivery note", type: "text", default: "Orders before 2 pm ship today." }],
  checkout: { attributes: [{ key: "delivery_instructions", label: "Delivery instructions", type: "multiline", maxLength: 500 }] },
  functions: [{
    point: "buyer.ui",
    targets: ["purchase.checkout.contact.render-after", "customer-account.order-index.block.render"],
    reads: [{ as: "note", object: "notes", key: "customer" }],
  }],
} satisfies PluginManifestInput;

export default definePlugin({
  manifest,
  functions: {
    "buyer.ui": ({ target, reads }, settings) => {
      if (target === "customer-account.order-index.block.render") {
        const text = readOne(reads, "note")?.data.text;
        return { ui: { type: "text", text: typeof text === "string" ? text : "Earn points on every order." } };
      }
      return { ui: { type: "stack", children: [
        { type: "text", text: String(settings.delivery_note ?? "") },
        { type: "field", attribute: "delivery_instructions" },
      ] } };
    },
  },
});
