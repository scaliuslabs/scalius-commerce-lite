// CSS Syntax Level 3 for the private pages' stylesheet (private-css.ts): a
// tokenizer, a parser to rules and declarations, and a serializer that writes
// tokens back so the browser reads exactly the tokens that were checked.
//
// It is strict where the specification recovers: a broken string, a broken
// url, an unterminated comment, an unbalanced block, a CDO or CDC token, a
// NUL and any escape outside a quoted string are refusals, not repairs, so
// no input reads one way here and another way in a browser. Comments are
// dropped; where dropping one would join two tokens, the serializer writes
// an empty comment between them, as the specification's serializer does.

/** A token (CSS Syntax 3, §4). Numbers keep their source text, which holds only digits, signs, `.` and `e`. */
export type CssToken =
  | { type: "whitespace" }
  | { type: "ident"; value: string }
  | { type: "function"; value: string }
  | { type: "at-keyword"; value: string }
  | { type: "hash"; value: string; id: boolean }
  | { type: "string"; value: string }
  | { type: "url"; value: string }
  | { type: "delim"; value: string }
  | { type: "number"; value: number; repr: string }
  | { type: "percentage"; value: number; repr: string }
  | { type: "dimension"; value: number; repr: string; unit: string }
  | { type: "colon" } | { type: "semicolon" } | { type: "comma" }
  | { type: "[" } | { type: "]" } | { type: "(" } | { type: ")" } | { type: "{" } | { type: "}" }
  | { type: "cdo" } | { type: "cdc" };

/** A component value: a token, a simple block or a function with its arguments. */
export type CssNode =
  | CssToken
  | { type: "block"; open: "{" | "[" | "("; values: CssNode[] }
  | { type: "fn"; name: string; values: CssNode[] };

export type CssRule =
  | { kind: "qualified"; prelude: CssNode[]; block: CssNode[] }
  | { kind: "at"; name: string; prelude: CssNode[]; block: CssNode[] | null };

export interface CssDeclaration {
  name: string;
  value: CssNode[];
  important: boolean;
}

export type CssSyntaxReason = "null_byte" | "bad_string" | "bad_url" | "escape" | "comment" | "unbalanced" | "syntax" | "nested_rule" | "too_deep";

export class CssSyntaxError extends Error {
  constructor(readonly reason: CssSyntaxReason, message: string, readonly at: number) {
    super(message);
    this.name = "CssSyntaxError";
  }
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"));
const isNameStart = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === "-";
const isWhitespace = (c: string | undefined) => c === " " || c === "\t" || c === "\n";
const validEscape = (a: string | undefined, b: string | undefined) => a === "\\" && b !== "\n" && b !== undefined;
const startsIdent = (a: string | undefined, b: string | undefined, c: string | undefined) =>
  a === "-" ? isNameStart(b) || b === "-" || validEscape(b, c) : isNameStart(a) || validEscape(a, b);
const startsNumber = (a: string | undefined, b: string | undefined, c: string | undefined) =>
  a === "+" || a === "-" ? isDigit(b) || (b === "." && isDigit(c)) : a === "." ? isDigit(b) : isDigit(a);

/** The source's tokens. Throws `CssSyntaxError` for anything a browser would recover from. */
export function tokenizeCss(source: string): CssToken[] {
  if (source.includes("\0")) throw new CssSyntaxError("null_byte", "The stylesheet holds a NUL character.", source.indexOf("\0"));
  const input = source.replace(/\r\n?|\f/g, "\n");
  const tokens: CssToken[] = [];
  let i = 0;
  const peek = (offset = 0) => input[i + offset];

  const escapeInString = (): string => {
    // `\` already consumed.
    const c = input[i];
    if (c === undefined) return "�";
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(input[i])) hex += input[i++];
      if (isWhitespace(input[i])) i += 1;
      const code = parseInt(hex, 16);
      return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? "�" : String.fromCodePoint(code);
    }
    i += 1;
    return c;
  };

  const name = (): string => {
    let out = "";
    for (;;) {
      const c = input[i];
      if (isName(c)) { out += c; i += 1; continue; }
      if (validEscape(c, input[i + 1])) throw new CssSyntaxError("escape", "Escapes are allowed only inside quoted strings.", i);
      return out;
    }
  };

  const numeric = (): CssToken => {
    const start = i;
    if (peek() === "+" || peek() === "-") i += 1;
    while (isDigit(peek())) i += 1;
    if (peek() === "." && isDigit(peek(1))) { i += 1; while (isDigit(peek())) i += 1; }
    if ((peek() === "e" || peek() === "E") && (isDigit(peek(1)) || ((peek(1) === "+" || peek(1) === "-") && isDigit(peek(2))))) {
      i += 2;
      while (isDigit(peek())) i += 1;
    }
    const repr = input.slice(start, i);
    const value = Number(repr);
    if (startsIdent(peek(), peek(1), peek(2))) return { type: "dimension", value, repr, unit: name() };
    if (peek() === "%") { i += 1; return { type: "percentage", value, repr }; }
    return { type: "number", value, repr };
  };

  const url = (start: number): CssToken => {
    while (isWhitespace(peek())) i += 1;
    let value = "";
    for (;;) {
      const c = input[i];
      if (c === undefined) throw new CssSyntaxError("bad_url", "A url( is not closed.", start);
      if (c === ")") { i += 1; return { type: "url", value }; }
      if (isWhitespace(c)) {
        while (isWhitespace(peek())) i += 1;
        if (peek() === ")") { i += 1; return { type: "url", value }; }
        throw new CssSyntaxError("bad_url", "A url( holds a space.", start);
      }
      if (c === "\"" || c === "'" || c === "(" || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) throw new CssSyntaxError("bad_url", "A url( holds a character it may not.", start);
      if (c === "\\") throw new CssSyntaxError("escape", "Escapes are allowed only inside quoted strings.", i);
      value += c;
      i += 1;
    }
  };

  while (i < input.length) {
    const start = i;
    const c = input[i]!;
    if (c === "/" && peek(1) === "*") {
      const end = input.indexOf("*/", i + 2);
      if (end < 0) throw new CssSyntaxError("comment", "A comment is not closed.", i);
      i = end + 2;
      continue;
    }
    if (isWhitespace(c)) {
      while (isWhitespace(peek())) i += 1;
      tokens.push({ type: "whitespace" });
      continue;
    }
    if (c === "\"" || c === "'") {
      i += 1;
      let value = "";
      for (;;) {
        const d = input[i];
        if (d === undefined) throw new CssSyntaxError("bad_string", "A string is not closed.", start);
        if (d === c) { i += 1; break; }
        if (d === "\n") throw new CssSyntaxError("bad_string", "A string runs over a line break.", start);
        if (d === "\\") {
          i += 1;
          if (input[i] === undefined) continue;
          if (input[i] === "\n") { i += 1; continue; }
          value += escapeInString();
          continue;
        }
        value += d;
        i += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (c === "#") {
      if (isName(peek(1)) || validEscape(peek(1), peek(2))) {
        i += 1;
        const id = startsIdent(peek(), peek(1), peek(2));
        tokens.push({ type: "hash", value: name(), id });
      } else { i += 1; tokens.push({ type: "delim", value: c }); }
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}") { i += 1; tokens.push({ type: c }); continue; }
    if (c === ",") { i += 1; tokens.push({ type: "comma" }); continue; }
    if (c === ":") { i += 1; tokens.push({ type: "colon" }); continue; }
    if (c === ";") { i += 1; tokens.push({ type: "semicolon" }); continue; }
    if (c === "<" && input.startsWith("<!--", i)) throw new CssSyntaxError("syntax", "<!-- has no place in a stylesheet.", i);
    if (c === "-" && input.startsWith("-->", i)) throw new CssSyntaxError("syntax", "--> has no place in a stylesheet.", i);
    if (startsNumber(c, peek(1), peek(2))) { tokens.push(numeric()); continue; }
    if (c === "@" && startsIdent(peek(1), peek(2), peek(3))) { i += 1; tokens.push({ type: "at-keyword", value: name() }); continue; }
    if (c === "\\") {
      if (validEscape(c, peek(1))) throw new CssSyntaxError("escape", "Escapes are allowed only inside quoted strings.", i);
      throw new CssSyntaxError("syntax", "A stray backslash.", i);
    }
    if (startsIdent(c, peek(1), peek(2))) {
      const value = name();
      if (peek() === "(") {
        i += 1;
        if (value.toLowerCase() === "url") {
          let look = i;
          while (isWhitespace(input[look])) look += 1;
          if (input[look] === "\"" || input[look] === "'") { tokens.push({ type: "function", value }); continue; }
          tokens.push(url(start));
          continue;
        }
        tokens.push({ type: "function", value });
        continue;
      }
      tokens.push({ type: "ident", value });
      continue;
    }
    i += 1;
    tokens.push({ type: "delim", value: c });
  }
  return tokens;
}

const CLOSER = { "{": "}", "[": "]", "(": ")" } as const;

/** Tokens as component values: blocks and functions closed, at most `maxDepth` deep, or a refusal. */
export function componentValues(tokens: readonly CssToken[], maxDepth = 32): CssNode[] {
  let i = 0;
  let depth = 0;
  const consume = (until: ")" | "]" | "}" | null): CssNode[] => {
    if (depth > maxDepth) throw new CssSyntaxError("too_deep", `Blocks and functions nest at most ${maxDepth} deep.`, i);
    depth += 1;
    const out: CssNode[] = [];
    while (i < tokens.length) {
      const token = tokens[i++]!;
      if (token.type === ")" || token.type === "]" || token.type === "}") {
        if (token.type === until) { depth -= 1; return out; }
        throw new CssSyntaxError("unbalanced", `An unmatched ${token.type}.`, i);
      }
      if (token.type === "cdo" || token.type === "cdc") throw new CssSyntaxError("syntax", "<!-- and --> have no place in a stylesheet.", i);
      if (token.type === "{" || token.type === "[" || token.type === "(") {
        out.push({ type: "block", open: token.type, values: consume(CLOSER[token.type]) });
      } else if (token.type === "function") {
        out.push({ type: "fn", name: token.value, values: consume(")") });
      } else {
        out.push(token);
      }
    }
    if (until !== null) throw new CssSyntaxError("unbalanced", `A block is not closed (${until} missing).`, i);
    return out;
  };
  return consume(null);
}

/** A list of rules (the stylesheet's, or an at-rule's block). */
export function parseRules(values: readonly CssNode[]): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  while (i < values.length) {
    const node = values[i]!;
    if (node.type === "whitespace") { i += 1; continue; }
    if (node.type === "at-keyword") {
      i += 1;
      const prelude: CssNode[] = [];
      let block: CssNode[] | null = null;
      while (i < values.length) {
        const next = values[i++]!;
        if (next.type === "semicolon") break;
        if (next.type === "block" && next.open === "{") { block = next.values; break; }
        prelude.push(next);
      }
      rules.push({ kind: "at", name: node.value.toLowerCase(), prelude, block });
      continue;
    }
    const prelude: CssNode[] = [];
    let block: CssNode[] | null = null;
    while (i < values.length) {
      const next = values[i++]!;
      if (next.type === "block" && next.open === "{") { block = next.values; break; }
      if (next.type === "semicolon") throw new CssSyntaxError("syntax", "A rule ends before its { … } block.", i);
      prelude.push(next);
    }
    if (!block) throw new CssSyntaxError("syntax", "A rule needs a { … } block.", i);
    rules.push({ kind: "qualified", prelude, block });
  }
  return rules;
}

/** A block's declarations. A nested rule or an at-rule inside is a refusal. */
export function parseDeclarations(values: readonly CssNode[]): CssDeclaration[] {
  const chunks: CssNode[][] = [[]];
  for (const node of values) {
    if (node.type === "semicolon") chunks.push([]);
    else chunks[chunks.length - 1]!.push(node);
  }
  const out: CssDeclaration[] = [];
  for (const chunk of chunks) {
    const items = trim(chunk);
    if (items.length === 0) continue;
    if (items.some((node) => (node.type === "block" && node.open === "{") || node.type === "at-keyword")) {
      throw new CssSyntaxError("nested_rule", "Nested rules are not allowed: write each rule with its full selector.", 0);
    }
    const [first, ...rest] = items;
    if (first?.type !== "ident") throw new CssSyntaxError("syntax", "A declaration starts with a property name.", 0);
    const afterName = trim(rest);
    if (afterName[0]?.type !== "colon") throw new CssSyntaxError("syntax", `${first.value} needs a colon.`, 0);
    let value = trim(afterName.slice(1));
    let important = false;
    const last = value[value.length - 1];
    if (last?.type === "ident" && last.value.toLowerCase() === "important") {
      const before = trim(value.slice(0, -1));
      const mark = before[before.length - 1];
      if (mark?.type === "delim" && mark.value === "!") { important = true; value = trim(before.slice(0, -1)); }
    }
    out.push({ name: first.value, value, important });
  }
  return out;
}

/** Without leading and trailing whitespace. */
export function trim(nodes: readonly CssNode[]): CssNode[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && nodes[start]!.type === "whitespace") start += 1;
  while (end > start && nodes[end - 1]!.type === "whitespace") end -= 1;
  return nodes.slice(start, end);
}

/** The stylesheet's rules, or a `CssSyntaxError`. */
export function parseStylesheet(source: string): CssRule[] {
  return parseRules(componentValues(tokenizeCss(source)));
}

// ─── Serializing ──────────────────────────────────────────────────────────

/**
 * Characters that can hide or reorder what a reader sees: controls (but tab and
 * line feed), direction marks, overrides and isolates, and invisible ones. The
 * joiners (U+200C, U+200D), variation selectors and tag characters stay:
 * Bangla conjuncts, emoji and subdivision flags need them.
 */
const HIDDEN = /(?![\t\n\u200c\u200d\p{Variation_Selector}\u{E0020}-\u{E007F}])[\p{Cc}\p{Default_Ignorable_Code_Point}]/u;

/** Text without the characters that can hide or reorder it (HIDDEN). */
export function withoutHiddenCharacters(text: string): string {
  return text.replace(new RegExp(HIDDEN.source, "gu"), "");
}

/** A string the serializer can write as it is: no quote, backslash, tab, line break or hidden character. */
export function safeCssString(value: string): boolean {
  return !/["\\\t\n]/.test(value) && !HIDDEN.test(value);
}

type Flat = { kind: string; text: string };

function flatten(nodes: readonly CssNode[], out: Flat[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "block":
        out.push({ kind: node.open, text: node.open });
        flatten(node.values, out);
        out.push({ kind: CLOSER[node.open], text: CLOSER[node.open] });
        break;
      case "fn":
        out.push({ kind: "function", text: `${node.name}(` });
        flatten(node.values, out);
        out.push({ kind: ")", text: ")" });
        break;
      case "whitespace": out.push({ kind: "whitespace", text: " " }); break;
      case "ident": out.push({ kind: "ident", text: node.value }); break;
      case "function": out.push({ kind: "function", text: `${node.value}(` }); break;
      case "at-keyword": out.push({ kind: "at-keyword", text: `@${node.value}` }); break;
      case "hash": out.push({ kind: "hash", text: `#${node.value}` }); break;
      case "string":
        if (!safeCssString(node.value)) throw new CssSyntaxError("bad_string", "A string holds a quote, a backslash or a control character.", 0);
        out.push({ kind: "string", text: `"${node.value}"` });
        break;
      case "url": throw new CssSyntaxError("bad_url", "A url is never written as it was given.", 0);
      case "delim": out.push({ kind: `delim${node.value}`, text: node.value }); break;
      case "number": out.push({ kind: "number", text: node.repr }); break;
      case "percentage": out.push({ kind: "percentage", text: `${node.repr}%` }); break;
      case "dimension":
        // A unit like `e5` would read back as an exponent.
        if (/^e[+-]?\d/i.test(node.unit)) throw new CssSyntaxError("syntax", `The unit ${node.unit} reads as a number.`, 0);
        out.push({ kind: "dimension", text: `${node.repr}${node.unit}` });
        break;
      case "colon": out.push({ kind: "colon", text: ":" }); break;
      case "semicolon": out.push({ kind: "semicolon", text: ";" }); break;
      case "comma": out.push({ kind: "comma", text: "," }); break;
      default: throw new CssSyntaxError("syntax", `A ${node.type} token is never written.`, 0);
    }
  }
}

const IDENTISH = new Set(["ident", "function", "delim-", "number", "percentage", "dimension", "("]);

/** True when writing `a` then `b` with nothing between would read back as other tokens (CSS Syntax 3, §9). */
function joins(a: string, b: string): boolean {
  if (a === "ident" || a === "at-keyword" || a === "hash" || a === "dimension") return IDENTISH.has(b);
  if (a === "delim#" || a === "delim-") return IDENTISH.has(b) && b !== "(";
  if (a === "number") return ["ident", "function", "number", "percentage", "dimension", "delim%"].includes(b);
  if (a === "delim@") return ["ident", "function", "delim-"].includes(b);
  if (a === "delim." || a === "delim+") return ["number", "percentage", "dimension"].includes(b);
  if (a === "delim/") return b === "delim*";
  return false;
}

/** Component values written back as text that tokenizes to exactly them. */
export function serializeCss(nodes: readonly CssNode[]): string {
  const flat: Flat[] = [];
  flatten(nodes, flat);
  let out = "";
  let previous = "";
  for (const item of flat) {
    if (previous && joins(previous, item.kind)) out += "/**/";
    out += item.text;
    previous = item.kind;
  }
  return out;
}
