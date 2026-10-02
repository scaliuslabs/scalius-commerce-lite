// Scalius Hello: the reference plugin. It touches every P1 capability so both
// loaders are exercised end to end: settings (with a secret), a storage
// collection with a compound and a unique index, KV with a TTL, an event
// handler that calls an /api/v1 operation, an admin page route, a public
// route, a cron job, a checkout function and a lifecycle hook.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

const DAY_MS = 24 * 60 * 60 * 1000;

export const manifest = {
  id: "scalius.hello",
  name: "Hello",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Greets paid orders, offers a welcome discount and shows what it did.",
  author: { name: "Scalius" },
  permissions: ["orders.view"],
  events: ["order.paid"],
  functions: [{ point: "checkout.discounts", priority: 100 }],
  routes: {
    admin: [{ name: "dashboard", methods: ["GET"] }],
    public: [{ name: "greet", methods: ["GET"] }],
    webhooks: [],
  },
  cron: [{ name: "tidy", schedule: "0 * * * *" }],
  storage: {
    greetings: { indexes: ["orderId", ["kind", "createdAt"]], unique: ["orderId"] },
  },
  settings: [
    { key: "greeting", label: "Greeting", type: "text", default: "Hello" },
    { key: "discount_percent", label: "Welcome discount (%)", type: "number", integer: true, min: 0, max: 50, default: 10 },
    { key: "min_subtotal_minor", label: "Minimum subtotal (minor units)", type: "number", integer: true, min: 0, default: 100000 },
    { key: "api_key", label: "API key", type: "secret", help: "Never shown again once saved." },
  ],
  admin: {
    pages: [{ id: "overview", title: "Hello", route: "dashboard" }],
  },
} satisfies PluginManifestInput;

function greetings(ctx: PluginContext) {
  const collection = ctx.storage.greetings;
  if (!collection) throw new Error("The greetings collection is not declared.");
  return collection;
}

export default definePlugin({
  manifest,

  events: {
    "order.paid": async (event, ctx) => {
      const orderId = event.resource.id;
      const order = await ctx.api.call<{ id?: string; status?: string }>("dashboard.orders.get", { path: { id: orderId } });
      await greetings(ctx).put(orderId, {
        orderId,
        kind: "paid",
        createdAt: Date.parse(event.occurredAt) || 0,
        greeting: String(ctx.settings.greeting ?? "Hello"),
        orderStatus: order.ok ? order.data?.status ?? null : null,
      });
      const paid = (await ctx.kv.get<number>("paid_count")) ?? 0;
      await ctx.kv.set("paid_count", paid + 1);
      ctx.log.info("Greeted a paid order", { orderId, apiStatus: order.status });
    },
  },

  functions: {
    "checkout.discounts": (input, settings) => {
      const percent = Number(settings.discount_percent ?? 0);
      const minimum = Number(settings.min_subtotal_minor ?? 0);
      if (!(percent > 0) || input.cart.subtotalMinor < minimum) return { discounts: [] };
      return {
        discounts: [{
          title: `${String(settings.greeting ?? "Hello")} discount`,
          target: { kind: "order" },
          value: { type: "percentage", percent },
        }],
      };
    },
  },

  routes: {
    admin: {
      dashboard: async (_request, ctx) => {
        const [greeted, paid] = await Promise.all([greetings(ctx).count(), ctx.kv.get<number>("paid_count")]);
        return {
          body: {
            type: "page",
            title: "Hello",
            children: [
              { type: "stat", label: "Greeted orders", value: greeted },
              { type: "stat", label: "Paid events", value: paid ?? 0 },
              { type: "text", value: `Store: ${ctx.store.name || "unnamed"}` },
            ],
          },
        };
      },
    },
    public: {
      greet: async (request, ctx) => {
        const name = (request.query.name ?? "").trim().slice(0, 40) || "friend";
        const visits = ((await ctx.kv.get<number>("greet_visits")) ?? 0) + 1;
        await ctx.kv.set("greet_visits", visits, { ttlSeconds: DAY_MS / 1000 });
        return { body: { message: `${String(ctx.settings.greeting ?? "Hello")}, ${name}!`, visits } };
      },
    },
  },

  cron: {
    tidy: async (ctx, run) => {
      const cutoff = Date.parse(run.scheduledAt) - 30 * DAY_MS;
      const page = await greetings(ctx).query({
        where: { kind: "paid" },
        orderBy: { field: "createdAt", direction: "asc" },
        limit: 100,
      });
      let removed = 0;
      for (const record of page.records) {
        if (Number(record.data.createdAt) >= cutoff) break;
        if (await greetings(ctx).delete(record.id)) removed += 1;
      }
      ctx.log.info("Tidied old greetings", { removed });
    },
  },

  lifecycle: {
    activate: (ctx) => {
      ctx.log.info("Hello is active", { greeting: ctx.settings.greeting });
    },
  },
});
