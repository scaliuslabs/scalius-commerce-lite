import { toHandle } from "@scalius/shared/handle";
import { CUSTOMIZATION_LIMITS, RESERVED_PROPERTY_KEY_PREFIX } from "@scalius/shared/line-properties";
import type { BuyerInputDraft } from "./buyer-inputs";

// Keys made from labels, apart from buyer-inputs.ts: they spell the label in
// Latin with the script tables, which load with the input dialog that saves
// a new input, not with the product page.

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
