// Wholesale accounts (`acme.wholesale`): the B2B pattern on declared reads.
// A company owns one price list, its payment terms and its approved quotes;
// a buyer's membership record only names the company. No per-buyer copies:
// a re-price writes one company record, however many buyers it has.
//
// - `cart.line_prices`: the buyer's company price (member -> company hop).
// - `cart.validate`: minimum quantities from a per-SKU `moq` record or the
//   product's own `min_qty` custom field, whichever is higher.
// - `checkout.payment_methods`: a net-terms company keeps only the method
//   the merchant names for invoices.
// - `checkout.discounts`: an approved quote code takes its amount off once;
//   the company record without that quote commits with the order, at the
//   revision read, so a quote is never spent twice.

import { definePlugin, PLUGIN_API_VERSION, readMany, readOne, type PluginManifestInput } from "@scalius/plugin-sdk";

const member = { as: "member", object: "members", key: "customer" } as const;
const company = { as: "company", object: "companies", key: { from: "member.company_id" } } as const;

export const manifest = {
  id: "acme.wholesale",
  name: "Wholesale accounts",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Company accounts with their own price lists, minimum quantities, invoice terms and approved quotes.",
  author: { name: "Acme" },
  objects: {
    companies: {
      name: "Companies",
      fields: [
        { key: "name", name: "Name", type: "single_line_text" },
        { key: "terms", name: "Payment terms", type: "single_line_text", validations: { choices: ["prepaid", "net30"] } },
        { key: "prices", name: "Prices (variant id -> minor units)", type: "json" },
        { key: "approved_quotes", name: "Approved quotes (code -> minor units)", type: "json" },
      ],
    },
    // Record id: the buyer's customer id.
    members: {
      name: "Company buyers",
      fields: [{ key: "company_id", name: "Company", type: "object_reference", to: "acme.wholesale.companies" }],
      indexes: ["company_id"],
    },
    // Record id: the variant id.
    moq: { name: "Minimum quantities", fields: [{ key: "min_qty", name: "Minimum", type: "integer" }] },
  },
  customFields: [{ ownerType: "product", key: "min_qty", name: "Minimum quantity", type: "integer" }],
  functions: [
    { point: "cart.line_prices", priority: 10, onError: "block", reads: [member, company] },
    {
      point: "cart.validate",
      priority: 10,
      onError: "block",
      reads: [member, company, { as: "moq", object: "moq", key: "line.variantId", max: 50 }, { as: "fields", customFields: ["product:min_qty"], max: 48 }],
    },
    { point: "checkout.payment_methods", priority: 10, reads: [member, company] },
    { point: "checkout.discounts", priority: 10, reads: [member, company] },
  ],
  settings: [{ key: "invoice_method", label: "Payment method kept for net terms", type: "text", default: "cod", maxLength: 64 }],
} satisfies PluginManifestInput;

interface Company extends Record<string, unknown> {
  name?: string;
  terms?: string;
  prices?: Record<string, number>;
  approved_quotes?: Record<string, number>;
}

const whole = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

export default definePlugin({
  manifest,
  functions: {
    "cart.line_prices": ({ cart, lines, reads }) => {
      const prices = readOne<Company>(reads, "company")?.data.prices ?? {};
      if (!cart.customer) return { prices: [] };
      // Sale, segment and market lists win over an app price; only fx/base lines take one.
      const priceable = new Set(lines.filter((line) => line.source === "fx" || line.source === "base").map((line) => line.lineId));
      return {
        prices: cart.lines.flatMap((line) => {
          const price = whole(prices[line.variantId]);
          return price && priceable.has(line.lineId) ? [{ lineId: line.lineId, unitPriceMinor: price }] : [];
        }),
      };
    },
    "cart.validate": ({ cart, reads }) => {
      const moq = readMany<{ min_qty?: number }>(reads, "moq");
      const fields = readMany<{ min_qty?: number }>(reads, "fields");
      const errors = cart.lines.flatMap((line) => {
        const minimum = Math.max(whole(moq[line.variantId]?.data.min_qty) ?? 0, whole(fields[line.productId]?.data.min_qty) ?? 0);
        return minimum > line.quantity
          ? [{ code: "moq", lineId: line.lineId, message: `Order at least ${minimum} of ${line.title.slice(0, 120)}.` }]
          : [];
      });
      return { errors: errors.slice(0, 20) };
    },
    "checkout.payment_methods": ({ methods, reads }, settings) => {
      if (readOne<Company>(reads, "company")?.data.terms !== "net30") return { operations: [] };
      const keep = String(settings.invoice_method ?? "cod");
      return { operations: methods.filter((method) => method.methodId !== keep).map((method) => ({ op: "hide" as const, methodId: method.methodId })) };
    },
    "checkout.discounts": ({ cart, reads }) => {
      const record = readOne<Company>(reads, "company");
      if (!cart.customer || !record) return { discounts: [] };
      const quotes = record.data.approved_quotes ?? {};
      const code = cart.discountCodes.map((value) => value.trim().toUpperCase()).find((value) => whole(quotes[value]));
      if (!code) return { discounts: [] };
      const { [code]: _spent, ...rest } = quotes;
      return {
        discounts: [{ title: `Quote ${code}`, code, target: { kind: "order" as const }, value: { type: "fixed_amount" as const, amountMinor: whole(quotes[code])! } }],
        // Spent with the order, at the revision read: a quote is used once.
        commit: [{ as: "company", record: { ...record.data, approved_quotes: rest } }],
      };
    },
  },
});
