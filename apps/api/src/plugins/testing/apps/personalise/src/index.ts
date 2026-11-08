// Acme Personalise: print the buyer's own photo on a product (COMMERCE-HOOKS
// H17). Proves buyer uploads end to end on the stable tier only:
//
// - a `file` line input (`acme.personalise.photo`): one or two JPEG or PNG
//   photos of at most 2 MB each, on products whose `acme.personalise.enabled`
//   custom field is true;
// - `cart.line_prices` adds the printing fee to each unit of a line that
//   carries a photo (the answer is the upload ids; the app never sees bytes);
// - after the order, the app reads its own files back through
//   `order_uploads.list` (scope `read_orders`): short-lived signed links it
//   hands to its print partner. It never sees another app's files.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const PHOTO_INPUT = "acme.personalise.photo";
/** The fee each personalised unit adds, in minor units, when the merchant sets none. */
export const DEFAULT_FEE_MINOR = 25_000;

export const manifest = {
  id: "acme.personalise",
  name: "Personalise",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Lets buyers upload a photo to print on a product, and adds a printing fee.",
  author: { name: "Acme" },
  scopes: ["read_orders"],
  customFields: [
    { ownerType: "product", key: "enabled", name: "Photo printing", type: "boolean", storefrontVisible: true },
  ],
  checkout: {
    lineInputs: [{
      key: "photo",
      label: "Your photo",
      help: "A clear JPG or PNG photo; we print it as sent.",
      type: "file",
      accept: ["image/jpeg", "image/png"],
      maxBytes: 2 * 1024 * 1024,
      maxFiles: 2,
      products: { customField: "enabled" },
    }],
  },
  functions: [{ point: "cart.line_prices" }],
  settings: [
    { key: "fee", label: "Printing fee (minor units)", type: "number", integer: true, min: 0, max: 1_000_000, default: DEFAULT_FEE_MINOR },
  ],
} satisfies PluginManifestInput;

interface Line {
  lineId: string;
  properties: Record<string, string>;
}

/** The printing fee on every line that carries a photo. */
export function printingFees(lines: readonly Line[], settings: Record<string, unknown>) {
  const fee = typeof settings.fee === "number" && Number.isSafeInteger(settings.fee) && settings.fee >= 0 ? settings.fee : DEFAULT_FEE_MINOR;
  if (fee === 0) return { adjustments: [] };
  return {
    adjustments: lines
      .filter((line) => Boolean(line.properties[PHOTO_INPUT]))
      .map((line) => ({ lineId: line.lineId, amountMinor: fee, title: "Photo printing" })),
  };
}

export default definePlugin({
  manifest,

  functions: {
    "cart.line_prices": ({ cart }, settings) => printingFees(cart.lines, settings),
  },
});
