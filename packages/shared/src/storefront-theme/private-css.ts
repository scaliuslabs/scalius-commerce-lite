// The theme's stylesheet for the buyer's private pages, checked and compiled
// once when the theme is saved or published (never on a buyer's request).
//
// It reaches only free regions (private-anatomy.ts `PRIVATE_FREE_REGIONS`):
// every selector starts at one region's wrapper (`[data-free]`, a region
// kind or a content block's `[data-hook]`) and selects strictly inside it,
// never the wrapper, so no rule can match a host part, a layout node, the
// page, the body, the host's search or an app's block (none is ever inside
// a region).
// The host seals each wrapper (nothing inside paints, lays out or acts
// outside it), and gives host parts their look through typed tokens
// (private-tokens.ts), never through this stylesheet.
//
// It is parsed by a CSS Syntax 3 tokenizer and parser (private-css-syntax.ts)
// and only what the parser understands and the allow-lists below accept is
// kept. The output is written from the checked tokens, never from the
// source text, then parsed again and compared with what was approved, and
// scanned for any loading function or escape: anything that disagrees
// fails closed (no stylesheet). The compiler never throws: limits on size,
// tokens and nesting are refusals, and the work is linear in the input.
//
// What a stylesheet may do inside a region: style rules, `@media`,
// `@supports`, `@container` and `@keyframes` (named `t-<name>`; an
// animation names only the theme's own); type, class, id, attribute and
// the allowed pseudo-class and pseudo-element selectors (a class `.x` and an
// id `#x` are the region's own, written `.tc-x` and `#tc-x`, as its markup
// is, so they never meet a host or utility class); values of words,
// numbers, colours, strings and the allowed functions; `url(<asset>)` for
// one of the theme's listed assets; its own custom properties `--t-*`.
// What it may not, each with its `reason`: reach any file or host
// (`import`, `foreign_url`, `forbidden_function`); read what a buyer types
// (`form_value_selector`, `state_selector`); select outside a region or its
// wrapper (`unscoped_selector`); leave a sealed box (`positioning`: fixed or
// sticky position, anchor positioning); run the store's animations
// (`animation_name`); use escapes, nesting, other at-rules, more than 24 KiB,
// 12000 tokens or 24 levels of nesting.

import { CHROME_NAME_PREFIX } from "../plugins/inert-html";
import {
  CssSyntaxError,
  parseDeclarations,
  parseRules,
  componentValues,
  safeCssString,
  serializeCss,
  tokenizeCss,
  trim,
  type CssNode,
  type CssRule,
} from "./private-css-syntax";

/** The longest stylesheet a theme ships for its private pages (UTF-8 bytes). */
export const PRIVATE_CSS_MAX_BYTES = 24 * 1024;
/** The longest compiled stylesheet. */
export const PRIVATE_COMPILED_CSS_MAX_BYTES = 64 * 1024;
/**
 * The checker's version. A stylesheet compiled by an older one is never
 * served: the page compiles it again or draws without it.
 */
export const PRIVATE_CSS_SANITIZER_VERSION = 4 as const;

export const PRIVATE_CSS_REASONS = [
  "too_large", "syntax", "null_byte", "bad_string", "bad_url", "comment", "unbalanced", "escape", "nested_rule",
  "too_deep", "import", "unsupported_at_rule", "foreign_url", "forbidden_function", "custom_property",
  "form_value_selector", "state_selector", "unsupported_selector", "unscoped_selector",
  "positioning", "animation_name", "unsafe_output",
] as const;
export type PrivateCssReason = (typeof PRIVATE_CSS_REASONS)[number];

export interface PrivateCssIssue {
  reason: PrivateCssReason;
  message: string;
}

export interface PrivateCssResult {
  /** The compiled stylesheet ("" when the source has any issue, or nothing to keep). */
  css: string;
  issues: PrivateCssIssue[];
}

/** What a stylesheet is checked against: the theme's assets. */
export interface PrivateCssContext {
  /** The theme's listed assets (`privatePages.assets`), by key. */
  assets: ReadonlySet<string>;
}

const EMPTY_CONTEXT: PrivateCssContext = { assets: new Set() };

/** Every rule's scope: the body of a private page that carries a theme stylesheet. */
export const PRIVATE_CSS_PAGE = "body[data-private-body]";
/** A region's own class and id names, in its markup (plugins/inert-html.ts) and in the stylesheet. */
export const PRIVATE_CHROME_NAME_PREFIX = CHROME_NAME_PREFIX;
/** The most tokens and the deepest nesting a stylesheet may have. */
export const PRIVATE_CSS_MAX_TOKENS = 12_000;
export const PRIVATE_CSS_MAX_DEPTH = 24;
/** An asset's custom property, which the page defines from the store's own origin. */
export const privateAssetProperty = (key: string) => `--private-asset-${key}`;
export const PRIVATE_ASSET_KEY = /^[a-z][a-z0-9-]{0,31}$/;

class Refusal extends Error {
  constructor(readonly reason: PrivateCssReason, message: string) {
    super(message);
  }
}
const refuse = (reason: PrivateCssReason, message: string): never => { throw new Refusal(reason, message); };

// ─── Values ───────────────────────────────────────────────────────────────

/** The functions a value may call (besides `url`, which names an asset). */
const FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark",
  "calc", "min", "max", "clamp", "round", "mod", "rem", "abs", "sign", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "pow", "sqrt", "hypot", "log", "exp",
  "var", "env",
  "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
  "cubic-bezier", "steps", "linear",
  "minmax", "repeat", "fit-content",
  "blur", "brightness", "contrast", "drop-shadow", "grayscale", "hue-rotate", "invert", "opacity", "saturate", "sepia",
  "inset", "circle", "ellipse", "polygon",
  "counter", "counters",
  // Transforms: a region is sealed, so they move nothing out of it.
  "translate", "translatex", "translatey", "translatez", "translate3d", "scale", "scalex", "scaley", "scalez", "scale3d",
  "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "matrix", "matrix3d", "perspective",
]);
const VALUE_DELIMS = new Set(["/", "+", "-", "*", ","]);
const IDENT = /^-?(?:[A-Za-z_\u0080-￿]|-)[A-Za-z0-9_\u0080-￿-]*$/;

interface ValueContext {
  assets: ReadonlySet<string>;
  keyframes: ReadonlySet<string>;
  /** `animation` and `animation-name` name keyframes: those idents take the `t-` prefix. */
  namesKeyframes: boolean;
}

/** A value checked, its assets written as their custom properties and its keyframe names prefixed. */
function checkValue(nodes: readonly CssNode[], context: ValueContext): CssNode[] {
  return nodes.map((node): CssNode => {
    switch (node.type) {
      case "whitespace": case "number": case "percentage": case "comma":
        return node;
      case "dimension":
        return node;
      case "ident":
        if (!IDENT.test(node.value)) refuse("syntax", `${node.value} is not a word CSS reads.`);
        return context.namesKeyframes && context.keyframes.has(node.value) ? { type: "ident", value: `t-${node.value}` } : node;
      case "hash":
        if (!/^[A-Za-z0-9_-]+$/.test(node.value)) refuse("syntax", `#${node.value} is not a colour.`);
        return node;
      case "string":
        if (!safeCssString(node.value)) refuse("bad_string", "A string may not hold a quote, a backslash, a line break or a direction mark.");
        return node;
      case "delim":
        if (!VALUE_DELIMS.has(node.value)) refuse("syntax", `${node.value} has no place in a value.`);
        return node;
      case "url":
        return assetReference(node.value, context);
      case "block":
        if (node.open === "{") refuse("nested_rule", "A { … } block has no place in a value.");
        if (node.open === "[") {
          if (!node.values.every((item) => item.type === "ident" || item.type === "whitespace")) refuse("syntax", "[ … ] holds grid line names only.");
          return node;
        }
        return { ...node, values: checkValue(node.values, context) };
      case "fn": {
        const name = node.name.toLowerCase();
        if (name === "url") {
          const args = trim(node.values);
          return assetReference(args.length === 1 && args[0]!.type === "string" ? args[0].value : "\u0000", context);
        }
        if (!FUNCTIONS.has(name)) {
          return refuse("forbidden_function", `${name}() is not allowed. A value may use colour, maths, gradient, var(), env() and the other listed functions; a file is url(<asset>).`);
        }
        if (name === "var") {
          const [first, ...rest] = trim(node.values);
          if (first?.type !== "ident" || !first.value.startsWith("--")) refuse("syntax", "var() names a custom property.");
          return { ...node, values: [first!, ...checkValue(rest, context)] };
        }
        if (name === "env" && !trim(node.values).every((item) => item.type === "ident" || item.type === "comma" || item.type === "whitespace" || item.type === "dimension" || item.type === "number")) {
          refuse("syntax", "env() names an environment value.");
        }
        return { ...node, name, values: checkValue(node.values, context) };
      }
      default:
        return refuse("syntax", `A ${node.type} has no place in a value.`);
    }
  });
}

function assetReference(key: string, context: ValueContext): CssNode {
  if (!PRIVATE_ASSET_KEY.test(key) || !context.assets.has(key)) {
    refuse("foreign_url", `url(${key.slice(0, 40)}) is not one of the theme's listed assets. List the file under privatePages.assets and write url(<its key>).`);
  }
  return { type: "fn", name: "var", values: [{ type: "ident", value: privateAssetProperty(key) }] };
}

// ─── Properties ───────────────────────────────────────────────────────────

/** Properties no rule may set: each places a box against something outside its region, or takes the page's scrolling. */
const ANCHORING = new Set(["touch-action", "overscroll-behavior", "overscroll-behavior-x", "overscroll-behavior-y", "overscroll-behavior-block", "overscroll-behavior-inline", "anchor-name", "anchor-scope", "position-anchor", "position-area", "position-try", "position-try-fallbacks", "position-try-order", "position-visibility", "view-transition-name", "view-transition-class", "overlay"]);
/** Never: script-era or non-standard properties. */
const FORBIDDEN = new Set(["behavior", "-moz-binding", "zoom"]);
/** Words `animation` may hold besides the theme's own keyframes. */
const ANIMATION_WORDS = new Set([
  "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse", "forwards", "backwards", "both", "running", "paused",
  "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end", "jump-start", "jump-end", "jump-none", "jump-both", "start", "end",
  "auto", "replace", "add", "accumulate",
]);

const words = (value: readonly CssNode[]) => value.filter((node) => node.type !== "whitespace");

function checkDeclarationName(name: string): void {
  if (name.startsWith("--")) {
    if (!/^--t-[a-z0-9-]{1,40}$/.test(name)) refuse("custom_property", `${name}: the theme's own custom properties are named --t-<name>.`);
    return;
  }
  if (!/^[a-z][a-z-]*$/.test(name) || FORBIDDEN.has(name)) refuse("syntax", `${name} is not a property this stylesheet may set.`);
  if (ANCHORING.has(name)) refuse("positioning", `${name} places a box against something outside its region.`);
}

/** `position` is a fixed word, never fixed or sticky: a box stays in its sealed region. */
function checkPosition(value: readonly CssNode[]): void {
  const items = words(value);
  const [only] = items;
  if (items.length !== 1 || only?.type !== "ident" || !["static", "relative", "absolute"].includes(only.value.toLowerCase())) {
    refuse("positioning", "position is static, relative or absolute (as a plain word): nothing here is fixed to the screen or sticks outside its region.");
  }
}

/** An animation names the theme's own keyframes only (already prefixed), with fixed words around them. */
function checkAnimation(name: string, value: readonly CssNode[], keyframes: ReadonlySet<string>): void {
  for (const node of words(value)) {
    if (node.type === "comma" || node.type === "number" || node.type === "dimension" || node.type === "percentage") continue;
    if (node.type === "ident" && (keyframes.has(node.value) || (name === "animation" && ANIMATION_WORDS.has(node.value.toLowerCase())) || node.value.toLowerCase() === "none")) continue;
    if (name === "animation" && node.type === "fn" && ["cubic-bezier", "steps", "linear"].includes(node.name)) continue;
    refuse("animation_name", `${name} names only this stylesheet's own @keyframes (and fixed words): ${node.type === "ident" ? node.value : node.type} is not one.`);
  }
}

// ─── Selectors ────────────────────────────────────────────────────────────

type Simple =
  | { kind: "type"; name: string }
  | { kind: "id"; name: string }
  | { kind: "class"; name: string }
  | { kind: "attr"; name: string; op: string | null; value: string | null; flag: string | null }
  | { kind: "pseudo"; name: string; selectors: Complex[] | null; raw: CssNode[] | null }
  | { kind: "element"; name: string };
type Compound = Simple[];
interface Complex {
  /** A relative selector's leading combinator (inside `:has()`). */
  lead: string | null;
  compounds: Compound[];
  /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`: " ", ">", "+" or "~". */
  combinators: string[];
}

const PSEUDO_CLASSES = new Set([
  "hover", "focus", "focus-visible", "focus-within", "active", "visited", "link", "any-link", "target", "defined", "open", "popover-open",
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "empty", "root",
  "checked", "disabled", "enabled", "required", "optional", "read-only", "read-write", "default",
]);
/** Pseudo-classes that reflect what a buyer typed. */
const VALUE_STATES = new Set(["placeholder-shown", "valid", "invalid", "user-valid", "user-invalid", "in-range", "out-of-range", "blank", "autofill", "-webkit-autofill"]);
/** Allowed alone, but inside `:has()` they would let another element show a control's state. */
const STATES_OUTSIDE_HAS = new Set(["checked", "indeterminate"]);
const SELECTOR_FUNCTIONS = new Set(["is", "where", "not", "has"]);
const RAW_FUNCTIONS = new Set(["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "dir", "lang"]);
const PSEUDO_ELEMENTS = new Set(["before", "after", "marker", "first-line", "first-letter", "selection"]);
const FORM_CONTROLS = new Set(["input", "select", "textarea", "option", "button", "output", "datalist", "optgroup"]);
const VALUE_ATTRIBUTES = new Set(["value", "placeholder", "aria-valuenow", "aria-valuetext", "data-value", "checked", "selected", "name", "autocomplete"]);

function splitTop(nodes: readonly CssNode[]): CssNode[][] {
  const parts: CssNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === "comma") parts.push([]);
    else parts[parts.length - 1]!.push(node);
  }
  return parts;
}

function parseSelectorList(nodes: readonly CssNode[], relative: boolean, inHas: boolean): Complex[] {
  return splitTop(nodes).map((part) => parseComplex(trim(part), relative, inHas));
}

const isCombinator = (node: CssNode | undefined): boolean =>
  node?.type === "delim" && (node.value === ">" || node.value === "+" || node.value === "~");

function parseComplex(nodes: readonly CssNode[], relative: boolean, inHas: boolean): Complex {
  if (nodes.length === 0) refuse("syntax", "An empty selector.");
  let i = 0;
  let lead: string | null = null;
  if (isCombinator(nodes[0])) {
    if (!relative) refuse("unscoped_selector", "A selector may not start with a combinator.");
    lead = (nodes[0] as { value: string }).value;
    i = 1;
    while (nodes[i]?.type === "whitespace") i += 1;
  }
  const compounds: Compound[] = [];
  const combinators: string[] = [];
  for (;;) {
    const [compound, next] = parseCompound(nodes, i, inHas);
    compounds.push(compound);
    i = next;
    let sawSpace = false;
    while (nodes[i]?.type === "whitespace") { sawSpace = true; i += 1; }
    if (i >= nodes.length) break;
    if (isCombinator(nodes[i])) {
      combinators.push((nodes[i] as { value: string }).value);
      i += 1;
      while (nodes[i]?.type === "whitespace") i += 1;
      if (i >= nodes.length) refuse("syntax", "A selector ends with a combinator.");
    } else if (sawSpace) {
      combinators.push(" ");
    } else {
      refuse("syntax", "A selector this stylesheet cannot read.");
    }
  }
  return { lead, compounds, combinators };
}

function parseCompound(nodes: readonly CssNode[], start: number, inHas: boolean): [Compound, number] {
  const out: Compound = [];
  let i = start;
  for (;;) {
    const node = nodes[i];
    if (!node || node.type === "whitespace" || isCombinator(node)) break;
    if (node.type === "ident" && out.length === 0) {
      out.push({ kind: "type", name: node.value.toLowerCase() });
      i += 1;
    } else if (node.type === "delim" && node.value === "*" && out.length === 0) {
      out.push({ kind: "type", name: "*" });
      i += 1;
    } else if (node.type === "hash" && node.id) {
      out.push({ kind: "id", name: node.value });
      i += 1;
    } else if (node.type === "delim" && node.value === "." && nodes[i + 1]?.type === "ident") {
      out.push({ kind: "class", name: (nodes[i + 1] as { value: string }).value });
      i += 2;
    } else if (node.type === "block" && node.open === "[") {
      out.push(parseAttribute(node.values));
      i += 1;
    } else if (node.type === "colon") {
      const next = nodes[i + 1];
      if (next?.type === "colon") {
        const element = nodes[i + 2];
        if (element?.type !== "ident" || !PSEUDO_ELEMENTS.has(element.value.toLowerCase())) refuse("unsupported_selector", `::${element?.type === "ident" ? element.value : "?"} is not allowed; use ::before, ::after, ::marker, ::first-line, ::first-letter or ::selection.`);
        out.push({ kind: "element", name: (element as { value: string }).value.toLowerCase() });
        i += 3;
      } else if (next?.type === "ident") {
        const name = next.value.toLowerCase();
        if (VALUE_STATES.has(name)) refuse("state_selector", `:${name} reflects what a buyer types, which a stylesheet here may not read.`);
        if (inHas && STATES_OUTSIDE_HAS.has(name)) refuse("state_selector", `:${name} inside :has() would show a control's state elsewhere.`);
        if (!PSEUDO_CLASSES.has(name)) refuse("unsupported_selector", `:${name} is not an allowed pseudo-class.`);
        out.push({ kind: "pseudo", name, selectors: null, raw: null });
        i += 2;
      } else if (next?.type === "fn") {
        const name = next.name.toLowerCase();
        if (SELECTOR_FUNCTIONS.has(name)) {
          out.push({ kind: "pseudo", name, selectors: parseSelectorList(next.values, name === "has", inHas || name === "has"), raw: null });
        } else if (RAW_FUNCTIONS.has(name)) {
          const raw = trim(next.values);
          const ok = raw.every((item) => item.type === "whitespace" || item.type === "number" || item.type === "string"
            || (item.type === "ident" && /^-?[a-z][a-z0-9-]*$/i.test(item.value) && item.value.toLowerCase() !== "of")
            || (item.type === "dimension" && /^n(?:-\d*)?$/i.test(item.unit)) || (item.type === "delim" && (item.value === "+" || item.value === "-")));
          if (!ok) refuse("unsupported_selector", `:${name}() takes An+B, a direction or a language only.`);
          out.push({ kind: "pseudo", name, selectors: null, raw });
        } else {
          refuse("unsupported_selector", `:${name}() is not an allowed pseudo-class.`);
        }
        i += 2;
      } else {
        refuse("syntax", "A colon without a pseudo-class.");
      }
    } else if (node.type === "delim" && (node.value === "&" || node.value === "|")) {
      refuse("unsupported_selector", node.value === "&" ? "Nesting (&) is not allowed: write each rule with its full selector." : "Namespaces are not allowed.");
    } else {
      refuse("syntax", "A selector this stylesheet cannot read.");
    }
  }
  if (out.length === 0) refuse("syntax", "An empty compound selector.");
  const type = out[0]!.kind === "type" ? (out[0] as { name: string }).name : null;
  for (const simple of out) {
    if (simple.kind !== "attr" || simple.op === null) continue;
    if (VALUE_ATTRIBUTES.has(simple.name) || (type && FORM_CONTROLS.has(type))) {
      refuse("form_value_selector", `[${simple.name}${simple.op}…] can reveal what a buyer types. Style form controls through their part: [data-part="contact"] input.`);
    }
  }
  return [out, i];
}

function parseAttribute(values: readonly CssNode[]): Simple {
  const items = trim(values).filter((node) => node.type !== "whitespace");
  const [name, ...rest] = items;
  if (name?.type !== "ident") refuse("syntax", "An attribute selector names an attribute.");
  if (rest[0]?.type === "delim" && rest[0].value === "|") refuse("unsupported_selector", "Namespaces are not allowed.");
  if (rest.length === 0) return { kind: "attr", name: (name as { value: string }).value.toLowerCase(), op: null, value: null, flag: null };
  let op = "";
  let j = 0;
  if (rest[0]?.type === "delim" && "~|^$*".includes(rest[0].value) && rest[1]?.type === "delim" && rest[1].value === "=") { op = `${rest[0].value}=`; j = 2; }
  else if (rest[0]?.type === "delim" && rest[0].value === "=") { op = "="; j = 1; }
  else refuse("syntax", "An attribute selector this stylesheet cannot read.");
  const value = rest[j];
  if (value?.type !== "ident" && value?.type !== "string") refuse("syntax", "An attribute selector's value is a word or a string.");
  const text = (value as { value: string }).value;
  if (!safeCssString(text)) refuse("bad_string", "An attribute value may not hold a quote, a backslash or a control character.");
  const flag = rest[j + 1];
  if (rest.length > j + 2 || (flag && (flag.type !== "ident" || !["i", "s"].includes(flag.value.toLowerCase())))) refuse("syntax", "An attribute selector this stylesheet cannot read.");
  return { kind: "attr", name: (name as { value: string }).value.toLowerCase(), op, value: text, flag: flag ? (flag as { value: string }).value.toLowerCase() : null };
}

function writeSimple(simple: Simple): string {
  const name = (value: string) => {
    if (!IDENT.test(value)) refuse("syntax", `${value} is not a name CSS reads.`);
    return value;
  };
  switch (simple.kind) {
    case "type": return simple.name === "*" ? "*" : name(simple.name);
    case "id": return `#${name(simple.name)}`;
    case "class": return `.${name(simple.name)}`;
    case "attr": return simple.op === null ? `[${name(simple.name)}]` : `[${name(simple.name)}${simple.op}"${simple.value}"${simple.flag ? ` ${simple.flag}` : ""}]`;
    case "element": return `::${simple.name}`;
    case "pseudo":
      if (simple.selectors) return `:${simple.name}(${simple.selectors.map(writeComplex).join(",")})`;
      if (simple.raw) return `:${simple.name}(${serializeCss(simple.raw)})`;
      return `:${simple.name}`;
  }
}

function writeComplex(complex: Complex): string {
  let out = complex.lead ? `${complex.lead} ` : "";
  complex.compounds.forEach((compound, index) => {
    if (index > 0) out += complex.combinators[index - 1] === " " ? " " : ` ${complex.combinators[index - 1]} `;
    out += compound.map(writeSimple).join("");
  });
  return out;
}

/** A region's wrapper as a selector names it: `[data-free]`, a region kind, a content block's hook or an app's block. */
function anchorOf(compound: Compound): string | null {
  if (compound.length !== 1 || compound[0]!.kind !== "attr") return null;
  const attr = compound[0] as Extract<Simple, { kind: "attr" }>;
  if (attr.flag) return null;
  if (attr.name === "data-free") {
    if (attr.op === null) return "[data-free]";
    return attr.op === "=" && ["block", "header", "footer"].includes(attr.value!) ? `[data-free="${attr.value}"]` : null;
  }
  if (attr.op !== "=") return null;
  if (attr.name === "data-hook" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,5}$/.test(attr.value!) && attr.value!.length <= 40) return `[data-free="block"][data-hook="${attr.value}"]`;
  return null;
}

const NAMED = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** Class and id names as the region's markup writes them (`tc-<name>`), everywhere in a selector. */
function ownNames(complex: Complex): Complex {
  const simple = (item: Simple): Simple => {
    if (item.kind === "class" || item.kind === "id") {
      if (!NAMED.test(item.name)) refuse("unsupported_selector", `${item.kind === "class" ? "." : "#"}${item.name}: a name of letters, digits, _ and - only.`);
      return { ...item, name: `${PRIVATE_CHROME_NAME_PREFIX}${item.name}` };
    }
    if (item.kind === "attr" && ["class", "id", "style", "for", "name", "data-free", "data-private", "data-hook", "data-buyer-ui-app", "data-host"].includes(item.name)) {
      refuse("unsupported_selector", `[${item.name}…]: select by .class, #id, a tag or a data-ui kind inside a region.`);
    }
    if (item.kind === "pseudo" && item.selectors) return { ...item, selectors: item.selectors.map(ownNames) };
    return item;
  };
  return { ...complex, compounds: complex.compounds.map((compound) => compound.map(simple)) };
}

/**
 * A selector scoped to the inside of one free region: an optional root
 * state, the region's wrapper, then a descendant or child combinator and
 * what it selects inside. Its subject is always strictly inside the wrapper.
 */
function scopeSelector(complex: Complex): string {
  let compounds = complex.compounds;
  let combinators = complex.combinators;
  let state = "";
  const first = compounds[0]!;
  if (first.some((simple) => (simple.kind === "type" && (simple.name === "html" || simple.name === "body")) || (simple.kind === "pseudo" && simple.name === "root"))) {
    if (!first.every((simple) => simple.kind === "attr" || (simple.kind === "pseudo" && !simple.selectors) || (simple.kind === "type" && (simple.name === "html" || simple.name === "body")))) {
      refuse("unscoped_selector", "The page root takes only a state (an attribute or a pseudo-class) before the region.");
    }
    if (combinators[0] !== " ") refuse("unscoped_selector", "A root state is followed by a space and a region.");
    state = first.filter((simple) => simple.kind !== "type" && !(simple.kind === "pseudo" && simple.name === "root")).map(writeSimple).join("");
    compounds = compounds.slice(1);
    combinators = combinators.slice(1);
  }
  const anchor = compounds[0] ? anchorOf(compounds[0]) : null;
  if (!anchor) {
    refuse("unscoped_selector", "Start every selector at a free region and select inside it: [data-hook=\"<your block>\"] p, [data-free=\"header\"] .logo. Host parts and apps' blocks take tokens (privatePages.tokens), not selectors.");
  }
  if (compounds.length < 2) refuse("unscoped_selector", "A region's wrapper is the host's: select something inside it.");
  if (combinators[0] !== " " && combinators[0] !== ">") refuse("unscoped_selector", "Inside a region means a descendant ( ) or a child (>) of its wrapper.");
  const inside = ownNames({ lead: null, compounds: compounds.slice(1), combinators: combinators.slice(1) });
  return `${state ? `:root${state} ` : ""}${PRIVATE_CSS_PAGE} ${anchor}${combinators[0] === ">" ? ">" : " "}${writeComplex(inside)}`;
}

// ─── Rules ────────────────────────────────────────────────────────────────

/** An approved rule, as it is written and as a second parse must read it back. */
type Approved =
  | { kind: "style"; selector: string; declarations: Array<[string, string, boolean]> }
  | { kind: "group"; prelude: string; rules: Approved[] };

const GROUPING = new Set(["media", "supports", "container"]);

function checkPrelude(nodes: readonly CssNode[]): void {
  for (const node of nodes) {
    if (node.type === "block") {
      if (node.open !== "(") refuse("syntax", "A condition holds ( … ) groups only.");
      checkPrelude(node.values);
      continue;
    }
    if (node.type === "whitespace" || node.type === "ident" || node.type === "number" || node.type === "dimension" || node.type === "percentage" || node.type === "colon" || node.type === "comma") continue;
    if (node.type === "delim" && ["<", ">", "=", "/"].includes(node.value)) continue;
    refuse("syntax", "A condition holds words, numbers and comparisons only.");
  }
}

class Compiler {
  readonly issues: PrivateCssIssue[] = [];
  readonly keyframes = new Set<string>();

  constructor(private readonly context: PrivateCssContext) {}

  issue(error: unknown): void {
    if (this.issues.length >= 50) return;
    if (error instanceof Refusal || error instanceof CssSyntaxError) this.issues.push({ reason: error.reason, message: error.message });
    else throw error;
  }

  collectKeyframes(rules: readonly CssRule[]): void {
    for (const rule of rules) {
      if (rule.kind !== "at") continue;
      if (rule.name === "keyframes") {
        const [name, ...rest] = trim(rule.prelude);
        if (name?.type === "ident" && rest.length === 0 && IDENT.test(name.value)) this.keyframes.add(name.value);
      } else if (GROUPING.has(rule.name) && rule.block) {
        this.collectKeyframes(parseRules(rule.block));
      }
    }
  }

  rules(rules: readonly CssRule[], inKeyframes = false): Approved[] {
    const out: Approved[] = [];
    for (const rule of rules) {
      try {
        const approved = rule.kind === "at" ? this.atRule(rule) : this.styleRule(rule, inKeyframes);
        if (approved) out.push(approved);
      } catch (error) {
        this.issue(error);
      }
    }
    return out;
  }

  atRule(rule: Extract<CssRule, { kind: "at" }>): Approved | null {
    if (rule.name === "import") refuse("import", "@import is not allowed: this stylesheet reaches no other file. Put the rules here.");
    if (rule.name === "keyframes") {
      const [name, ...rest] = trim(rule.prelude);
      if (name?.type !== "ident" || rest.length > 0 || !IDENT.test(name.value) || !rule.block) refuse("syntax", "@keyframes takes one name and a block.");
      const frames = this.rules(parseRules(rule.block!), true);
      return frames.length > 0 ? { kind: "group", prelude: `@keyframes t-${(name as { value: string }).value}`, rules: frames } : null;
    }
    if (!GROUPING.has(rule.name)) refuse("unsupported_at_rule", `@${rule.name} is not allowed here; use @media, @supports, @container or @keyframes.`);
    if (!rule.block) refuse("syntax", `@${rule.name} needs a block.`);
    const prelude = trim(rule.prelude);
    checkPrelude(prelude);
    const inner = this.rules(parseRules(rule.block!));
    return inner.length > 0 ? { kind: "group", prelude: `@${rule.name} ${serializeCss(prelude)}`, rules: inner } : null;
  }

  styleRule(rule: Extract<CssRule, { kind: "qualified" }>, inKeyframes: boolean): Approved | null {
    let selector: string;
    if (inKeyframes) {
      const frames = splitTop(trim(rule.prelude)).map((part) => {
        const [only, ...rest] = trim(part);
        if (rest.length === 0 && only?.type === "ident" && ["from", "to"].includes(only.value.toLowerCase())) return only.value.toLowerCase();
        if (rest.length === 0 && only?.type === "percentage" && only.value >= 0 && only.value <= 100) return `${only.repr}%`;
        return refuse("syntax", "A keyframe is from, to or a percentage.");
      });
      selector = frames.join(",");
    } else {
      selector = parseSelectorList(trim(rule.prelude), false, false).map(scopeSelector).join(",");
    }
    const declarations: Array<[string, string, boolean]> = [];
    for (const declaration of parseDeclarations(rule.block)) {
      try {
        const name = declaration.name.toLowerCase();
        checkDeclarationName(declaration.name.startsWith("--") ? declaration.name : name);
        const value = checkValue(declaration.value, {
          assets: this.context.assets,
          keyframes: this.keyframes,
          namesKeyframes: name === "animation" || name === "animation-name",
        });
        if (value.length === 0) refuse("syntax", `${name} has no value.`);
        if (name === "position") checkPosition(value);
        // A cursor image is painted by the system, outside any box.
        if (name === "cursor" && JSON.stringify(value).includes(privateAssetProperty(""))) refuse("forbidden_function", "cursor takes a keyword: a cursor image paints outside its region.");
        if (name === "animation" || name === "animation-name") checkAnimation(name, value, this.prefixed);
        declarations.push([declaration.name.startsWith("--") ? declaration.name : name, serializeCss(value), declaration.important]);
      } catch (error) {
        this.issue(error);
      }
    }
    return declarations.length > 0 ? { kind: "style", selector, declarations } : null;
  }

  /** The theme's keyframe names as written (`t-<name>`). */
  get prefixed(): ReadonlySet<string> {
    return new Set([...this.keyframes].map((name) => `t-${name}`));
  }
}

function write(rules: readonly Approved[]): string {
  return rules.map((rule) => rule.kind === "style"
    ? `${rule.selector}{${rule.declarations.map(([name, value, important]) => `${name}:${value}${important ? "!important" : ""}`).join(";")}}`
    : `${rule.prelude}{${write(rule.rules)}}`).join("");
}

/** What a stylesheet reads as: each rule's prelude and declarations, written from their tokens. */
export function readPrivateCssStructure(css: string): Approved[] {
  const read = (rules: readonly CssRule[]): Approved[] => rules.map((rule): Approved => {
    if (rule.kind === "at") return { kind: "group", prelude: `@${rule.name} ${serializeCss(trim(rule.prelude))}`, rules: read(parseRules(rule.block ?? [])) };
    return {
      kind: "style",
      selector: serializeCss(trim(rule.prelude)),
      declarations: parseDeclarations(rule.block).map((declaration) => [declaration.name, serializeCss(declaration.value), declaration.important]),
    };
  });
  return read(parseRules(componentValues(tokenizeCss(css), PRIVATE_CSS_MAX_DEPTH + 4)));
}

/** Loading functions, escapes and markup an output may never hold, whatever the checks above decided. */
const UNSAFE_OUTPUT = /\\|url\s*\(|image(?:-set)?\s*\(|cross-fade|element\s*\(|src\s*\(|@import|@font-face|expression|attr\s*\(|<\/?style|<!--|-->/i;

/**
 * The theme's stylesheet checked and compiled. Any issue means a save is
 * refused; `css` is then "" (nothing is served from a stylesheet with an issue).
 */
export function compilePrivateCss(source: string, context: PrivateCssContext = EMPTY_CONTEXT): PrivateCssResult {
  try {
    return compile(source, context);
  } catch (error) {
    // A limit this checker failed to state as a refusal still refuses: a save never fails with a 500.
    return { css: "", issues: [{ reason: "syntax", message: `The stylesheet could not be read (${error instanceof Error ? error.name : "error"}).` }] };
  }
}

function compile(source: string, context: PrivateCssContext): PrivateCssResult {
  if (new TextEncoder().encode(source).byteLength > PRIVATE_CSS_MAX_BYTES) {
    return { css: "", issues: [{ reason: "too_large", message: `The private pages' stylesheet is at most ${PRIVATE_CSS_MAX_BYTES / 1024} KiB.` }] };
  }
  const compiler = new Compiler(context);
  let rules: CssRule[];
  try {
    const tokens = tokenizeCss(source);
    if (tokens.length > PRIVATE_CSS_MAX_TOKENS) {
      return { css: "", issues: [{ reason: "too_large", message: `The stylesheet holds over ${PRIVATE_CSS_MAX_TOKENS} tokens.` }] };
    }
    rules = parseRules(componentValues(tokens, PRIVATE_CSS_MAX_DEPTH));
  } catch (error) {
    compiler.issue(error);
    return { css: "", issues: compiler.issues };
  }
  let approved: Approved[] = [];
  try {
    compiler.collectKeyframes(rules);
    approved = compiler.rules(rules);
  } catch (error) {
    compiler.issue(error);
  }
  if (compiler.issues.length > 0) return { css: "", issues: compiler.issues };
  const css = write(approved);
  if (new TextEncoder().encode(css).byteLength > PRIVATE_COMPILED_CSS_MAX_BYTES) {
    return { css: "", issues: [{ reason: "too_large", message: `The compiled stylesheet is over ${PRIVATE_COMPILED_CSS_MAX_BYTES / 1024} KiB; shorten it.` }] };
  }
  // Fail closed: the output must hold nothing that loads or escapes, and read back as exactly what was approved.
  let readBack = "";
  try {
    readBack = JSON.stringify(readPrivateCssStructure(css));
  } catch {
    readBack = "";
  }
  if (UNSAFE_OUTPUT.test(css) || readBack !== JSON.stringify(approved)) {
    return { css: "", issues: [{ reason: "unsafe_output", message: "The stylesheet did not compile to exactly what was checked; it is not served." }] };
  }
  return { css, issues: [] };
}
