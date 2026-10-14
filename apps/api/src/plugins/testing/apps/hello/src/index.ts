// Scalius Hello: the reference plugin. It touches every capability so both
// loaders are exercised end to end: settings (with secrets), a storage
// collection with a compound and a unique index, KV with a TTL, event
// handlers that call an /api/v1 operation, an admin page, an order card, a
// bulk product action and a home widget (declarative UI), public routes on
// the storefront proxy with head tags, a signed provider webhook, a cron
// job, a checkout function and a lifecycle hook.

import {
  adminContext,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  type PluginContext,
  type PluginManifestInput,
} from "@scalius/plugin-sdk";

const DAY_MS = 24 * 60 * 60 * 1000;

export const manifest = {
  id: "acme.hello",
  name: "Hello",
  version: "0.4.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Greets paid orders, offers a welcome discount and shows what it did.",
  author: { name: "Scalius" },
  tagline: "An example app that uses every app surface",
  categories: ["marketing"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  scopes: ["read_orders"],
  events: ["order.paid", "order.created"],
  functions: [{ point: "checkout.discounts", priority: 100 }],
  routes: {
    admin: [
      { name: "dashboard", methods: ["GET"] },
      { name: "about", methods: ["GET"], description: "How Hello works, with its current settings." },
      { name: "reset", methods: ["POST"], description: "Resets the counters." },
      { name: "order-card", methods: ["GET"], description: "Whether an order was greeted." },
      { name: "wave", methods: ["POST"], description: "Waves at the selected products." },
      { name: "widget", methods: ["GET"], description: "The home widget's counts." },
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
    { key: "discount_percent", label: "Welcome discount (%)", type: "number", integer: true, min: 0, max: 50, default: 10, group: "discount" },
    { key: "min_subtotal_minor", label: "Minimum subtotal (minor units)", type: "number", integer: true, min: 0, default: 100000, group: "discount" },
    { key: "api_key", label: "API key", type: "secret", help: "Never shown again once saved.", group: "connection" },
    { key: "webhook_secret", label: "Webhook signing secret", type: "secret", help: "Signs pings sent to the ping webhook (HMAC-SHA256 of the body, hex, in x-hello-signature).", group: "connection" },
  ],
  settingsGroups: [
    { id: "discount", title: "Welcome discount", description: "The discount Hello offers at checkout." },
    { id: "connection", title: "Connection", description: "Keys for Hello's outside service and its webhook.", order: 200 },
  ],
  admin: {
    pages: [{
      id: "overview",
      title: "Hello",
      route: "dashboard",
      tabs: [{ id: "summary", title: "Summary", route: "dashboard" }, { id: "about", title: "How it works", route: "about" }],
    }],
    cards: [{ id: "greeting", target: "order", title: "Hello", route: "order-card" }],
    actions: [{ id: "wave", target: "product", label: "Wave hello", route: "wave", bulk: true }],
    widgets: [{ id: "summary", title: "Hello", route: "widget" }],
  },
  translations: {
    bn: {
      name: "হ্যালো",
      tagline: "অ্যাপের সব জায়গা ব্যবহার করা একটি উদাহরণ অ্যাপ",
      description: "পেমেন্ট হওয়া অর্ডারকে শুভেচ্ছা জানায়, স্বাগত ডিসকাউন্ট দেয় আর কী করেছে তা দেখায়।",
      pages: { overview: "হ্যালো" },
      tabs: { overview: { summary: "সারসংক্ষেপ", about: "কীভাবে কাজ করে" } },
      settingsGroups: { discount: { title: "স্বাগত ডিসকাউন্ট" }, connection: { title: "সংযোগ" } },
      settings: { greeting: { label: "শুভেচ্ছা" } },
      cards: { greeting: "হ্যালো" },
      actions: { wave: "হ্যালো জানান" },
      widgets: { summary: "হ্যালো" },
    },
  },
  storefront: {
    proxy: true,
    head: true,
  },
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
      dashboard: async (request, ctx) => {
        const [greeted, paid, created, page] = await Promise.all([
          greetings(ctx).count(),
          ctx.kv.get<number>("paid_count"),
          ctx.kv.get<number>("created_count"),
          greetings(ctx).query({ where: { kind: "paid" }, orderBy: { field: "createdAt", direction: "desc" }, limit: 10, cursor: adminContext(request).cursor }),
        ]);
        return {
          body: ui.page([
            ui.columns([
              ui.stat("Greeted orders", greeted),
              ui.stat("Paid events", paid ?? 0),
              ui.stat("New orders", created ?? 0),
            ]),
            ui.card("Recent greetings", [
              ui.table({
                columns: [{ key: "order", label: "Order" }, { key: "greeting", label: "Greeting" }, { key: "at", label: "When" }],
                rows: page.records.map((record) => ({
                  id: record.id,
                  to: ui.to.resource("order", record.id),
                  cells: {
                    order: { text: record.id, to: ui.to.resource("order", record.id) },
                    greeting: String(record.data.greeting ?? ""),
                    at: { date: new Date(Number(record.data.createdAt) || 0).toISOString() },
                  },
                })),
                pagination: { next: page.nextCursor },
                empty: { title: "No greetings yet", text: "Paid orders are greeted here." },
              }),
            ]),
            ui.text(`Store: ${ctx.store.name || "unnamed"}`, { tone: "neutral", size: "sm" }),
          ], {
            title: "Hello",
            description: "What the Hello app did for this store.",
            actions: [ui.button("Reset counters", { route: "reset" }, {
              tone: "critical",
              confirm: { title: "Reset the counters?", text: "Greetings stay; the counts start again at zero.", confirmLabel: "Reset", destructive: true },
            })],
          }),
        };
      },
      about: async (_request, ctx) => ({
        body: ui.page([
          ui.card("How Hello works", [
            ui.text("Hello greets each paid order, counts new orders and offers a welcome discount at checkout."),
            ui.keyValue([
              { label: "Greeting", value: String(ctx.settings.greeting ?? "Hello") },
              { label: "Welcome discount", value: `${Number(ctx.settings.discount_percent ?? 0)}%` },
            ]),
          ]),
        ], { title: "Hello" }),
      }),
      reset: async (request, ctx) => {
        await Promise.all([ctx.kv.delete("paid_count"), ctx.kv.delete("created_count"), ctx.kv.delete("greet_visits")]);
        ctx.log.info("Counters reset", { by: request.staffId });
        return { body: ui.result({ toast: "Counters reset.", refresh: true }) };
      },
      "order-card": async (request, ctx) => {
        const { id } = adminContext(request);
        const greeting = id ? await greetings(ctx).get(id) : null;
        return {
          body: ui.view(greeting
            ? [ui.badge("Greeted", "success"), ui.keyValue([{ label: "Greeting", value: String(greeting.greeting ?? "") }])]
            : [ui.text("Not greeted yet: Hello greets an order once it is paid.", { tone: "neutral", size: "sm" })]),
        };
      },
      wave: async (request, ctx) => {
        const { ids } = adminContext(request);
        if (ids.length === 0) return { status: 422, body: ui.result({ toast: { message: "Select at least one product.", tone: "critical" } }) };
        const waved = ((await ctx.kv.get<number>("waves")) ?? 0) + ids.length;
        await ctx.kv.set("waves", waved);
        ctx.log.info("Waved at products", { count: ids.length });
        return { body: ui.result({ toast: `${String(ctx.settings.greeting ?? "Hello")} to ${ids.length} product${ids.length === 1 ? "" : "s"}!` }) };
      },
      widget: async (_request, ctx) => {
        const [greeted, waves] = await Promise.all([greetings(ctx).count(), ctx.kv.get<number>("waves")]);
        return {
          body: ui.view([
            ui.columns([ui.stat("Greeted orders", greeted), ui.stat("Waves", waves ?? 0)]),
            ui.link("Open Hello", ui.to.page("overview")),
          ]),
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
