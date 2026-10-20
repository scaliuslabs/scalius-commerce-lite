// Host-rendered buyer UI. App output is data; text, fields and actions stay in core.
import { z } from "zod";
import { PLUGIN_BLOCK_TARGETS, type PluginBlockTarget } from "./storefront";
import type { PluginUiJson, PluginUiTone } from "./ui";
import { pluginKeySchema, pluginUrlNameSchema } from "./manifest-patterns";

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

export type BuyerUiAction =
  | { kind: "add_line"; variantId: string; quantity: number }
  | { kind: "set_attribute"; key: string; value: string }
  | { kind: "apply_code"; code: string }
  | { kind: "app_route"; route: string; body?: PluginUiJson };
export type BuyerUiNode =
  | { type: "stack" | "columns"; children: BuyerUiNode[] }
  | { type: "heading" | "text"; text: string }
  | { type: "badge" | "banner"; tone?: PluginUiTone; title?: string; text?: string }
  | { type: "divider" }
  | { type: "key-value"; items: Array<{ label: string; value: string }> }
  | { type: "image"; src: { media: string } | { app: string }; alt: string }
  | { type: "link"; text: string; path: string }
  | { type: "field"; attribute: string }
  | { type: "button"; label: string; action: BuyerUiAction };
const json: z.ZodType<PluginUiJson> = z.lazy(() => z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null(), z.array(json).max(50), z.record(z.string().max(64), json)])).meta({ id: "BuyerUiJson" });
export const buyerUiActionSchema: z.ZodType<BuyerUiAction> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_line"), variantId: z.string().min(1).max(128), quantity: z.number().int().min(1).max(10) }).strict(),
  z.object({ kind: z.literal("set_attribute"), key, value: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("apply_code"), code: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("app_route"), route: pluginUrlNameSchema(), body: json.optional() }).strict(),
]);
const text = z.string().max(2000);
const node: z.ZodType<BuyerUiNode> = z.lazy(() => z.union([
  z.object({ type: z.enum(["stack", "columns"]), children: z.array(node).max(40) }).strict(),
  z.object({ type: z.enum(["heading", "text"]), text }).strict(),
  z.object({ type: z.enum(["badge", "banner"]), tone: z.enum(["neutral", "info", "success", "warning", "critical"]).optional(), title: label.optional(), text: text.optional() }).strict(),
  z.object({ type: z.literal("divider") }).strict(),
  z.object({ type: z.literal("key-value"), items: z.array(z.object({ label, value: text }).strict()).max(40) }).strict(),
  z.object({ type: z.literal("image"), src: z.union([z.object({ media: z.string().min(1).max(128) }).strict(), z.object({ app: z.string().max(256).regex(/^public\/[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9]+)?$/).refine((path) => !path.includes("..")) }).strict()]), alt: z.string().max(500) }).strict(),
  z.object({ type: z.literal("link"), text, path: z.string().max(2048).regex(/^\/(?!\/)[^\\\s?#]*$/).refine((path) => !path.split("/").some((part) => part === "." || part === "..") && !/%(?:2f|5c|2e)/i.test(path)) }).strict(),
  z.object({ type: z.literal("field"), attribute: key }).strict(),
  z.object({ type: z.literal("button"), label, action: buyerUiActionSchema }).strict(),
])).meta({ id: "BuyerUiNode" });
export const buyerUiNodeSchema = node.superRefine((root, ctx) => {
  let count = 0;
  const pending = [{ node: root, depth: 1 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (++count > 200 || entry.depth > 8) { ctx.addIssue({ code: "custom", message: "Buyer UI is too large or deeply nested." }); return; }
    if ("children" in entry.node) pending.push(...entry.node.children.map((child) => ({ node: child, depth: entry.depth + 1 })));
  }
  if (new TextEncoder().encode(JSON.stringify(root)).byteLength > 32 * 1024) ctx.addIssue({ code: "custom", message: "Buyer UI exceeds 32 KiB." });
});
export const buyerUiOutputSchema = z.object({ ui: buyerUiNodeSchema.nullable() }).strict();
export type BuyerUiOutput = z.infer<typeof buyerUiOutputSchema>;
export interface BuyerUiBlock {
  appId: string; releaseId: string; target: PluginBlockTarget; ui: BuyerUiNode;
  attributes: CheckoutAttribute[]; values: Record<string, string>; media?: Record<string, string>;
}
export const buyerUiBlockSchema: z.ZodType<BuyerUiBlock> = z.object({
  appId: z.string(), releaseId: z.string(), target: z.enum(PLUGIN_BLOCK_TARGETS), ui: buyerUiNodeSchema,
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
