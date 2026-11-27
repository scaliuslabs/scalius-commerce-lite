// A theme's stylesheet for its header and footer on a buyer's own page (skins
// with `buyerPages: true`). The browser never fetches the app's file there:
// the store reads its bytes, checks them here, and writes the checked text
// into the chrome's shadow root itself (apps/storefront PrivateChrome.astro),
// inside the `theme` cascade layer. So the browser reads exactly the text this
// module read, through the same decoder:
// - the bytes must be UTF-8 with no byte-order mark and no `@charset` (no other
//   decoder can apply), and hold no `</style` (the text cannot leave its element);
// - the text is tokenized as CSS Syntax Level 3 §4 does (comments, strings,
//   escapes, unquoted `url(` tokens and bad-url recovery), and a sheet with a
//   parse error the browser would recover from (a bad string, a bad url,
//   unbalanced blocks, `<!--`/`-->`) is refused, so the text stays inside the
//   layer block the store wraps it in;
// - at-rules come from an allow-list (`@media`, `@supports`, `@layer`,
//   `@container`, `@keyframes`, `@scope`, `@starting-style`): no `@import`, no
//   registration (`@font-face`, `@property`, `@counter-style`, …) a browser
//   might keep for the whole document;
// - `:host-context()` is refused, and `:host` may stand only as itself or with
//   attribute selectors (`:host([data-color-scheme="dark"])`), never chained
//   with another pseudo-class or given a selector (`:host(:is(body *))`,
//   `:host:has(~ *)`) that could match the page around the host.
// Relative `url()`s are rebased onto the release's files, as they read when the
// file was linked. Self-contained (no imports): the rendered gate's
// differential test loads it as it is into Node beside Chromium.

/** The at-rules a buyer-page sheet may hold (ASCII lower case, vendor prefixes as written). */
export const BUYER_CHROME_CSS_AT_RULES = ["media", "supports", "layer", "container", "keyframes", "-webkit-keyframes", "scope", "starting-style"] as const;

export type CssToken =
  | { type: "ws" | "comma" | "colon" | "semicolon" | "(" | ")" | "[" | "]" | "{" | "}" | "cdo" | "cdc" | "bad-string" | "bad-url"; start: number; end: number }
  | { type: "string" | "url"; value: string; start: number; end: number }
  | { type: "ident" | "function" | "at-keyword" | "hash"; value: string; start: number; end: number }
  | { type: "number" | "percentage"; start: number; end: number }
  | { type: "dimension"; unit: string; start: number; end: number }
  | { type: "delim"; value: string; start: number; end: number };

/** CSS Syntax §3.3: CR, FF and CRLF become LF, NUL becomes U+FFFD. */
export function preprocessCss(text: string): string {
  return text.replace(/\r\n|[\r\f]/g, "\n").replace(/\0/g, "�");
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isLetter = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);
const isNonAscii = (c: string | undefined) => c !== undefined && c.codePointAt(0)! >= 0x80;
const isIdentStart = (c: string | undefined) => isLetter(c) || isNonAscii(c) || c === "_";
const isIdent = (c: string | undefined) => isIdentStart(c) || isDigit(c) || c === "-";
const isWhitespace = (c: string | undefined) => c === "\n" || c === "\t" || c === " ";
const isNonPrintable = (c: string | undefined) => {
  if (c === undefined) return false;
  const code = c.codePointAt(0)!;
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
};
const validEscape = (a: string | undefined, b: string | undefined) => a === "\\" && b !== "\n" && b !== undefined;

/**
 * The text's tokens as the browser's tokenizer makes them (CSS Syntax §4.3),
 * comments left out. Names (identifiers, functions, at-keywords, hashes) and
 * string and url values are escape-decoded.
 */
export function cssTokens(input: string): CssToken[] {
  const text = preprocessCss(input);
  // Code points, so a supplementary character is one unit as the spec reads it.
  const chars = Array.from(text);
  const offsets: number[] = [];
  let offset = 0;
  for (const char of chars) { offsets.push(offset); offset += char.length; }
  offsets.push(offset);
  let i = 0;
  const at = (n = 0) => chars[i + n];
  const tokens: CssToken[] = [];

  const consumeEscape = (): string => {
    // The backslash is consumed already.
    const c = chars[i++];
    if (c === undefined) return "�";
    if (isHex(c)) {
      let hex = c;
      while (hex.length < 6 && isHex(at())) hex += chars[i++];
      if (isWhitespace(at())) i += 1;
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
    }
    return c;
  };
  const startsIdent = (a: string | undefined, b: string | undefined, c: string | undefined) =>
    a === "-" ? isIdentStart(b) || b === "-" || validEscape(b, c) : isIdentStart(a) ? true : a === "\\" ? validEscape(a, b) : false;
  const startsNumber = (a: string | undefined, b: string | undefined, c: string | undefined) =>
    a === "+" || a === "-" ? isDigit(b) || (b === "." && isDigit(c)) : a === "." ? isDigit(b) : isDigit(a);
  const consumeIdentSequence = (): string => {
    let out = "";
    for (;;) {
      const c = at();
      if (isIdent(c)) { out += c; i += 1; }
      else if (validEscape(c, at(1))) { i += 1; out += consumeEscape(); }
      else return out;
    }
  };
  const consumeNumber = () => {
    if (at() === "+" || at() === "-") i += 1;
    while (isDigit(at())) i += 1;
    if (at() === "." && isDigit(at(1))) { i += 2; while (isDigit(at())) i += 1; }
    if ((at() === "e" || at() === "E") && (isDigit(at(1)) || ((at(1) === "+" || at(1) === "-") && isDigit(at(2))))) {
      i += at(1) === "+" || at(1) === "-" ? 3 : 2;
      while (isDigit(at())) i += 1;
    }
  };
  const consumeBadUrlRemnants = () => {
    for (;;) {
      const c = chars[i++];
      if (c === undefined || c === ")") return;
      if (validEscape(c, at())) consumeEscape();
    }
  };
  const consumeUrl = (start: number): CssToken => {
    let value = "";
    while (isWhitespace(at())) i += 1;
    for (;;) {
      const c = chars[i++];
      if (c === ")" || c === undefined) return { type: "url", value, start, end: offsets[i]! };
      if (isWhitespace(c)) {
        while (isWhitespace(at())) i += 1;
        if (at() === ")" || at() === undefined) { if (at() === ")") i += 1; return { type: "url", value, start, end: offsets[i]! }; }
        consumeBadUrlRemnants();
        return { type: "bad-url", start, end: offsets[i]! };
      }
      if (c === "\"" || c === "'" || c === "(" || isNonPrintable(c)) {
        consumeBadUrlRemnants();
        return { type: "bad-url", start, end: offsets[i]! };
      }
      if (c === "\\") {
        if (validEscape(c, at())) { value += consumeEscape(); continue; }
        consumeBadUrlRemnants();
        return { type: "bad-url", start, end: offsets[i]! };
      }
      value += c;
    }
  };
  const consumeIdentLike = (start: number): CssToken => {
    const name = consumeIdentSequence();
    if (name.toLowerCase() === "url" && at() === "(") {
      i += 1;
      while (isWhitespace(at()) && isWhitespace(at(1))) i += 1;
      const next = isWhitespace(at()) ? at(1) : at();
      if (next === "\"" || next === "'") return { type: "function", value: name, start, end: offsets[i]! };
      return consumeUrl(start);
    }
    if (at() === "(") { i += 1; return { type: "function", value: name, start, end: offsets[i]! }; }
    return { type: "ident", value: name, start, end: offsets[i]! };
  };
  const consumeString = (quote: string, start: number): CssToken => {
    let value = "";
    for (;;) {
      const c = chars[i++];
      if (c === undefined || c === quote) return { type: "string", value, start, end: offsets[i]! };
      if (c === "\n") { i -= 1; return { type: "bad-string", start, end: offsets[i]! }; }
      if (c === "\\") {
        if (at() === undefined) continue;
        if (at() === "\n") { i += 1; continue; }
        value += consumeEscape();
        continue;
      }
      value += c;
    }
  };

  while (i < chars.length) {
    const start = offsets[i]!;
    const c = at();
    if (c === "/" && at(1) === "*") {
      i += 2;
      while (i < chars.length && !(at() === "*" && at(1) === "/")) i += 1;
      i = Math.min(chars.length, i + 2);
      continue;
    }
    if (isWhitespace(c)) {
      while (isWhitespace(at())) i += 1;
      tokens.push({ type: "ws", start, end: offsets[i]! });
      continue;
    }
    if (c === "\"" || c === "'") { i += 1; tokens.push(consumeString(c, start)); continue; }
    if (c === "#") {
      if (isIdent(at(1)) || validEscape(at(1), at(2))) {
        i += 1;
        tokens.push({ type: "hash", value: consumeIdentSequence(), start, end: offsets[i]! });
      } else { i += 1; tokens.push({ type: "delim", value: "#", start, end: offsets[i]! }); }
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}") { i += 1; tokens.push({ type: c, start, end: offsets[i]! }); continue; }
    if (c === ",") { i += 1; tokens.push({ type: "comma", start, end: offsets[i]! }); continue; }
    if (c === ":") { i += 1; tokens.push({ type: "colon", start, end: offsets[i]! }); continue; }
    if (c === ";") { i += 1; tokens.push({ type: "semicolon", start, end: offsets[i]! }); continue; }
    if (startsNumber(c, at(1), at(2))) {
      consumeNumber();
      if (startsIdent(at(), at(1), at(2))) tokens.push({ type: "dimension", unit: consumeIdentSequence(), start, end: offsets[i]! });
      else if (at() === "%") { i += 1; tokens.push({ type: "percentage", start, end: offsets[i]! }); }
      else tokens.push({ type: "number", start, end: offsets[i]! });
      continue;
    }
    if (c === "-" && at(1) === "-" && at(2) === ">") { i += 3; tokens.push({ type: "cdc", start, end: offsets[i]! }); continue; }
    if (c === "<" && at(1) === "!" && at(2) === "-" && at(3) === "-") { i += 4; tokens.push({ type: "cdo", start, end: offsets[i]! }); continue; }
    if (c === "@" && startsIdent(at(1), at(2), at(3))) {
      i += 1;
      tokens.push({ type: "at-keyword", value: consumeIdentSequence(), start, end: offsets[i]! });
      continue;
    }
    if (startsIdent(c, at(1), at(2))) { tokens.push(consumeIdentLike(start)); continue; }
    i += 1;
    tokens.push({ type: "delim", value: c!, start, end: offsets[i]! });
  }
  return tokens;
}

const lower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const ALLOWED_AT_RULES = new Set<string>(BUYER_CHROME_CSS_AT_RULES);
const CLOSERS: Record<string, string> = { "{": "}", "(": ")", "[": "]", function: ")" };
/** What a `:host(...)` argument may hold: attribute selectors only. */
const HOST_ARGUMENT = new Set(["ident", "string"]);
const ATTRIBUTE_DELIMS = new Set(["=", "~", "|", "^", "$", "*"]);

/** Why the decoded text cannot style a buyer page's chrome, or null when it can. */
export function buyerChromeCssProblem(text: string): string | null {
  if (/<\/style/i.test(text)) return "the stylesheet holds </style, which would end the element it is written in";
  const tokens = cssTokens(text);
  const stack: string[] = [];
  const significant = tokens.filter((token) => token.type !== "ws");
  for (let n = 0; n < tokens.length; n += 1) {
    const token = tokens[n]!;
    switch (token.type) {
      case "bad-string": return "the stylesheet holds a string with a line break in it (a parse error)";
      case "bad-url": return "the stylesheet holds a malformed url() (a parse error)";
      case "cdo":
      case "cdc": return "the stylesheet holds <!-- or -->";
      case "at-keyword":
        if (!ALLOWED_AT_RULES.has(lower(token.value))) return `the stylesheet holds @${lower(token.value)}, which reaches past the chrome's shadow root (only @${BUYER_CHROME_CSS_AT_RULES.join(", @")})`;
        break;
      case "{":
      case "(":
      case "[":
        stack.push(token.type);
        break;
      case "function":
        if (lower(token.value) === "host-context") return "the stylesheet holds host-context, which reaches past the chrome's shadow root";
        stack.push("function");
        break;
      case "}":
      case ")":
      case "]": {
        const open = stack.pop();
        if (open === undefined || CLOSERS[open] !== token.type) return "the stylesheet's blocks are not balanced";
        break;
      }
      case "ident":
        if (lower(token.value) === "host-context") return "the stylesheet holds host-context, which reaches past the chrome's shadow root";
        break;
      default:
        break;
    }
  }
  if (stack.length > 0) return "the stylesheet's blocks are not balanced";
  // `:host` as itself, or with attribute selectors: never chained with a pseudo-class or given a selector.
  for (let n = 0; n < significant.length; n += 1) {
    const colon = significant[n]!;
    const name = significant[n + 1];
    if (colon.type !== "colon" || !name || (name.type !== "ident" && name.type !== "function") || lower(name.value) !== "host") continue;
    let next = n + 2;
    if (name.type === "function") {
      // Only `[...]` attribute selectors: outside a bracket nothing but whitespace.
      let inBracket = false;
      for (let m = tokens.indexOf(name) + 1; m < tokens.length; m += 1) {
        const token = tokens[m]!;
        if (token.type === ")" && !inBracket) { next = significant.indexOf(token) + 1; break; }
        if (token.type === "[" && !inBracket) { inBracket = true; continue; }
        if (token.type === "]" && inBracket) { inBracket = false; continue; }
        const allowed = token.type === "ws" || (inBracket && (HOST_ARGUMENT.has(token.type) || (token.type === "delim" && ATTRIBUTE_DELIMS.has(token.value))));
        if (!allowed || token.type === "[" || token.type === "]") return "the stylesheet gives :host() a selector other than attributes, which can match the page around the host";
      }
    }
    const after = significant[next];
    if (after?.type === "colon" && significant[next + 1]?.type !== "colon") return "the stylesheet chains a pseudo-class onto :host, which can match the page around the host";
  }
  return null;
}

/** The checked text of a buyer page's theme sheet, ready for its `theme` layer, or why there is none. */
export type BuyerChromeSheet = { ok: true; text: string } | { ok: false; problem: string };

const ABSOLUTE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|#)/;
const URL_FUNCTIONS = new Set(["url", "src", "image-set", "-webkit-image-set"]);

/** A URL written as a CSS string no quote, backslash, line break or `<` can end. */
function cssString(value: string): string {
  return `"${value.replace(/["\\\n<>]/g, (c) => `\\${c.codePointAt(0)!.toString(16)} `)}"`;
}

/** Relative `url()`s (and strings in `image-set()`, `src()`) rebased onto `base`, the release's file folder (`/_x/<app>/<release>/`). */
function rebased(text: string, base: string): string {
  const tokens = cssTokens(text);
  const source = preprocessCss(text);
  const edits: Array<{ start: number; end: number; with: string }> = [];
  const rebase = (value: string) => (ABSOLUTE.test(value) ? null : new URL(value, `https://store.invalid${base}`).pathname + new URL(value, `https://store.invalid${base}`).search);
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.type === "function") stack.push(lower(token.value));
    else if (token.type === "(" || token.type === "[" || token.type === "{") stack.push("");
    else if (token.type === ")" || token.type === "]" || token.type === "}") stack.pop();
    if (token.type === "url") {
      const value = rebase(token.value);
      if (value !== null) edits.push({ start: token.start, end: token.end, with: `url(${cssString(value)})` });
    } else if (token.type === "string" && URL_FUNCTIONS.has(stack.at(-1) ?? "")) {
      const value = rebase(token.value);
      if (value !== null) edits.push({ start: token.start, end: token.end, with: cssString(value) });
    }
  }
  let out = source;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.with + out.slice(edit.end);
  return out;
}

/**
 * The app's `styles.css` bytes as a buyer page's chrome may use them: valid
 * UTF-8 with no byte-order mark and no `@charset`, passing
 * `buyerChromeCssProblem`, with relative URLs rebased onto `base`. The text
 * is checked again after rebasing: what the store writes is what passed.
 */
export function checkedBuyerChromeSheet(bytes: Uint8Array, base: string): BuyerChromeSheet {
  const problem = buyerChromeSheetBytesProblem(bytes);
  if (problem) return { ok: false, problem };
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const first = buyerChromeCssProblem(text);
  if (first) return { ok: false, problem: first };
  const out = rebased(text, base);
  const second = buyerChromeCssProblem(out);
  return second ? { ok: false, problem: second } : { ok: true, text: out };
}

/** Why the bytes are not a sheet one decoder reads one way (UTF-8, no byte-order mark, no `@charset`), or null. */
export function buyerChromeSheetBytesProblem(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "the stylesheet starts with a byte-order mark";
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return "the stylesheet is UTF-16 (a byte-order mark)";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "the stylesheet is not valid UTF-8";
  }
  if (/@charset/i.test(text)) return "the stylesheet holds @charset";
  return null;
}
