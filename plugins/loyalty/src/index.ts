// Scalius Loyalty (`scalius.loyalty`): a tiny points programme that proves an
// app can hold money-like state without ever spending it twice.
//
// - Earn (`order.paid`): points for every 100 of the store currency paid,
//   credited to the signed-in buyer's account in one atomic storage batch
//   with a ledger entry keyed by the order, so a redelivered event changes
//   nothing.
// - Redeem (`checkout.discounts` with a `snapshot` of `balances`): a buyer who
//   enters the redeem code gets a discount worth their points (at most the
//   items' value), and the function's answer `commit`s the reduced balance.
//   The platform writes that balance in the order's own commit batch at the
//   revision the function saw: if anything spent or earned points meanwhile,
//   the order fails and the buyer reviews it again. Two orders can never
//   spend the same points.
//
// Points are whole numbers. Refunds and cancellations do not return points
// in this example; the ledger keeps what each order earned for a merchant to
// adjust by hand.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "scalius.loyalty",
  name: "Loyalty points",
  version: "0.1.2",
  apiVersion: PLUGIN_API_VERSION,
  description: "Signed-in buyers earn points on paid orders and spend them at checkout with a code. Points are taken with the order itself, so they can never be spent twice.",
  author: { name: "Scalius" },
  tagline: "Points buyers earn on orders and spend at checkout",
  categories: ["loyalty",  "marketing"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  documentationUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/blob/mono-repo/plugins/loyalty/README.md",
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/loyalty",
  minPlatformVersion: "1.0.0",
  permissions: ["orders.view"],
  events: ["order.paid"],
  functions: [{ point: "checkout.discounts", priority: 200, snapshot: { collection: "balances" } }],
  storage: {
    // Record id: the buyer's customer id. `{ points, earned, spent }`.
    balances: {},
    // Record id: `earn:<order id>`. What an order earned, once.
    ledger: { indexes: ["customerId"] },
  },
  settings: [
    { key: "title", label: "Discount name at checkout", type: "text", required: true, default: "Loyalty points", maxLength: 40 },
    { key: "code", label: "Redeem code", type: "text", required: true, default: "POINTS", maxLength: 32, help: "Buyers enter this code at checkout to spend their points." },
    { key: "points_per_100", label: "Points per 100 spent", type: "number", integer: true, min: 0, max: 1000, default: 1 },
    { key: "point_value", label: "Value of one point", type: "number", min: 0.01, max: 1000, default: 1, help: "In your store currency." },
    { key: "min_redeem", label: "Fewest points to redeem", type: "number", integer: true, min: 1, max: 1_000_000, default: 50 },
  ],
  translations: {
    bn: {
      name: "লয়্যালটি পয়েন্ট",
      tagline: "অর্ডারে পয়েন্ট পান, চেকআউটে খরচ করুন",
      description: "সাইন-ইন করা ক্রেতারা পেমেন্ট হওয়া অর্ডারে পয়েন্ট পান আর চেকআউটে কোড দিয়ে খরচ করেন। পয়েন্ট অর্ডারের সঙ্গেই কাটা হয়, তাই কখনও দুবার খরচ করা যায় না।",
    },
  },
} satisfies PluginManifestInput;

export interface Balance extends Record<string, unknown> {
  points: number;
  earned: number;
  spent: number;
}

const EARN_ATTEMPTS = 8;

function wholeSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function balanceOf(data: Record<string, unknown> | null | undefined): Balance {
  const whole = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return { ...data, points: whole(data?.points), earned: whole(data?.earned), spent: whole(data?.spent) };
}

/** One point's value in the store currency's minor units (at least one). */
export function pointValueMinor(settings: Record<string, unknown>, decimalPlaces: number): number {
  const value = typeof settings.point_value === "number" && settings.point_value > 0 ? settings.point_value : 1;
  return Math.max(1, Math.round(value * 10 ** decimalPlaces));
}

/** Points an order of `totalMinor` earns. */
export function pointsEarned(totalMinor: number, settings: Record<string, unknown>, decimalPlaces: number): number {
  const per100 = wholeSetting(settings.points_per_100, 1);
  const hundred = 100 * 10 ** decimalPlaces;
  return per100 > 0 && totalMinor > 0 ? Math.floor((totalMinor * per100) / hundred) : 0;
}

interface PaidOrder {
  id: string;
  totalAmount: number;
  customerRecord: { id: string; kind: string } | null;
}

/**
 * Credits an order's points once: the ledger entry (must not exist yet) and
 * the new balance (at the revision read) commit together. A redelivery finds
 * the entry; a concurrent credit or spend is re-read and retried.
 */
async function earn(orderId: string, ctx: PluginContext): Promise<void> {
  const result = await ctx.api.call<PaidOrder>("dashboard.orders.get", { path: { id: orderId } });
  if (!result.ok || !result.data) {
    ctx.log.warn("Could not read the paid order", { orderId, status: result.status });
    if (result.status >= 500) throw new Error("The order could not be read; the event will be retried.");
    return;
  }
  const order = result.data;
  // Points belong to accounts: a guest order earns nothing.
  if (order.customerRecord?.kind !== "account") return;
  const customerId = order.customerRecord.id;
  const totalMinor = Math.round(order.totalAmount * 10 ** ctx.store.decimalPlaces);
  const points = pointsEarned(totalMinor, ctx.settings, ctx.store.decimalPlaces);
  if (points <= 0) return;

  const entryId = `earn:${orderId}`;
  for (let attempt = 1; attempt <= EARN_ATTEMPTS; attempt += 1) {
    if (await ctx.storage.ledger!.get(entryId)) return;
    const current = await ctx.storage.balances!.getVersion(customerId);
    const balance = balanceOf(current?.data);
    try {
      await ctx.storage.batch([
        { op: "put", collection: "ledger", id: entryId, record: { customerId, orderId, points }, expectedRevision: null },
        {
          op: "put",
          collection: "balances",
          id: customerId,
          record: { ...balance, points: balance.points + points, earned: balance.earned + points },
          expectedRevision: current?.revision ?? null,
        },
      ]);
      ctx.log.info("Points earned", { orderId, points });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "storage.conflict") throw error;
    }
  }
  throw new Error("Points could not be credited after concurrent changes; the event will be retried.");
}

export default definePlugin({
  manifest,

  events: {
    "order.paid": async (event, ctx) => earn(event.resource.id, ctx),
  },

  functions: {
    "checkout.discounts": ({ cart, snapshot }, settings) => {
      const code = String(settings.code ?? "").trim().toUpperCase();
      const entered = cart.discountCodes.some((value) => value.trim().toUpperCase() === code);
      if (!cart.customer || !snapshot || !code || !entered) return { discounts: [] };
      const balance = balanceOf(snapshot.data);
      const valueMinor = pointValueMinor(settings, cart.decimalPlaces);
      const itemsMinor = cart.lines.reduce((total, line) => total + line.lineTotalMinor, 0);
      // Spend what the items are worth, never more than the balance.
      const spend = Math.min(balance.points, Math.floor(itemsMinor / valueMinor));
      if (spend < Math.max(1, wholeSetting(settings.min_redeem, 50))) return { discounts: [] };
      const amountMinor = spend * valueMinor;
      const title = String(settings.title ?? "").trim().slice(0, 40) || "Loyalty points";
      return {
        discounts: [{
          title: `${title} (${spend} points)`.slice(0, 80),
          code,
          target: { kind: "order" as const },
          value: { type: "fixed_amount" as const, amountMinor },
          maxAmountMinor: amountMinor,
        }],
        commit: { record: { ...balance, points: balance.points - spend, spent: balance.spent + spend } },
      };
    },
  },
});
