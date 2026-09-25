import { toHandle } from "@scalius/shared/handle";
import {
  CUSTOMIZATION_LIMITS,
  CUSTOMIZATION_SCHEMA_VERSION,
  RESERVED_PROPERTY_KEY_PREFIX,
  type CustomizationField,
  type CustomizationFieldType,
  type CustomizationSchema,
} from "@scalius/shared/line-properties";
import type { CreateProductInput } from "@/lib/api-query-options/products";

/**
 * One buyer input as the editor holds it: the merchant's words and prices in
 * major units (৳), keyed by a stable `key` that cart lines and orders carry.
 * A key never changes once saved, even when the label does.
 */
export interface BuyerInputDraft {
  key: string;
  label: string;
  type: CustomizationFieldType;
  required: boolean;
  help: string;
  /** Character limit for text inputs; null uses the most the type allows. */
  maxLength: number | null;
  /** Surcharge for a filled text input or a ticked box (major units); null is none. */
  price: number | null;
  /** Choices of a select, each with its own surcharge. */
  options: BuyerInputOptionDraft[];
}

export interface BuyerInputOptionDraft {
  value: string;
  label: string;
  price: number | null;
}

/** The product read's projection of the saved inputs (prices in both units). */
export interface CustomizationSchemaView {
  fields: Array<{
    key: string;
    label: string;
    type: CustomizationFieldType;
    required: boolean;
    help: string | null;
    maxLength: number | null;
    price: number;
    priceMinor?: number;
    options: Array<{ value: string; label: string; price: number; priceMinor?: number }>;
  }>;
}

export const BUYER_INPUT_TYPES: readonly CustomizationFieldType[] = ["text", "textarea", "select", "checkbox"];

/** The most characters a text input of this type may allow. */
export function maxLengthLimit(type: CustomizationFieldType): number {
  return type === "textarea" ? CUSTOMIZATION_LIMITS.textareaMaxLength : CUSTOMIZATION_LIMITS.textMaxLength;
}

export function draftsFromView(view: CustomizationSchemaView | null | undefined): BuyerInputDraft[] {
  return (view?.fields ?? []).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    help: field.help ?? "",
    maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
    price: field.type === "select" || !field.price ? null : field.price,
    options: field.options.map((option) => ({ value: option.value, label: option.label, price: option.price || null })),
  }));
}

/** The product read's shape of these drafts (the edit page keeps its snapshot in that shape). */
export function viewFromDrafts(drafts: readonly BuyerInputDraft[]): CustomizationSchemaView | null {
  if (drafts.length === 0) return null;
  return {
    fields: drafts.map((draft) => ({
      key: draft.key,
      label: draft.label,
      type: draft.type,
      required: draft.required,
      help: draft.help.trim() || null,
      maxLength: draft.type === "text" || draft.type === "textarea" ? draft.maxLength ?? maxLengthLimit(draft.type) : null,
      price: draft.type === "select" ? 0 : draft.price ?? 0,
      options: draft.type === "select" ? draft.options.map((option) => ({ value: option.value, label: option.label, price: option.price ?? 0 })) : [],
    })),
  };
}

type CustomizationSchemaInput = NonNullable<CreateProductInput["customizationSchema"]>;

/**
 * The request body's `customizationSchema`: null removes every input. Each
 * type sends only its own fields (a select prices its choices, not itself).
 */
export function customizationInput(drafts: readonly BuyerInputDraft[]): CustomizationSchemaInput | null {
  if (drafts.length === 0) return null;
  return {
    fields: drafts.map((draft) => {
      const base = { key: draft.key, label: draft.label.trim(), type: draft.type, required: draft.required, help: draft.help.trim() || null };
      if (draft.type === "select") {
        return { ...base, options: draft.options.map((option) => ({ value: option.value, label: option.label.trim(), price: option.price ?? 0 })) };
      }
      if (draft.type === "checkbox") return { ...base, price: draft.price ?? 0 };
      return { ...base, maxLength: draft.maxLength ?? maxLengthLimit(draft.type), price: draft.price ?? 0 };
    }),
  };
}

/** The shared schema, so the preview renders and prices exactly as the product page will. */
export function schemaFromDrafts(drafts: readonly BuyerInputDraft[], minorFactor: number): CustomizationSchema | null {
  if (drafts.length === 0) return null;
  const minor = (price: number | null) => Math.round((price ?? 0) * minorFactor);
  return {
    version: CUSTOMIZATION_SCHEMA_VERSION,
    fields: drafts.map((draft): CustomizationField => {
      const base = { key: draft.key, label: draft.label, required: draft.required, help: draft.help.trim() || null };
      if (draft.type === "select") {
        return { ...base, type: "select", options: draft.options.map((option) => ({ value: option.value, label: option.label, priceMinor: minor(option.price) })) };
      }
      if (draft.type === "checkbox") return { ...base, type: "checkbox", priceMinor: minor(draft.price) };
      return { ...base, type: draft.type, maxLength: draft.maxLength ?? maxLengthLimit(draft.type), priceMinor: minor(draft.price) };
    }),
  };
}

/**
 * A key or choice value from the merchant's words: Latin (Bangla read
 * aloud), lower case, underscores, unique among `taken`. Never the reserved
 * gift-card prefix.
 */
export function keyFromLabel(label: string, taken: ReadonlySet<string>, maxLength: number = 40): string {
  const base = (toHandle(label).replace(/-/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "") || "input")
    .slice(0, maxLength);
  // Leading underscores are stripped, so a made key never takes the reserved `${RESERVED_PROPERTY_KEY_PREFIX}` prefix.
  const safe = base.startsWith(RESERVED_PROPERTY_KEY_PREFIX) ? base.slice(1) : base;
  if (!taken.has(safe)) return safe;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${safe.slice(0, maxLength - String(suffix).length - 1)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type BuyerInputIssue =
  | { field: "label"; reason: "required" | "tooLong" }
  | { field: "help"; reason: "tooLong" }
  | { field: "maxLength"; reason: "range" }
  | { field: "price"; reason: "negative" }
  | { field: "options"; reason: "required" | "tooMany" }
  | { field: "option"; index: number; reason: "required" | "tooLong" | "duplicate" | "negative" };

const length = (value: string) => [...value.trim()].length;

/** Why this input can't be saved yet (the limits the server enforces), first problem first. */
export function buyerInputIssue(draft: BuyerInputDraft): BuyerInputIssue | null {
  if (!draft.label.trim()) return { field: "label", reason: "required" };
  if (length(draft.label) > CUSTOMIZATION_LIMITS.labelLength) return { field: "label", reason: "tooLong" };
  if (length(draft.help) > CUSTOMIZATION_LIMITS.helpLength) return { field: "help", reason: "tooLong" };
  if (draft.type === "text" || draft.type === "textarea") {
    const limit = maxLengthLimit(draft.type);
    if (draft.maxLength !== null && (!Number.isInteger(draft.maxLength) || draft.maxLength < 1 || draft.maxLength > limit)) {
      return { field: "maxLength", reason: "range" };
    }
  }
  if (draft.type !== "select" && (draft.price ?? 0) < 0) return { field: "price", reason: "negative" };
  if (draft.type === "select") {
    if (draft.options.length === 0) return { field: "options", reason: "required" };
    if (draft.options.length > CUSTOMIZATION_LIMITS.selectOptions) return { field: "options", reason: "tooMany" };
    const seen = new Set<string>();
    for (const [index, option] of draft.options.entries()) {
      if (!option.label.trim()) return { field: "option", index, reason: "required" };
      if (length(option.label) > CUSTOMIZATION_LIMITS.optionLabelLength) return { field: "option", index, reason: "tooLong" };
      const name = option.label.trim().toLowerCase();
      if (seen.has(name)) return { field: "option", index, reason: "duplicate" };
      seen.add(name);
      if ((option.price ?? 0) < 0) return { field: "option", index, reason: "negative" };
    }
  }
  return null;
}

/** Moves one input up (-1) or down (+1); the product page asks them in this order. */
export function moveBuyerInput<T>(list: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** A new input's starting values. */
export function emptyBuyerInput(): BuyerInputDraft {
  return { key: "", label: "", type: "text", required: false, help: "", maxLength: null, price: null, options: [] };
}

/**
 * Gives a new input its key, and new choices their values, from their
 * labels; saved keys and values stay as they are.
 */
export function withKeys(draft: BuyerInputDraft, others: readonly BuyerInputDraft[]): BuyerInputDraft {
  const key = draft.key || keyFromLabel(draft.label, new Set(others.map((other) => other.key)));
  if (draft.type !== "select") return { ...draft, key, options: [] };
  const values = new Set(draft.options.map((option) => option.value).filter(Boolean));
  const options = draft.options.map((option) => {
    if (option.value) return option;
    const value = keyFromLabel(option.label, values, CUSTOMIZATION_LIMITS.optionValueLength);
    values.add(value);
    return { ...option, value };
  });
  return { ...draft, key, maxLength: null, price: null, options };
}
