// Scalius Bulk discount: a tiered quantity discount and a per-line quantity
// limit, built only on checkout functions. Proves the function path end to
// end in both loaders: `checkout.discounts` returns the tier the cart earned
// (the platform stacks it after the store's own discounts, caps and rounds
// it), and `cart.validate` blocks a line over the limit on that line.
//
// Pure: no storage, no network, no API calls. Everything comes from the cart
// checkout passes in and the merchant's settings.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.bulk-discount",
  name: "Bulk discount",
  version: "0.1.2",
  apiVersion: PLUGIN_API_VERSION,
  description: "Gives a bigger discount the more a buyer orders (up to three tiers), and can cap how many of one item fit in an order.",
  author: { name: "Scalius" },
  tagline: "Bigger discounts for bigger orders",
  categories: ["pricing"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  functions: [
    { point: "checkout.discounts", priority: 100 },
    { point: "cart.validate", priority: 100 },
  ],
  settings: [
    { key: "title", label: "Discount name at checkout", type: "text", required: true, default: "Bulk savings", maxLength: 60 },
    {
      key: "count_by",
      label: "Count quantity",
      type: "select",
      default: "line",
      options: [
        { value: "line", label: "Per item (each item's own quantity)" },
        { value: "cart", label: "Across the cart (all items together)" },
      ],
    },
    { key: "tier1_quantity", label: "Tier 1: from quantity", type: "number", integer: true, min: 2, max: 1000, default: 3 },
    { key: "tier1_percent", label: "Tier 1: percent off", type: "number", min: 0, max: 90, default: 5 },
    { key: "tier2_quantity", label: "Tier 2: from quantity", type: "number", integer: true, min: 2, max: 1000, default: 6 },
    { key: "tier2_percent", label: "Tier 2: percent off", type: "number", min: 0, max: 90, default: 10, help: "0 turns the tier off." },
    { key: "tier3_quantity", label: "Tier 3: from quantity", type: "number", integer: true, min: 2, max: 1000, default: 12 },
    { key: "tier3_percent", label: "Tier 3: percent off", type: "number", min: 0, max: 90, default: 0, help: "0 turns the tier off." },
    { key: "max_discount", label: "Most it can take off", type: "number", min: 0, default: 0, help: "In your store currency, per discount. 0 means no cap." },
    { key: "code", label: "Only with this code", type: "text", maxLength: 40, help: "Leave empty to apply it automatically; set a code to give it only to buyers who enter it." },
    { key: "max_quantity_per_line", label: "Most of one item per order", type: "number", integer: true, min: 0, max: 99, default: 0, help: "0 means no limit. A cart over it can't check out until the buyer lowers the quantity." },
    { key: "max_quantity_message", label: "Message when over the limit", type: "text", maxLength: 160, default: "You can buy at most {max} of this item in one order." },
  ],
  translations: {
    bn: {
      name: "বাল্ক ডিসকাউন্ট",
      tagline: "বড় অর্ডারে বড় ডিসকাউন্ট",
      description: "ক্রেতা যত বেশি কেনেন, ডিসকাউন্ট তত বড় (তিন ধাপ পর্যন্ত); এক অর্ডারে একটি প্রোডাক্ট সর্বোচ্চ কতটি কেনা যাবে তাও ঠিক করে দিতে পারেন।",
    },
  },
} satisfies PluginManifestInput;

interface Tier {
  quantity: number;
  percent: number;
}

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The merchant's tiers, highest quantity first; a 0% tier is off. */
export function tiersFrom(settings: Record<string, unknown>): Tier[] {
  return [1, 2, 3]
    .map((n) => ({
      quantity: Math.floor(numberSetting(settings[`tier${n}_quantity`], 0)),
      percent: numberSetting(settings[`tier${n}_percent`], 0),
    }))
    .filter((tier) => tier.quantity >= 2 && tier.percent > 0 && tier.percent <= 100)
    .sort((left, right) => right.quantity - left.quantity || right.percent - left.percent);
}

function tierFor(quantity: number, tiers: readonly Tier[]): Tier | null {
  return tiers.find((tier) => quantity >= tier.quantity) ?? null;
}

export default definePlugin({
  manifest,

  functions: {
    "checkout.discounts": ({ cart }, settings) => {
      const tiers = tiersFrom(settings);
      if (tiers.length === 0 || cart.lines.length === 0) return { discounts: [] };
      const title = String(settings.title ?? "").trim().slice(0, 60) || "Bulk savings";
      const code = typeof settings.code === "string" && settings.code.trim() ? settings.code.trim().toUpperCase() : undefined;
      if (code && !cart.discountCodes.includes(code)) return { discounts: [] };
      const capMajor = numberSetting(settings.max_discount, 0);
      const maxAmountMinor = capMajor > 0 ? Math.round(capMajor * 10 ** cart.decimalPlaces) : undefined;
      const extras = { ...(code ? { code } : {}), ...(maxAmountMinor ? { maxAmountMinor } : {}) };

      if (settings.count_by === "cart") {
        const tier = tierFor(cart.lines.reduce((total, line) => total + line.quantity, 0), tiers);
        return tier
          ? { discounts: [{ title: `${title} (${tier.percent}% off)`, target: { kind: "order" as const }, value: { type: "percentage" as const, percent: tier.percent }, ...extras }] }
          : { discounts: [] };
      }

      // Per item: one discount per tier reached, on the lines that reached it.
      const byPercent = new Map<number, string[]>();
      for (const line of cart.lines) {
        const tier = tierFor(line.quantity, tiers);
        if (!tier) continue;
        byPercent.set(tier.percent, [...(byPercent.get(tier.percent) ?? []), line.lineId]);
      }
      return {
        discounts: [...byPercent]
          .sort(([left], [right]) => right - left)
          .slice(0, 10)
          .map(([percent, lineIds]) => ({
            title: `${title} (${percent}% off)`,
            target: { kind: "lines" as const, lineIds },
            value: { type: "percentage" as const, percent },
            ...extras,
          })),
      };
    },

    "cart.validate": ({ cart }, settings) => {
      const max = Math.floor(numberSetting(settings.max_quantity_per_line, 0));
      if (max <= 0) return { errors: [] };
      const template = String(settings.max_quantity_message ?? "").trim() || "You can buy at most {max} of this item in one order.";
      const message = template.replaceAll("{max}", String(max)).slice(0, 200);
      return {
        errors: cart.lines
          .filter((line) => line.quantity > max)
          .slice(0, 20)
          .map((line) => ({ code: "max_quantity", message, lineId: line.lineId })),
      };
    },
  },
});
