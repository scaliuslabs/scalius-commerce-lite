// A theme's stylesheet for its header and footer on a buyer's own page (skins
// with `buyerPages: true`). The browser never reads the app's file there, and
// never reads the theme's text beside the store's: the store parses the app's
// `styles.css`, checks every rule, and writes a new sheet of its own from what
// it parsed (`checkedBuyerChromeSheet`), in ASCII, which it serves as a file
// of its own at a content-addressed path (apps/storefront lib/extensions
// files.ts `/_buyer-chrome/...`) and imports into the chrome's shadow root in
// the `theme` layer. A separate sheet ends where it ends: nothing at its end
// can reach the store's rules after the import.
//
// The parse follows CSS Syntax Level 3 (§4 tokens: comments, strings,
// escapes, unquoted url tokens, bad-url recovery; §5 rules and blocks), and is
// strict: a sheet the browser would read only by recovering from an error (a
// bad string or url, an unclosed comment, string, url or block, a stray
// backslash, a mismatched bracket, `<!--`) is refused. Then:
// - bytes: UTF-8 with no byte-order mark and no `@charset`;
// - rules: style rules whose blocks hold declarations only (no nesting), in
//   `@media`, `@supports`, `@layer`, `@container`, `@starting-style`, and
//   `@keyframes`; every other at-rule is refused (`@import`, `@font-face`,
//   `@property`, `@scope`, ...);
// - selectors: no `:host-context()`; `:host` only as a compound of its own
//   (`:host`, `:host([attr])`, then a combinator, a comma or a
//   pseudo-element), never inside another pseudo-class (`:is(:host)`) or
//   beside another simple selector (`:host:has(...)`, `.x:host`): what it
//   matches is the store's host by the host's own attributes;
// - URLs: every one that can fetch (`url()`, `image-set()`) resolves within
//   the app's own public files (written `./public/...`) or is a fragment
//   (`url(#filter)`); nothing that would choose a URL later (`var()`, `env()`,
//   `attr()` inside `image-set()`, `src()`, `image()`, `cross-fade()`,
//   `element()`) and no `data:`.
// The new sheet is written from the parse alone: rules, selectors and values
// re-serialized token by token, every non-ASCII character as a CSS escape.
// Self-contained (no imports): the differential test loads it into Node
// beside Chromium as it is.

/** The at-rules a buyer-page sheet may hold (ASCII lower case, vendor prefixes as written). */
export const BUYER_CHROME_CSS_AT_RULES = ["media", "supports", "layer", "container", "keyframes", "-webkit-keyframes", "starting-style"] as const;

export type CssToken =
  | { type: "ws" | "comma" | "colon" | "semicolon" | "(" | ")" | "[" | "]" | "{" | "}" | "cdo" | "cdc" | "bad-string" | "bad-url"; start: number; end: number }
  | { type: "string" | "url"; value: string; start: number; end: number; eof?: true }
  | { type: "bad-comment"; start: number; end: number }
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
      if (c === undefined) return { type: "url", value, start, end: offsets[i]!, eof: true };
      if (c === ")") return { type: "url", value, start, end: offsets[i]! };
      if (isWhitespace(c)) {
        while (isWhitespace(at())) i += 1;
        if (at() === undefined) return { type: "url", value, start, end: offsets[i]!, eof: true };
        if (at() === ")") { i += 1; return { type: "url", value, start, end: offsets[i]! }; }
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
      if (c === undefined) return { type: "string", value, start, end: offsets[i]!, eof: true };
      if (c === quote) return { type: "string", value, start, end: offsets[i]! };
      if (c === "\n") { i -= 1; return { type: "bad-string", start, end: offsets[i]! }; }
      if (c === "\\") {
        if (at() === undefined) return { type: "string", value, start, end: offsets[i]!, eof: true };
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
      if (i >= chars.length) { tokens.push({ type: "bad-comment", start, end: offsets[chars.length]! }); break; }
      i += 2;
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
const GROUP_AT_RULES = new Set(["media", "supports", "layer", "container", "starting-style"]);
const KEYFRAMES = new Set(["keyframes", "-webkit-keyframes"]);
/** Functions that would choose a URL at computed time, or fetch one the store did not resolve. */
const REFUSED_FUNCTIONS = new Set(["src", "image", "cross-fade", "-webkit-cross-fade", "element", "-moz-element", "host-context"]);
const IMAGE_SET = new Set(["image-set", "-webkit-image-set"]);
const SUBSTITUTIONS = new Set(["var", "env", "attr"]);
const ATTRIBUTE_DELIMS = new Set(["=", "~", "|", "^", "$", "*"]);
const COMBINATOR_DELIMS = new Set([">", "+", "~"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** A component value (CSS Syntax §5.4.7): a token, a function with its arguments, or a bracketed block. */
export type CssComponent =
  | CssToken
  | { type: "func"; name: string; values: CssComponent[] }
  | { type: "block"; open: "{" | "(" | "["; values: CssComponent[] };

/** One parsed rule, as the store writes it (and as the browser must read it back). */
export type CssRule =
  | { kind: "style"; selector: string; declarations: CssDeclaration[] }
  | { kind: "group"; name: string; prelude: string; rules: CssRule[] }
  | { kind: "layer-statement"; prelude: string }
  | { kind: "keyframes"; name: string; prelude: string; frames: Array<{ selector: string; declarations: CssDeclaration[] }> };

export interface CssDeclaration {
  name: string;
  value: string;
  important: boolean;
}

/** A sheet the store parsed and checked: its rules and the ASCII text it writes from them. */
export type BuyerChromeSheet = { ok: true; rules: CssRule[]; text: string } | { ok: false; problem: string };

class Refusal extends Error {}
const refuse = (problem: string): never => { throw new Refusal(problem); };

/** Tokens into component values, strictly: every bracket and function closed by its own closer before the end. */
function components(tokens: CssToken[]): CssComponent[] {
  let index = 0;
  const closer: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const list = (end: string | null): CssComponent[] => {
    const out: CssComponent[] = [];
    for (;;) {
      const token = tokens[index++];
      if (token === undefined) {
        if (end !== null) refuse("the stylesheet ends inside an open block");
        return out;
      }
      switch (token.type) {
        case "bad-string": refuse("the stylesheet holds a string with a line break in it (a parse error)"); break;
        case "bad-url": refuse("the stylesheet holds a malformed url() (a parse error)"); break;
        case "bad-comment": refuse("the stylesheet ends inside a comment"); break;
        case "cdo": case "cdc": refuse("the stylesheet holds <!-- or -->"); break;
        case "string": case "url": if (token.eof) refuse(`the stylesheet ends inside a ${token.type === "url" ? "url()" : "string"}`); out.push(token); break;
        case "delim": if (token.value === "\\") refuse("the stylesheet holds a stray backslash"); out.push(token); break;
        case "{": case "(": case "[": out.push({ type: "block", open: token.type, values: list(closer[token.type]!) }); break;
        case "function": out.push({ type: "func", name: lower(token.value), values: list(")") }); break;
        case "}": case ")": case "]":
          if (token.type !== end) refuse("the stylesheet's blocks are not balanced");
          return out;
        default: out.push(token);
      }
    }
  };
  return list(null);
}

const isWs = (value: CssComponent | undefined) => value?.type === "ws";
function trim(values: CssComponent[]): CssComponent[] {
  let start = 0;
  let end = values.length;
  while (start < end && isWs(values[start])) start += 1;
  while (end > start && isWs(values[end - 1])) end -= 1;
  return values.slice(start, end);
}

/** An identifier as CSSOM serializes one (every non-ASCII code point escaped as hex, so the text is ASCII). */
function identifier(name: string): string {
  let out = "";
  const points = Array.from(name);
  points.forEach((c, at) => {
    const code = c.codePointAt(0)!;
    if (code === 0) out += "\\fffd ";
    else if ((code >= 0x01 && code <= 0x1f) || code === 0x7f || code >= 0x80) out += `\\${code.toString(16)} `;
    else if (at === 0 && /[0-9]/.test(c)) out += `\\${code.toString(16)} `;
    else if (at === 1 && /[0-9]/.test(c) && points[0] === "-") out += `\\${code.toString(16)} `;
    else if (at === 0 && c === "-" && points.length === 1) out += "\\-";
    else if (/[A-Za-z0-9_-]/.test(c)) out += c;
    else out += `\\${c}`;
  });
  return out;
}

/** A string as CSSOM serializes one, in ASCII: quotes, backslashes, controls and non-ASCII as escapes. */
function quoted(value: string): string {
  let out = "\"";
  for (const c of value) {
    const code = c.codePointAt(0)!;
    if (code === 0) out += "\\fffd ";
    else if (code <= 0x1f || code === 0x7f || code >= 0x80 || c === "<" || c === ">") out += `\\${code.toString(16)} `;
    else if (c === "\"" || c === "\\") out += `\\${c}`;
    else out += c;
  }
  return `${out}"`;
}

/** A hash's name: every character outside `[A-Za-z0-9_-]` escaped. */
function hashName(name: string): string {
  return Array.from(name).map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : `\\${c.codePointAt(0)!.toString(16)} `)).join("");
}

interface Context {
  source: string;
}

/** Where URLs are resolved: a stand-in for the release's own folder, which the written sheet never names. */
const RELEASE = "/_x/app.release/release/";

/**
 * A URL a sheet names, resolved within the app's own public files and written
 * relative to them (`./public/...`): the store serves the written sheet beside
 * them (`/_buyer-chrome/<app>/<release>/`), so it resolves there and nowhere
 * else. A fragment (`#filter`, a local reference) stays as it is. Anything
 * else is refused: another app's files, the app's proxy, the API, another
 * host, `data:`.
 */
function resolveUrl(value: string): string {
  if (value.startsWith("#") && NAME.test(value.slice(1))) return value;
  if (/^\s*data:/i.test(value)) refuse("the stylesheet names a data: URL");
  let url: URL;
  try {
    url = new URL(value, `https://store.invalid${RELEASE}`);
  } catch {
    return refuse(`the stylesheet names a URL it cannot resolve (${JSON.stringify(value)})`);
  }
  if (url.origin !== "https://store.invalid" || !url.pathname.startsWith(`${RELEASE}public/`) || url.hash) {
    refuse(`the stylesheet names ${JSON.stringify(value)}, outside the app's own public files`);
  }
  return `./${url.pathname.slice(RELEASE.length)}${url.search}`;
}

/** Component values written back as ASCII text, URLs resolved, every fetching function checked. */
function serialize(values: CssComponent[], context: Context, within: string | null = null): string {
  let out = "";
  const push = (text: string) => {
    // Two tokens that would read as one (`a` `(`, `1` `px`, `/` `*`) keep a comment between them.
    const last = out.at(-1) ?? "";
    const first = text[0] ?? "";
    const word = (c: string) => /[A-Za-z0-9_\\%-]/.test(c);
    if (out !== "" && ((word(last) && (word(first) || first === "(")) || (last === "/" && first === "*") || (last === "@" && word(first)) || (last === "#" && word(first)) || (last === "-" && /[0-9.]/.test(first)) || (last === "<" && first === "!"))) out += "/**/";
    out += text;
  };
  for (const value of values) {
    switch (value.type) {
      case "ws": out += " "; break;
      case "ident": push(identifier(value.value)); break;
      case "at-keyword": push(`@${identifier(value.value)}`); break;
      case "hash": push(`#${hashName(value.value)}`); break;
      case "string":
        push(quoted(IMAGE_SET.has(within ?? "") ? resolveUrl(value.value) : value.value));
        break;
      case "url": push(`url(${quoted(resolveUrl(value.value))})`); break;
      case "number": case "percentage": push(context.source.slice(value.start, value.end)); break;
      case "dimension": {
        const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(context.source.slice(value.start, value.end))?.[0] ?? "0";
        push(`${number}${identifier(value.unit)}`);
        break;
      }
      case "delim": push(value.value); break;
      case "comma": out += ","; break;
      case "colon": push(":"); break;
      case "semicolon": out += ";"; break;
      case "func": {
        if (REFUSED_FUNCTIONS.has(value.name)) refuse(`the stylesheet uses ${value.name}(), which reaches past the chrome's shadow root or fetches a URL the store did not resolve`);
        if (IMAGE_SET.has(value.name) && hasSubstitution(value.values)) refuse(`the stylesheet substitutes a value into ${value.name}(), so the store cannot resolve its URLs`);
        if (value.name === "url") {
          const args = trim(value.values);
          if (args.length !== 1 || args[0]!.type !== "string") refuse("the stylesheet holds a url() with something other than one string");
          push(`url(${quoted(resolveUrl((args[0] as { value: string }).value))})`);
          break;
        }
        push(`${identifier(value.name)}(`);
        out += serialize(value.values, context, IMAGE_SET.has(value.name) ? value.name : within);
        out += ")";
        break;
      }
      case "block": {
        const close = value.open === "{" ? "}" : value.open === "(" ? ")" : "]";
        push(value.open);
        out += serialize(value.values, context, within);
        out += close;
        break;
      }
      default:
        refuse(`the stylesheet holds a ${value.type} token it may not`);
    }
  }
  return out;
}

function hasSubstitution(values: CssComponent[]): boolean {
  return values.some((value) => (value.type === "func" && (SUBSTITUTIONS.has(value.name) || hasSubstitution(value.values))) || (value.type === "block" && hasSubstitution(value.values)));
}

/** Whether a selector's `:host` stands only as a compound of its own, with attribute selectors at most. */
function checkSelector(values: CssComponent[]): void {
  const visit = (list: CssComponent[], nested: boolean) => {
    list.forEach((value, at) => {
      if (value.type === "func" && value.name === "host-context") refuse("the stylesheet holds host-context, which reaches past the chrome's shadow root");
      if (value.type === "semicolon") refuse("the stylesheet holds a semicolon in a selector");
      // `&` and `:scope` outside a nested rule stand for the scoping root: the host itself.
      if (value.type === "delim" && value.value === "&") refuse("the stylesheet uses & outside a nested rule (it stands for the host)");
      if (value.type === "ident" && lower(value.value) === "scope" && list[at - 1]?.type === "colon") refuse("the stylesheet uses :scope (it stands for the host)");
      const hostName = value.type === "ident" ? value.value : value.type === "func" ? value.name : null;
      if (hostName !== null && lower(hostName) === "host" && list[at - 1]?.type === "colon") {
        if (nested) refuse("the stylesheet puts :host inside another pseudo-class, which can match the page around the host");
        // At the start of its complex selector: nothing before it in its compound, and no combinator to its left.
        let back = at - 2;
        while (list[back]?.type === "ws") back -= 1;
        const before = list[back];
        if (before !== undefined && before.type !== "comma") refuse("the stylesheet puts something before :host, which can match the page around the host");
        if (list[at - 2] !== undefined && list[at - 2]!.type !== "ws" && list[at - 2]!.type !== "comma") refuse("the stylesheet joins :host to another simple selector, which can match the page around the host");
        if (value.type === "func") {
          const argument = trim(value.values);
          for (const part of argument) {
            if (part.type === "ws") continue;
            if (part.type !== "block" || part.open !== "[" || !part.values.every((inner) => inner.type === "ws" || inner.type === "ident" || inner.type === "string" || (inner.type === "delim" && ATTRIBUTE_DELIMS.has(inner.value)))) {
              refuse("the stylesheet gives :host() a selector other than attributes, which can match the page around the host");
            }
          }
          if (argument.length === 0) refuse("the stylesheet gives :host() nothing to match");
        }
        const after = list[at + 1];
        const pseudoElement = after?.type === "colon" && list[at + 2]?.type === "colon";
        if (after !== undefined && !pseudoElement && !(after.type === "ws" || after.type === "comma" || (after.type === "delim" && COMBINATOR_DELIMS.has(after.value)))) {
          refuse("the stylesheet chains another selector onto :host, which can match the page around the host");
        }
      }
      if (value.type === "func" || value.type === "block") visit(value.values, nested || value.type === "func");
    });
  };
  visit(values, false);
}

/** A style rule's block: declarations only (CSS nesting is refused: a nested selector is judged nowhere). */
function declarations(values: CssComponent[], context: Context): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  let segment: CssComponent[] = [];
  const flush = () => {
    const part = trim(segment);
    segment = [];
    if (part.length === 0) return;
    const [name, ...rest] = part;
    if (name?.type !== "ident") {
      refuse(name?.type === "at-keyword" ? "the stylesheet nests an at-rule in a style rule" : "the stylesheet nests a rule in a style rule (CSS nesting), or holds a stray token there");
    }
    const after = trim(rest);
    if (after[0]?.type !== "colon") refuse("the stylesheet nests a rule in a style rule (CSS nesting), or holds a declaration with no colon");
    let value = trim(after.slice(1));
    if (value.some((item) => item.type === "block" && item.open === "{")) refuse("the stylesheet nests a rule in a style rule (CSS nesting)");
    let important = false;
    const last = value.at(-1);
    const bang = value.at(-2);
    const bangWs = value.at(-3);
    if (last?.type === "ident" && lower(last.value) === "important") {
      if (bang?.type === "delim" && bang.value === "!") { important = true; value = trim(value.slice(0, -2)); }
      else if (bang?.type === "ws" && bangWs?.type === "delim" && bangWs.value === "!") { important = true; value = trim(value.slice(0, -3)); }
    }
    const property = (name as { value: string }).value;
    out.push({ name: property.startsWith("--") ? property : lower(property), value: serialize(value, context), important });
  };
  for (const value of values) {
    if (value.type === "semicolon") flush();
    else segment.push(value);
  }
  flush();
  return out;
}

/** A rule list (the sheet, or a group at-rule's block). */
function rules(values: CssComponent[], context: Context, inKeyframes = false): CssRule[] {
  const out: CssRule[] = [];
  let index = 0;
  while (index < values.length) {
    const value = values[index]!;
    if (value.type === "ws" || value.type === "semicolon") { index += 1; continue; }
    const prelude: CssComponent[] = [];
    let block: CssComponent[] | null = null;
    let ended = false;
    const at = value.type === "at-keyword" ? lower(value.value) : null;
    if (at !== null) index += 1;
    while (index < values.length) {
      const next = values[index++]!;
      if (next.type === "block" && next.open === "{") { block = next.values; break; }
      if (next.type === "semicolon" && at !== null) { ended = true; break; }
      prelude.push(next);
    }
    if (at !== null) {
      if (!ALLOWED_AT_RULES.has(at)) refuse(`the stylesheet holds @${at}, which reaches past the chrome's shadow root (only @${BUYER_CHROME_CSS_AT_RULES.join(", @")})`);
      if (inKeyframes) refuse("the stylesheet nests an at-rule in @keyframes");
      const text = serialize(trim(prelude), context);
      if (block === null) {
        if (at !== "layer" || !ended) refuse(`the stylesheet's @${at} has no block`);
        out.push({ kind: "layer-statement", prelude: text });
      } else if (KEYFRAMES.has(at)) {
        out.push({ kind: "keyframes", name: at, prelude: text, frames: rules(block, context, true).map((rule) => rule as unknown as { selector: string; declarations: CssDeclaration[] }) });
      } else if (GROUP_AT_RULES.has(at)) {
        out.push({ kind: "group", name: at, prelude: text, rules: rules(block, context) });
      }
      continue;
    }
    if (block === null) refuse("the stylesheet ends inside a rule's selector");
    const selector = trim(prelude);
    if (selector.length === 0) refuse("the stylesheet holds a rule with no selector");
    if (!inKeyframes) checkSelector(selector);
    const written = serialize(selector, context);
    if (inKeyframes) out.push({ selector: written, declarations: declarations(block!, context) } as unknown as CssRule);
    else out.push({ kind: "style", selector: written, declarations: declarations(block!, context) });
  }
  return out;
}

function declarationsText(list: CssDeclaration[]): string {
  return list.map((declaration) => `${identifier(declaration.name)}:${declaration.value}${declaration.important ? "!important" : ""}`).join(";");
}

/** The rules written as the store's sheet. */
export function writtenCss(list: CssRule[]): string {
  return list.map((rule) => {
    switch (rule.kind) {
      case "style": return `${rule.selector}{${declarationsText(rule.declarations)}}`;
      case "layer-statement": return `@layer ${rule.prelude};`;
      case "group": return `@${rule.name}${rule.prelude ? ` ${rule.prelude}` : ""}{${writtenCss(rule.rules)}}`;
      case "keyframes": return `@${rule.name} ${rule.prelude}{${rule.frames.map((frame) => `${frame.selector}{${declarationsText(frame.declarations)}}`).join("")}}`;
    }
  }).join("");
}

/** The sheet's rules, parsed and checked, or why it cannot style a buyer page's chrome. */
export function parsedBuyerChromeCss(text: string): BuyerChromeSheet {
  try {
    const source = preprocessCss(text);
    const tree = components(cssTokens(source));
    const list = rules(tree, { source });
    const written = writtenCss(list);
    if (!/^[\x20-\x7e]*$/.test(written)) refuse("the store's sheet would not be ASCII");
    return { ok: true, rules: list, text: written };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: error.message };
    throw error;
  }
}

/** Why the decoded text cannot style a buyer page's chrome, or null when it can. */
export function buyerChromeCssProblem(text: string): string | null {
  const parsed = parsedBuyerChromeCss(text);
  return parsed.ok ? null : parsed.problem;
}

/**
 * The app's `styles.css` bytes as a buyer page's chrome may use them: valid
 * UTF-8 with no byte-order mark and no `@charset`, parsed and checked, and
 * written again by the store as ASCII from its parse (`text`: what the release
 * ships as `buyer-chrome.css`), every fetching URL within the app's public
 * files. The text is parsed once more and must write itself unchanged: what
 * the store serves is a fixed point of its own reading.
 */
export function checkedBuyerChromeSheet(bytes: Uint8Array): BuyerChromeSheet {
  const problem = buyerChromeSheetBytesProblem(bytes);
  if (problem) return { ok: false, problem };
  const first = parsedBuyerChromeCss(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!first.ok) return first;
  const again = parsedBuyerChromeCss(first.text);
  if (!again.ok || again.text !== first.text) return { ok: false, problem: "the store could not write the stylesheet as it read it" };
  return first;
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
