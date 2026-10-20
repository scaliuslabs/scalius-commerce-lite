// Buyer UI: the `ui` tree (ui.ts, buyer surface) a `buyer.ui` function
// answers for a UI slot of the buyer's own pages, and the checkout attributes
// its `field` nodes draw. App output is data; text, fields and actions stay in core.
import { z } from "zod";
import { STOREFRONT_UI_SLOTS, type StorefrontUiSlot } from "./storefront-protocol";
import { pluginUiDocumentSchema, pluginUiTreeSchema, type PluginUiNode } from "./ui";
import { pluginKeySchema } from "./manifest-patterns";

/** A checkout attribute key: snake_case (it is stored on the order). */
const key = pluginKeySchema();
const label = z.string().trim().min(1).max(120);
export const checkoutAttributeSchema = z.object({
  key, label, help: z.string().max(500).optional(),
  type: z.enum(["text", "multiline", "number", "boolean", "date", "choice"]),
  required: z.boolean().optional(), maxLength: z.number().int().min(1).max(500).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
  choices: z.array(z.object({ value: z.string().min(1).max(500), label }).strict()).min(1).max(50).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.type === "choice" && !field.choices?.length) ctx.addIssue({ code: "custom", message: "A choice needs options." });
  if (field.choices && new Set(field.choices.map((choice) => choice.value)).size !== field.choices.length) ctx.addIssue({ code: "custom", message: "Choice values must be unique." });
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) ctx.addIssue({ code: "custom", message: "Minimum exceeds maximum." });
});
export type CheckoutAttribute = z.infer<typeof checkoutAttributeSchema>;
export const CHECKOUT_ATTRIBUTES_MAX_BYTES = 8 * 1024;
export const checkoutAttributesSchema = z.record(z.string().max(160), z.string().max(500)).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= CHECKOUT_ATTRIBUTES_MAX_BYTES,
  "Checkout attributes exceed 8 KiB.",
);

/** What a `buyer.ui` function answers: a buyer-surface document, or null to show nothing. */
export const buyerUiOutputSchema = z.object({ ui: pluginUiDocumentSchema("buyer").nullable() }).strict();
export type BuyerUiOutput = z.infer<typeof buyerUiOutputSchema>;

/** One app's tree for one UI slot, as the API hands it to the storefront (references checked, media resolved). */
export interface BuyerUiBlock {
  appId: string; releaseId: string; target: StorefrontUiSlot; ui: PluginUiNode;
  attributes: CheckoutAttribute[]; values: Record<string, string>; media?: Record<string, string>;
}
export const buyerUiBlockSchema: z.ZodType<BuyerUiBlock> = z.object({
  appId: z.string(), releaseId: z.string(), target: z.enum(STOREFRONT_UI_SLOTS), ui: pluginUiTreeSchema("buyer"),
  attributes: z.array(checkoutAttributeSchema).max(10), values: checkoutAttributesSchema, media: z.record(z.string(), z.string().url()).optional(),
}).strict();

/** Strict reads of the private stored map, also used by order representations. */
export function readCheckoutAttributes(serialized: string | null | undefined): Record<string, string> {
  if (!serialized) return {};
  try { const parsed = checkoutAttributesSchema.safeParse(JSON.parse(serialized)); return parsed.success ? parsed.data : {}; }
  catch { return {}; }
}
export function groupCheckoutAttributes(serialized: string | null | undefined): Array<{ appId: string; attributes: Array<{ key: string; value: string }> }> {
  const groups = new Map<string, Array<{ key: string; value: string }>>();
  for (const [key, value] of Object.entries(readCheckoutAttributes(serialized))) {
    const boundary = key.lastIndexOf(".");
    if (boundary < 1) continue;
    const appId = key.slice(0, boundary);
    const fields = groups.get(appId) ?? [];
    fields.push({ key: key.slice(boundary + 1), value }); groups.set(appId, fields);
  }
  return [...groups].map(([appId, attributes]) => ({ appId, attributes }));
}
