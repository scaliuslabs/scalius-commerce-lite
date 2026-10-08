// Bidirectional isolation for text that must keep its own direction inside a
// sentence of the other one: phone numbers, prices, percentages and counts on
// a right-to-left page ("+8801711000000", "৳1,200", "-15%"). Without it the
// browser's bidi algorithm moves the sign or the "+" to the wrong end.
//
// - In markup, wrap the value in `components/ui/Ltr.astro` (`<bdi dir="ltr">`).
// - In a string that is not markup (an aria-label, a title, a template
//   argument), use `ltr(value)`: the value between U+2066 (LRI) and U+2069
//   (PDI), invisible and read by screen readers as the value alone.
//
// Write a label as one whole template ("{count} ratings"), never as pieces
// glued around a value, and isolate only the value inside it.

const LRI = "⁦";
const PDI = "⁩";

/** The value as an isolated left-to-right run inside surrounding text of either direction. */
export function ltr(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text ? `${LRI}${text}${PDI}` : "";
}

/** The value without the isolates (what a log, a link or a comparison should see). */
export function stripIsolates(value: string): string {
  return value.replaceAll(LRI, "").replaceAll(PDI, "");
}
