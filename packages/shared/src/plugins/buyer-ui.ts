// Buyer UI: the `ui` tree (ui.ts, buyer surface) a storefront extension
// answers for a UI slot of the buyer's own pages, and the checkout attributes
// its `field` nodes draw. App output is data; text, fields and actions stay in core.
import { z } from "zod";
import { STOREFRONT_UI_SLOTS, type StorefrontUiSlot } from "./storefront-protocol";
import { pluginUiDocumentSchema, pluginUiNodes, pluginUiTreeSchema, type PluginUiNode } from "./ui";
import { computedChoicesFit } from "./checkout-attribute-values";
export { computedChoicesFit, isAttributeDate } from "./checkout-attribute-values";
import { pluginKeySchema } from "./manifest-patterns";
import { CUSTOMIZATION_LIMITS, LINE_INPUT_FIELD_TYPES } from "../line-properties";
import { BUYER_UPLOAD_DECLARATION_LIMITS, BUYER_UPLOAD_TYPES } from "../buyer-uploads";

/** A checkout attribute key: snake_case (it is stored on the order). */
const key = pluginKeySchema();
const label = z.string().trim().min(1).max(120);

/**
 * What a `file` input (a line input or a checkout attribute) takes: the
 * accepted types (default every one of `BUYER_UPLOAD_TYPES`), the largest
 * file and the most files of one answer (default 1). The deployment's plan
 * bounds both again (`buyerUploadBounds`); the platform takes the lower value.
 */
const fileDeclaration = {
  accept: z.array(z.enum(BUYER_UPLOAD_TYPES)).min(1).max(BUYER_UPLOAD_TYPES.length).optional(),
  maxBytes: z.number().int().min(1).max(BUYER_UPLOAD_DECLARATION_LIMITS.maxBytes).optional(),
  maxFiles: z.number().int().min(1).max(BUYER_UPLOAD_DECLARATION_LIMITS.maxFiles).optional(),
};
type FileDeclarationIssue = { type: string; accept?: readonly string[]; maxBytes?: number; maxFiles?: number };
function refineFileDeclaration(field: FileDeclarationIssue, ctx: z.RefinementCtx): void {
  if (field.type === "file") {
    if (field.accept && new Set(field.accept).size !== field.accept.length) ctx.addIssue({ code: "custom", path: ["accept"], message: "Accepted types must be unique." });
    return;
  }
  for (const name of ["accept", "maxBytes", "maxFiles"] as const) {
    if (field[name] !== undefined) ctx.addIssue({ code: "custom", path: [name], message: `Only a file input has ${name}.` });
  }
}

export const CHECKOUT_ATTRIBUTE_TYPES = ["text", "multiline", "number", "boolean", "date", "choice", "file"] as const;
export const checkoutAttributeSchema = z.object({
  key, label, help: z.string().max(500).optional(),
  type: z.enum(CHECKOUT_ATTRIBUTE_TYPES),
  required: z.boolean().optional(), maxLength: z.number().int().min(1).max(500).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
  choices: z.array(z.object({ value: z.string().min(1).max(500), label }).strict()).min(1).max(50).optional(),
  ...fileDeclaration,
}).strict().superRefine((field, ctx) => {
  refineFileDeclaration(field, ctx);
  if (field.type === "choice" && !field.choices?.length) ctx.addIssue({ code: "custom", message: "A choice needs options." });
  if (field.choices && new Set(field.choices.map((choice) => choice.value)).size !== field.choices.length) ctx.addIssue({ code: "custom", message: "Choice values must be unique." });
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) ctx.addIssue({ code: "custom", message: "Minimum exceeds maximum." });
});
export type CheckoutAttribute = z.infer<typeof checkoutAttributeSchema>;

/** The most purchase options one app declares. */
export const PURCHASE_OPTIONS_MAX = 10;
/**
 * A way to buy a line the app offers ("Subscribe and save", "Rent"): manifest
 * `checkout.purchaseOptions`. Its public id is `<app id>.<key>` (a cart line's
 * `purchaseOption`). Core prices nothing for it; the app's functions do.
 */
export const purchaseOptionDeclarationSchema = z.object({
  key,
  /** What the buyer sees on the line, the cart and the order ("Subscribe and save"). */
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300).optional(),
}).strict();
export type PurchaseOptionDeclaration = z.infer<typeof purchaseOptionDeclarationSchema>;

/** The most line inputs one app declares. */
export const LINE_INPUTS_MAX = 10;
const lineInputLabel = z.string().trim().min(1).max(CUSTOMIZATION_LIMITS.labelLength);
/**
 * A buyer input the app asks for on each cart line (manifest
 * `checkout.lineInputs`): a gift message, a protection plan, an engraving
 * an app prices. It is the product's own buyer-input vocabulary (text,
 * textarea, select, checkbox), or a `file` the buyer uploads (a photo to
 * print; its answer is the upload ids), under the app's key `<app id>.<key>`, so it is
 * drawn by the buy form beside the merchant's inputs, edited from the cart,
 * part of the line's identity, seen by the app's functions and frozen on the
 * order line. Core prices nothing for it: the app adds to the line with
 * `cart.line_prices` adjustments. `products` shows it only on products whose
 * app custom field (a storefront-visible boolean product field the app
 * declares) is true. An app input is never required: every way to add a
 * line (a card's quick add, an island, an order form) adds it without the
 * product page, so the app's `cart.validate` asks for a missing one with an
 * error on the line.
 */
export const lineInputDeclarationSchema = z.object({
  key,
  label: lineInputLabel,
  help: z.string().trim().min(1).max(CUSTOMIZATION_LIMITS.helpLength).optional(),
  type: z.enum(LINE_INPUT_FIELD_TYPES),
  /** text up to 200 characters, textarea up to 1,000 (the default). */
  maxLength: z.number().int().min(1).max(CUSTOMIZATION_LIMITS.textareaMaxLength).optional(),
  options: z.array(z.object({
    value: z.string().trim().min(1).max(CUSTOMIZATION_LIMITS.optionValueLength).regex(/^[^\r\n]*$/u),
    label: lineInputLabel,
  }).strict()).min(1).max(CUSTOMIZATION_LIMITS.selectOptions).optional(),
  ...fileDeclaration,
  products: z.object({ customField: z.string().max(64) }).strict().optional(),
}).strict().superRefine((field, ctx) => {
  refineFileDeclaration(field, ctx);
  if (field.type === "select" ? !field.options?.length : field.options !== undefined) ctx.addIssue({ code: "custom", path: ["options"], message: field.type === "select" ? "A select needs options." : "Only a select has options." });
  if (field.options && new Set(field.options.map((option) => option.value)).size !== field.options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "Option values must be unique." });
  if (field.maxLength !== undefined && field.type !== "text" && field.type !== "textarea") ctx.addIssue({ code: "custom", path: ["maxLength"], message: "Only text inputs have a maximum length." });
  if (field.maxLength !== undefined && field.type === "text" && field.maxLength > CUSTOMIZATION_LIMITS.textMaxLength) ctx.addIssue({ code: "custom", path: ["maxLength"], message: `A text input holds at most ${CUSTOMIZATION_LIMITS.textMaxLength} characters.` });
});
export type LineInputDeclaration = z.infer<typeof lineInputDeclarationSchema>;
export const CHECKOUT_ATTRIBUTES_MAX_BYTES = 8 * 1024;
export const checkoutAttributesSchema = z.record(z.string().max(160), z.string().max(500)).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= CHECKOUT_ATTRIBUTES_MAX_BYTES,
  "Checkout attributes exceed 8 KiB.",
);

/** What a storefront extension answers: a buyer-surface document, or null to show nothing. */
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

/** One checkout question to draw: an app's attribute under `<app id>.<key>`, with the choices its extension computed. */
export interface CheckoutAttributeField {
  appId: string;
  /** `<app id>.<key>`: the answer's name. */
  key: string;
  attribute: CheckoutAttribute;
  choices?: ReadonlyArray<{ value: string; label: string }>;
}

/**
 * The questions a page without the buyer-UI script (the no-script checkout)
 * or the staff order form draws, consistent with the script's checkout: every
 * attribute an app's block draws (`ui.field`, with its computed choices),
 * then every required attribute an app declares that no block draws. In the
 * blocks' order, each question once.
 */
export function checkoutAttributeFields(
  blocks: ReadonlyArray<Pick<BuyerUiBlock, "appId" | "ui" | "attributes">>,
  declared: ReadonlyArray<{ appId: string; fields: readonly CheckoutAttribute[] }> = [],
): CheckoutAttributeField[] {
  const fields = new Map<string, CheckoutAttributeField>();
  for (const block of blocks) {
    for (const node of pluginUiNodes(block.ui)) {
      if (node.type !== "field") continue;
      const attribute = block.attributes.find((field) => field.key === node.attribute);
      const key = `${block.appId}.${node.attribute}`;
      if (!attribute || fields.has(key)) continue;
      const choices = node.choices && computedChoicesFit(attribute, node.choices) ? node.choices : undefined;
      fields.set(key, { appId: block.appId, key, attribute, ...(choices ? { choices } : {}) });
    }
  }
  for (const app of [...blocks.map((block) => ({ appId: block.appId, fields: block.attributes })), ...declared]) {
    for (const attribute of app.fields) {
      const key = `${app.appId}.${attribute.key}`;
      if (attribute.required && !fields.has(key)) fields.set(key, { appId: app.appId, key, attribute });
    }
  }
  return [...fields.values()];
}
