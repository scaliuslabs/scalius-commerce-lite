// Text an app writes that the store draws for a buyer or staff (an add-on's
// title and detail lines, a rule's message, a rate's new name, a discount's
// title, the labels and help of its checkout attributes, purchase options and
// line inputs): plain, single-line text, CLEANED at the boundary, never
// refused for one character. Control characters become one space, the bidi
// embedding, override and isolate marks (and a byte-order mark) are removed,
// then the text is trimmed; only text that cleans to nothing is refused where
// text is required. An app can never reorder or hide what the host draws
// beside it, and a stray newline never costs a buyer an app's rule. Joiners
// stay: Bangla and other scripts need them. Text the store hands TO an app
// (its own rate and method names) is the store's and is never cleaned here.
import { z } from "zod";

// Control characters are what it strips: the match is the point.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;
const BIDI_MARKS = /[\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** App text as the store draws it: control runs to one space, bidi embedding/override/isolate marks removed, trimmed. */
export function cleanAppText(value: string): string {
  return stripBidiMarks(value).replace(CONTROLS, " ").trim();
}

/** App words whose spaces and line breaks are the app's own (a text's body, a sentence's plain piece): only the bidi marks removed. */
export function stripBidiMarks(value: string): string {
  return value.replace(BIDI_MARKS, "");
}

/** One line of app words kept as written, never trimmed (a sentence's link words): control runs to one space, bidi marks removed. */
export function cleanAppLine(value: string): string {
  return stripBidiMarks(value).replace(CONTROLS, " ");
}

/**
 * The one schema of app text the store draws, at most `max` characters once
 * cleaned (`cleanAppText`); empty after cleaning is refused unless `optional`
 * text may be empty (then it reads as absent upstream). The raw value is
 * bounded too (four times `max`), so a run of marks never costs unbounded work.
 */
export function appTextSchema(max: number) {
  return z.string().max(max * 4).transform(cleanAppText).pipe(z.string().min(1).max(max));
}
