// Scalius Hello: the reference plugin. It touches every capability so both
// loaders are exercised end to end: settings (with secrets), a storage
// collection with a compound and a unique index, KV with a TTL, event
// handlers that call an /api/v1 operation, admin page and action routes,
// public routes on the storefront proxy, a signed provider webhook, a cron
// job, a checkout function and a lifecycle hook.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

const DAY_MS = 24 * 60 * 60 * 1000;

export const manifest = {
  id: "scalius.hello",
  name: "Hello",
  version: "0.2.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Greets paid orders, offers a welcome discount and shows what it did.",
  author: { name: "Scalius" },
  permissions: ["orders.view"],
  events: ["order.paid", "order.created"],
  functions: [{ point: "checkout.discounts", priority: 100 }],
  routes: {
    admin: [
      { name: "dashboard", methods: ["GET"] },
      { name: "reset", methods: ["POST"], description: "Resets the counters." },
    ],
    public: [
      { name: "greet", methods: ["GET"] },
      { name: "visits", methods: ["GET", "POST"] },
    ],
    webhooks: ["ping"],
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
    { key: "webhook_secret", label: "Webhook signing secret", type: "secret", help: "Signs pings sent to the ping webhook (HMAC-SHA256 of the body, hex, in x-hello-signature)." },
  ],
  admin: {
    pages: [{ id: "overview", title: "Hello", route: "dashboard" }],
  },
  storefront: { proxy: true },
} satisfies PluginManifestInput;

function greetings(ctx: PluginContext) {
  const collection = ctx.storage.greetings;
  if (!collection) throw new Error("The greetings collection is not declared.");
  return collection;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
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
    "order.created": async (event, ctx) => {
      // Idempotent by event id: a redelivered event is counted once.
      const seen = `created:${event.id}`;
      if (await ctx.kv.get(seen)) return;
      await ctx.kv.set(seen, true, { ttlSeconds: 7 * 24 * 60 * 60 });
      const created = (await ctx.kv.get<number>("created_count")) ?? 0;
      await ctx.kv.set("created_count", created + 1);
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
        const [greeted, paid, created] = await Promise.all([
          greetings(ctx).count(),
          ctx.kv.get<number>("paid_count"),
          ctx.kv.get<number>("created_count"),
        ]);
        return {
          body: {
            type: "page",
            title: "Hello",
            children: [
              { type: "stat", label: "Greeted orders", value: greeted },
              { type: "stat", label: "Paid events", value: paid ?? 0 },
              { type: "stat", label: "New orders", value: created ?? 0 },
              { type: "text", value: `Store: ${ctx.store.name || "unnamed"}` },
            ],
          },
        };
      },
      reset: async (request, ctx) => {
        await Promise.all([ctx.kv.delete("paid_count"), ctx.kv.delete("created_count"), ctx.kv.delete("greet_visits")]);
        ctx.log.info("Counters reset", { by: request.staffId });
        return { body: { reset: true } };
      },
    },
    public: {
      greet: async (request, ctx) => {
        const name = (request.query.name ?? "").trim().slice(0, 40) || "friend";
        const visits = ((await ctx.kv.get<number>("greet_visits")) ?? 0) + 1;
        await ctx.kv.set("greet_visits", visits, { ttlSeconds: DAY_MS / 1000 });
        return { body: { message: `${String(ctx.settings.greeting ?? "Hello")}, ${name}!`, visits } };
      },
      visits: async (request, ctx) => {
        if (request.method === "GET") {
          return { headers: { "cache-control": "public, max-age=60" }, body: { visits: (await ctx.kv.get<number>("greet_visits")) ?? 0 } };
        }
        const body = (request.body ?? {}) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
        if (!name) return { status: 422, body: { error: "Tell us your name." } };
        const visits = ((await ctx.kv.get<number>("greet_visits")) ?? 0) + 1;
        await ctx.kv.set("greet_visits", visits, { ttlSeconds: DAY_MS / 1000 });
        return { status: 201, body: { message: `Welcome, ${name}!`, visits } };
      },
    },
    webhooks: {
      ping: async (request, ctx) => {
        const secret = ctx.settings.webhook_secret;
        if (typeof secret !== "string" || !secret) return { status: 503, body: { error: "The webhook secret is not set." } };
        const signature = request.headers["x-hello-signature"] ?? "";
        if (!sameText(signature, await hmacHex(secret, request.rawBody ?? ""))) return { status: 401, body: { error: "Bad signature." } };
        await ctx.kv.set("last_ping", request.body ?? request.rawBody);
        ctx.log.info("Ping received", { bytes: (request.rawBody ?? "").length });
        return { body: { received: true } };
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
