// Text an app writes that the store draws for a buyer or staff (an add-on's
// title and detail lines, a rule's message, a rate's name, a discount's
// title): plain, single-line text. Control characters and the bidi
// embedding, override and isolate marks are refused at the function
// boundary, so an app can never reorder or hide what the host draws beside
// it. Joiners stay: Bangla and other scripts need them.

/** What app text never holds: C0 and C1 controls, bidi embeddings, overrides and isolates, line and paragraph separators, a byte-order mark. */
const UNSAFE = "\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069\\u2028\\u2029\\uFEFF";
export const APP_TEXT_UNSAFE = new RegExp(`[${UNSAFE}]`);
/** The same, as an anchored pattern a schema states. */
export const APP_TEXT_PATTERN = new RegExp(`^[^${UNSAFE}]*$`);

/** Whether `value` is app text the host may draw. */
export function isSafeAppText(value: string): boolean {
  return !APP_TEXT_UNSAFE.test(value);
}
