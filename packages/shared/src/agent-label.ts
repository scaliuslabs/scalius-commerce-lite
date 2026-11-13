// A name an agent, its client or an OAuth app chose for itself ("Claude Code",
// an app's registered name, a pairing's profile), or that staff typed for a
// connection. Shown to staff on the pairing and approval pages, the
// connections list, the order timeline, the audit trail and security emails,
// so it is cleaned once where it enters (and again where an older stored row
// is read): control, line and paragraph separators and Unicode format
// characters (direction overrides such as U+202E, zero-width characters) are
// removed, white space is collapsed, and it is cut to its length. A name
// "Eviltool‮gnp.exe" then reads as itself, never reversed into
// "…exe.png". Every page renders it as plain text.

const UNSAFE_LABEL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/**
 * Characters that draw nothing: default-ignorable ones (the Hangul and
 * half-width fillers, variation selectors, the combining grapheme joiner,
 * tag characters) and the blank Braille pattern U+2800.
 */
const INVISIBLE_LABEL_CHARACTERS = /[\p{Default_Ignorable_Code_Point}\u2800]+/gu;

/** Marks with no letter to sit on are dropped; a letter keeps at most its first three (Bangla needs two at most). */
function boundedMarks(text: string): string {
  return text
    .replace(/(^|[\s])\p{M}+/gu, "$1")
    .replace(/(\p{M}{1,3})\p{M}+/gu, "$1");
}

/**
 * The label as staff may read it: one line, no direction or invisible
 * characters, marks bounded, at most `max` characters; "" when nothing
 * readable is left (no letter or digit), which callers refuse or replace.
 */
export function cleanAgentLabel(value: string | null | undefined, max = 120): string {
  if (typeof value !== "string") return "";
  const text = boundedMarks(value.normalize("NFC")
    .replace(UNSAFE_LABEL_CHARACTERS, " ")
    .replace(INVISIBLE_LABEL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim());
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  const characters = Array.from(text);
  return characters.length > max ? characters.slice(0, max).join("").trimEnd() : text;
}

/** A cleaned label, or null when nothing readable is left. */
export function cleanAgentLabelOrNull(value: string | null | undefined, max = 120): string | null {
  return cleanAgentLabel(value, max) || null;
}
