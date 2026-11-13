// The one way platform code turns untrusted HTML into HTML a browser reads:
// parse it into a tree, decide per element, and write the output from what is
// kept. Both sanitizers (merchant rich text, `html-sanitize.ts`; an app's
// storefront markup, `plugins/html.ts`) write through these primitives and
// never hand a parsed node back to a serializer, so a node's stale parent can
// never change how its text is written.
//
// What makes the output safe whatever the parser made of the input:
// - every text is escaped (`& < >`, and no-break spaces as `&nbsp;`), and
//   every attribute value is quoted and escaped (`& < > "`), so decoded
//   entities stay text and a `<` in the output always opens a tag the writer
//   wrote;
// - no element whose content the browser does not parse as markup (raw text,
//   RCDATA: `RAW_TEXT_ELEMENTS`) is written with content, so the browser reads
//   exactly the tags written here.


/**
 * Elements whose content a browser reads as text, not markup (raw text and
 * RCDATA, `noscript` with scripting on). A sanitizer drops them with their
 * content; written at all, they are written empty (a video embed's `iframe`)
 * or with escaped text only (an app's `textarea`).
 */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "template", "textarea", "title", "xmp",
]);

/** Elements with no end tag and no content. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

/**
 * How untrusted HTML is read into a tree (`parseDocument(untrustedHtml(input),
 * UNTRUSTED_HTML_PARSING)`): NULs, zero-width spaces and byte order marks go
 * (joiners and non-joiners stay: Bengali and Devanagari spell with them), entities
 * are decoded once, tag and attribute names are lower case. HTML elements
 * ignore `<x/>`, as a browser does; SVG callers turn `recognizeSelfClosing` on.
 * (The tree types stay out of this module's signatures: the plugin SDK ships
 * its declarations.)
 */
export const UNTRUSTED_HTML_PARSING = Object.freeze({
  decodeEntities: true,
  lowerCaseTags: true,
  lowerCaseAttributeNames: true,
  recognizeSelfClosing: false,
});

export function untrustedHtml(html: string): string {
  return html.replace(/[\0\u200B\uFEFF]/g, "");
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\u00a0": "&nbsp;" };

/** Text content, escaped: `& < >` and no-break spaces (so they survive an editor round trip). */
export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>\u00a0]/g, (char) => ESCAPES[char]!);
}

/** A double-quoted attribute value, escaped: `& < > "` and no-break spaces. */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"\u00a0]/g, (char) => ESCAPES[char]!);
}

/**
 * A start tag. Names come from the caller's allowlist, never from input. An
 * empty value is written bare (`hidden`), or quoted (`alt=""`) when `empty`
 * is "quoted", as a browser serializes it, so editor HTML round-trips byte
 * for byte.
 */
export function writeStartTag(
  name: string,
  attributes: Iterable<readonly [string, string]>,
  empty: "bare" | "quoted" = "bare",
): string {
  let tag = `<${name}`;
  for (const [key, value] of attributes) {
    tag += value === "" && empty === "bare" ? ` ${key}` : ` ${key}="${escapeHtmlAttribute(value)}"`;
  }
  return `${tag}>`;
}
