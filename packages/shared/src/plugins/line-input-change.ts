// A change to one of an app's own line inputs on cart lines: what a buyer UI
// `set_line_input` button (ui.ts, `lineInputChangeSchema`) and an island's
// `context.cart.setLineInput` both send, checked by one rule here. A leaf
// without zod, so an island's cart helper checks it without the UI schema.

/** Bounds of a change: the answer's characters, a line key's, and the lines it names. */
export const LINE_INPUT_CHANGE_LIMITS = { value: 1000, lineKey: 256, lineKeys: 99 } as const;
/** An input's key without the app id: snake_case, at most 48 characters (`PLUGIN_KEY_PATTERN`). */
export const LINE_INPUT_CHANGE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * `key`: the input's key without the app id (an app names only its own);
 * `value`: the answer, or null (or "") to clear it; `lineKeys`: the cart lines, or
 * absent for every line the input applies to (clearing: every line with an answer).
 */
export interface LineInputChange {
  key: string;
  value: string | null;
  lineKeys?: string[];
}

/** Whether `value` is a change within the bounds (`lineInputChangeSchema` says the same). */
export function isLineInputChange(value: unknown): value is LineInputChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  if (Object.keys(change).some((key) => key !== "key" && key !== "value" && key !== "lineKeys")) return false;
  if (typeof change.key !== "string" || !LINE_INPUT_CHANGE_KEY_PATTERN.test(change.key)) return false;
  if (change.value !== null && (typeof change.value !== "string" || change.value.length > LINE_INPUT_CHANGE_LIMITS.value)) return false;
  if (change.lineKeys === undefined) return true;
  return Array.isArray(change.lineKeys) && change.lineKeys.length >= 1 && change.lineKeys.length <= LINE_INPUT_CHANGE_LIMITS.lineKeys
    && change.lineKeys.every((key) => typeof key === "string" && key.length >= 1 && key.length <= LINE_INPUT_CHANGE_LIMITS.lineKey);
}
