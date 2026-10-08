// Test app: checkout and customer-account blocks. A delivery note at the
// checkout's contact step (from the app's settings, with a form the platform
// must drop: checkout blocks hold none) and a loyalty note on the account's
// orders list (from a collection it declares in `reads`, with a proxy form
// that stays).
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Shows short notes at checkout and in customer accounts.",
  author: { name: "Acme" },
  routes: {
    admin: [],
    public: [
      { name: "checkout-note", methods: ["GET"] },
      { name: "orders-note", methods: ["GET"] },
      { name: "join", methods: ["POST"] },
    ],
    webhooks: [],
  },
  storage: { notes: { indexes: [], unique: [] } },
  settings: [{ key: "delivery_note", label: "Delivery note", type: "text", default: "Orders before 2 pm ship today." }],
  storefront: {
    proxy: true,
    blocks: [
      { type: "delivery", name: "Delivery note", target: "purchase.checkout.contact.render-after", route: "checkout-note" },
      { type: "loyalty", name: "Loyalty note", target: "customer-account.order-index.block.render", route: "orders-note", reads: ["notes"] },
    ],
  },
} satisfies PluginManifestInput;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export default definePlugin({
  manifest,
  routes: {
    public: {
      "checkout-note": (_request, ctx) => ({
        body: {
          html: `<p class="text-sm">${escapeHtml(String(ctx.settings.delivery_note ?? ""))}</p><form action="/apps/acme.notes/join" method="post"><button type="submit">Join</button></form>`,
        },
      }),
      "orders-note": async (_request, ctx) => {
        const note = await ctx.storage.notes!.get("account");
        const text = typeof note?.text === "string" ? note.text : "Earn points on every order.";
        return {
          body: {
            html: `<p class="text-sm">${escapeHtml(text)}</p><form action="/apps/acme.notes/join" method="post"><button type="submit">Join</button></form>`,
          },
        };
      },
      join: () => ({ body: { redirect: "/account" } }),
    },
  },
});
