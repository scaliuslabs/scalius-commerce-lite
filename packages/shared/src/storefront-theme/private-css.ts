// The theme's stylesheet for the buyer's private pages, checked and
// rewritten once when the theme is saved or published (never per request).
//
// What it may do: style the host's parts through their `data-part` hooks,
// its own layout and content hooks (`data-hook`), the store's tokens and its
// own fonts and images. What it may not, because a stylesheet on a page where
// a buyer types an address or a code can leak it:
// - reach any host: no `@import`, and `url()` only for the theme's own files
//   on the store's origin (`/_x/<app>/<release>/public/…`) or a fragment
//   (`#id`); no `image-set()`, `src()`, `attr()`, `element()` or `cross-fade()`;
// - read what a buyer types: no attribute-value selector on a form control
//   (`input`, `select`, `textarea`, `option`, `button`, `output`, `datalist`) or
//   on a value-bearing attribute (`value`, `placeholder`, `aria-valuenow`, …);
// - style outside the private surfaces: every selector is scoped under
//   `[data-private]` (a page root, the drawer, the store's dialogs, the
//   theme's chrome there); a rule for `:root`, `html` or `body` alone sets the
//   page's tokens and paint (`body[data-private-body]`); a selector that starts
//   with a combinator, or puts a sibling combinator right after a surface
//   root, is refused;
// - exceed a size budget, use escapes outside strings, or nest rules.
// Each refusal names its `reason`, so a theme author or an agent can fix it.
// The checked output is what the page carries, inline, on private pages only.

/** The longest stylesheet a theme ships for its private pages (UTF-8 bytes). */
export const PRIVATE_CSS_MAX_BYTES = 24 * 1024;
/** The longest compiled stylesheet (scoping adds a prefix to each selector). */
export const PRIVATE_COMPILED_CSS_MAX_BYTES = 40 * 1024;

export const PRIVATE_CSS_REASONS = [
  "too_large", "syntax", "import", "unsupported_at_rule", "nested_rule",
  "foreign_url", "forbidden_function", "forbidden_property",
  "form_value_selector", "escape", "unscoped_selector",
] as const;
export type PrivateCssReason = (typeof PRIVATE_CSS_REASONS)[number];

export interface PrivateCssIssue {
  reason: PrivateCssReason;
  message: string;
  /** The offset in the source where it starts. */
  at: number;
}

export interface PrivateCssResult {
  /** The scoped stylesheet, with every refused construct left out ("" when there is nothing to keep). */
  css: string;
  issues: PrivateCssIssue[];
}

/** The scope every private surface's root carries. */
export const PRIVATE_CSS_SCOPE = "[data-private]";
/** The page's own tokens and paint (`:root`, `html` or `body` alone). */
export const PRIVATE_CSS_PAGE = "body[data-private-body]";

const BLOCK_AT_RULES = new Set(["media", "supports", "container", "layer"]);
const DECLARATION_AT_RULES = new Set(["font-face"]);
const KEYFRAMES = new Set(["keyframes", "-webkit-keyframes"]);
const FORBIDDEN_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "src", "attr", "element", "-moz-element", "cross-fade", "-webkit-cross-fade", "expression"]);
const FORBIDDEN_PROPERTIES = new Set(["behavior", "-moz-binding"]);
const FORM_CONTROLS = new Set(["input", "select", "textarea", "option", "button", "output", "datalist", "optgroup"]);
const VALUE_ATTRIBUTES = new Set(["value", "placeholder", "aria-valuenow", "aria-valuetext", "data-value", "checked", "selected", "name", "autocomplete"]);
/** The theme's own public files on the store's origin. */
const OWN_ASSET = /^\/_x\/[a-z0-9][a-z0-9.-]{0,98}\/[A-Za-z0-9._-]{1,80}\/public\/[A-Za-z0-9_-][A-Za-z0-9._/-]{0,200}$/;
const FRAGMENT = /^#[A-Za-z][\w-]{0,80}$/;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** The source with comments blanked (same offsets), strings kept. */
function withoutComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const stop = stringEnd(source, index);
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The offset just past the string starting at `start`. */
function stringEnd(source: string, start: number): number {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") index += 2;
    else if (char === quote || char === "\n") return index + 1;
    else index += 1;
  }
  return source.length;
}

/** The offset of the `}` closing the block whose `{` is at `open` (strings and parentheses respected). */
function blockEnd(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"' || char === "'") {
      index = stringEnd(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/** `source[from..to)` split at top-level `separator` (outside strings, parentheses and brackets). */
function splitTop(text: string, separator: string): Array<{ text: string; at: number }> {
  const parts: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"' || char === "'") {
      index = stringEnd(text, index);
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push({ text: text.slice(start, index), at: start });
      start = index + 1;
    }
    index += 1;
  }
  parts.push({ text: text.slice(start), at: start });
  return parts;
}

class Compiler {
  readonly issues: PrivateCssIssue[] = [];

  constructor(private readonly source: string) {}

  issue(reason: PrivateCssReason, message: string, at: number): void {
    if (this.issues.length < 50) this.issues.push({ reason, message, at });
  }

  /** A list of rules between `from` and `to`; `keyframes` keeps selectors (frame offsets) unscoped. */
  rules(from: number, to: number, keyframes = false): string {
    const { source } = this;
    const out: string[] = [];
    let index = from;
    while (index < to) {
      while (index < to && /\s|;/.test(source[index]!)) index += 1;
      if (index >= to) break;
      if (source[index] === "}") {
        this.issue("syntax", "An extra } closes nothing.", index);
        index += 1;
        continue;
      }
      if (source[index] === "@") {
        index = this.atRule(index, to, out);
        continue;
      }
      const open = this.findOpen(index, to);
      if (open < 0) {
        this.issue("syntax", "A rule needs a { … } block.", index);
        break;
      }
      const close = blockEnd(source, open);
      if (close < 0 || close > to) {
        this.issue("syntax", "A block is not closed.", open);
        break;
      }
      const prelude = source.slice(index, open).trim();
      const body = this.declarations(open + 1, close);
      const selectors = keyframes ? this.frameSelectors(prelude, index) : this.selectors(prelude, index);
      if (selectors && body !== null && body !== "") out.push(`${selectors}{${body}}`);
      index = close + 1;
    }
    return out.join("");
  }

  /** The next `{` at this level, or -1 when a `;` or `}` comes first. */
  findOpen(from: number, to: number): number {
    const { source } = this;
    let index = from;
    let depth = 0;
    while (index < to) {
      const char = source[index]!;
      if (char === '"' || char === "'") {
        index = stringEnd(source, index);
        continue;
      }
      if (char === "(" || char === "[") depth += 1;
      else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
      else if (depth === 0 && char === "{") return index;
      else if (depth === 0 && (char === ";" || char === "}")) return -1;
      index += 1;
    }
    return -1;
  }

  atRule(start: number, to: number, out: string[]): number {
    const { source } = this;
    const name = /^@([-a-zA-Z]+)/.exec(source.slice(start, start + 40))?.[1]?.toLowerCase() ?? "";
    const open = this.findOpen(start, to);
    const statementEnd = (() => {
      let index = start;
      while (index < to && source[index] !== ";" && source[index] !== "{") {
        if (source[index] === '"' || source[index] === "'") index = stringEnd(source, index);
        else index += 1;
      }
      return index;
    })();
    if (name === "import") {
      this.issue("import", "@import is not allowed: a private page's stylesheet reaches no other file. Put the rules in this stylesheet.", start);
      return this.skipAt(start, open, to, statementEnd);
    }
    if (open < 0) {
      // `@layer a, b;` declares an order; nothing else is a statement here.
      if (name === "layer") out.push(`${source.slice(start, statementEnd).trim()};`);
      else this.issue("unsupported_at_rule", `@${name} is not allowed here; use @media, @supports, @container, @layer, @font-face or @keyframes.`, start);
      return statementEnd + 1;
    }
    const close = blockEnd(source, open);
    if (close < 0 || close > to) {
      this.issue("syntax", "A block is not closed.", open);
      return to;
    }
    const prelude = source.slice(start, open).trim().replace(/\s+/g, " ");
    if (BLOCK_AT_RULES.has(name)) {
      if (!this.cleanValue(prelude, start)) return close + 1;
      const inner = this.rules(open + 1, close);
      if (inner) out.push(`${prelude}{${inner}}`);
    } else if (DECLARATION_AT_RULES.has(name)) {
      const body = this.declarations(open + 1, close);
      if (body) out.push(`${prelude}{${body}}`);
    } else if (KEYFRAMES.has(name)) {
      if (!/^@[-a-z]+ [A-Za-z_][\w-]{0,60}$/.test(prelude)) {
        this.issue("syntax", "A @keyframes name is one word.", start);
        return close + 1;
      }
      const inner = this.rules(open + 1, close, true);
      if (inner) out.push(`${prelude}{${inner}}`);
    } else {
      this.issue("unsupported_at_rule", `@${name} is not allowed here; use @media, @supports, @container, @layer, @font-face or @keyframes.`, start);
    }
    return close + 1;
  }

  skipAt(start: number, open: number, to: number, statementEnd: number): number {
    if (open < 0 || open > statementEnd) return statementEnd + 1;
    const close = blockEnd(this.source, open);
    return close < 0 ? to : close + 1;
  }

  /** A block's declarations, each value checked; null when the block nests rules. */
  declarations(from: number, to: number): string | null {
    const text = this.source.slice(from, to);
    if (/[{}]/.test(text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ""))) {
      this.issue("nested_rule", "Nested rules are not allowed: write each rule with its full selector.", from);
      return null;
    }
    const kept: string[] = [];
    for (const { text: declaration, at } of splitTop(text, ";")) {
      const trimmed = declaration.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(":");
      if (colon <= 0) {
        this.issue("syntax", `"${trimmed.slice(0, 40)}" is not a declaration.`, from + at);
        continue;
      }
      const property = trimmed.slice(0, colon).trim().toLowerCase();
      const value = trimmed.slice(colon + 1).trim();
      if (!/^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z-]*)$/.test(property) || !value) {
        this.issue("syntax", `"${trimmed.slice(0, 40)}" is not a declaration.`, from + at);
        continue;
      }
      if (FORBIDDEN_PROPERTIES.has(property)) {
        this.issue("forbidden_property", `${property} is not allowed.`, from + at);
        continue;
      }
      if (!this.cleanValue(value, from + at)) continue;
      kept.push(`${property}:${value.replace(/\s+/g, " ")}`);
    }
    return kept.join(";");
  }

  /** True when a value (or an at-rule's prelude) loads nothing from another host. */
  cleanValue(value: string, at: number): boolean {
    // An escape outside a string can spell a function (an escaped `u` then `rl(` is `url(`): none is allowed.
    if (value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "").includes("\\")) {
      this.issue("escape", "Escapes are allowed only inside quoted strings.", at);
      return false;
    }
    let clean = true;
    for (const call of value.matchAll(/([-a-zA-Z0-9_]*)\(/g)) {
      const name = call[1]!.toLowerCase();
      if (FORBIDDEN_FUNCTIONS.has(name)) {
        this.issue("forbidden_function", `${name}() is not allowed; use url() for the theme's own files.`, at);
        clean = false;
      } else if (name === "url") {
        const open = (call.index ?? 0) + call[0].length;
        const close = value.indexOf(")", open);
        const raw = (close < 0 ? value.slice(open) : value.slice(open, close)).trim();
        const url = /^(["'])(.*)\1$/s.exec(raw)?.[2] ?? raw;
        if (url.includes("\\") || !(OWN_ASSET.test(url) && !url.split("/").includes("..")) && !FRAGMENT.test(url)) {
          this.issue("foreign_url", `url(${url.slice(0, 60)}) reaches another file than the theme's own: use a file from your app's public/ folder (/_x/<app>/<release>/public/…).`, at);
          clean = false;
        }
      }
    }
    return clean;
  }

  frameSelectors(prelude: string, at: number): string | null {
    const frames = splitTop(prelude, ",").map((part) => part.text.trim().toLowerCase());
    if (frames.every((frame) => frame === "from" || frame === "to" || /^\d{1,3}(?:\.\d+)?%$/.test(frame))) return frames.join(",");
    this.issue("syntax", "A keyframe is from, to or a percentage.", at);
    return null;
  }

  /** The selector list scoped to the private surfaces; null when none survives. */
  selectors(prelude: string, at: number): string | null {
    if (!prelude) {
      this.issue("syntax", "A rule needs a selector.", at);
      return null;
    }
    const kept: string[] = [];
    for (const { text, at: offset } of splitTop(prelude, ",")) {
      const scoped = this.selector(text.trim().replace(/\s+/g, " "), at + offset);
      if (scoped) kept.push(scoped);
    }
    return kept.length > 0 ? kept.join(",") : null;
  }

  selector(selector: string, at: number): string | null {
    if (!selector) {
      this.issue("syntax", "An empty selector.", at);
      return null;
    }
    if (selector.includes("\\")) {
      this.issue("escape", "Selectors may not use escapes.", at);
      return null;
    }
    if (/^[>+~]/.test(selector)) {
      this.issue("unscoped_selector", "A selector may not start with a combinator.", at);
      return null;
    }
    for (const attribute of selector.matchAll(/\[\s*([-\w|*]+)\s*([~|^$*]?=)?/g)) {
      if (!attribute[2]) continue;
      const name = attribute[1]!.toLowerCase().replace(/^.*\|/, "");
      const compound = compoundAround(selector, attribute.index ?? 0);
      const type = /^([a-z][a-z0-9-]*)/i.exec(compound)?.[1]?.toLowerCase();
      if (VALUE_ATTRIBUTES.has(name) || (type && FORM_CONTROLS.has(type))) {
        this.issue("form_value_selector", `${selector.slice(0, 60)} matches a form control or a value by an attribute's value, which can reveal what a buyer types. Style form controls through their part's hook ([data-part="contact"] input).`, at);
        return null;
      }
    }
    const first = /^[^\s>+~]+/.exec(selector)?.[0] ?? "";
    const rest = selector.slice(first.length);
    // The page root, alone or in a state (`:root[data-color-scheme="dark"]`): the page's own rule, or the surfaces under it.
    const root = /^(?::root|html|body)((?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*)$/i.exec(first);
    if (root) {
      const state = root[1] ? `:root${root[1]} ` : "";
      if (/^\s*[+~]/.test(rest)) {
        this.issue("unscoped_selector", "A sibling of the page root is outside the private pages.", at);
        return null;
      }
      return rest.trim() ? `${state}${PRIVATE_CSS_SCOPE} ${rest.trim().replace(/^>\s*/, "")}` : `${state}${PRIVATE_CSS_PAGE}`;
    }
    if (/^\[data-private(?:=(?:"[a-z-]+"|'[a-z-]+'|[a-z-]+))?\]/.test(first)) {
      if (/^\s*[+~]/.test(rest)) {
        this.issue("unscoped_selector", "A sibling of a private surface is outside it.", at);
        return null;
      }
      return selector;
    }
    return `${PRIVATE_CSS_SCOPE} ${selector}`;
  }
}

/** The compound selector (between combinators, commas and parentheses) around `index`. */
function compoundAround(selector: string, index: number): string {
  const boundary = /[\s>+~,()]/;
  let start = index;
  let depth = 0;
  while (start > 0) {
    const char = selector[start - 1]!;
    if (char === "]") depth += 1;
    else if (char === "[") depth = Math.max(0, depth - 1);
    else if (depth === 0 && boundary.test(char)) break;
    start -= 1;
  }
  let end = index;
  depth = 0;
  while (end < selector.length) {
    const char = selector[end]!;
    if (char === "[") depth += 1;
    else if (char === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && boundary.test(char)) break;
    end += 1;
  }
  return selector.slice(start, end);
}

/**
 * The theme's private stylesheet checked and scoped. Any issue means the
 * save is refused (`privateCssIssues`); the output already leaves each
 * refused construct out.
 */
export function compilePrivateCss(source: string): PrivateCssResult {
  if (byteLength(source) > PRIVATE_CSS_MAX_BYTES) {
    return { css: "", issues: [{ reason: "too_large", message: `The private pages' stylesheet is at most ${PRIVATE_CSS_MAX_BYTES / 1024} KiB.`, at: 0 }] };
  }
  const compiler = new Compiler(withoutComments(source));
  const css = compiler.rules(0, source.length);
  if (byteLength(css) > PRIVATE_COMPILED_CSS_MAX_BYTES) {
    return { css: "", issues: [...compiler.issues, { reason: "too_large", message: `The scoped stylesheet is over ${PRIVATE_COMPILED_CSS_MAX_BYTES / 1024} KiB; shorten it.`, at: 0 }] };
  }
  // `</style` can never appear: the page writes this inside a <style> element.
  return { css: css.replace(/<\/(style)/gi, "<\\/$1"), issues: compiler.issues };
}
