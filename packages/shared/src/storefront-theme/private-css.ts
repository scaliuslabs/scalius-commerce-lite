// The theme's stylesheet for the buyer's private pages, checked and compiled
// once when the theme is saved or published (never per request).
//
// It is parsed by a CSS Syntax 3 tokenizer and parser (private-css-syntax.ts)
// and only what the parser positively understands and the allow-lists below
// accept is kept. The output is written from the checked tokens, never from
// the source text, then parsed again and compared with what was approved,
// and scanned for any loading function or escape: anything that disagrees
// fails closed (no stylesheet).
//
// What a stylesheet may do:
// - style rules, `@media`, `@supports`, `@container` and `@keyframes` (its
//   names are prefixed `t-` so they never meet the store's own);
// - selectors of type, class, id, attribute, the allowed pseudo-classes
//   (`:is`, `:where`, `:not`, `:has`, `:nth-*` …) and `::before`, `::after`,
//   `::marker`, `::first-line`, `::first-letter`, `::selection`;
// - values made of words, numbers, colours, strings and the allowed
//   functions (colour, maths, gradients, `var`, `env`, timing, grid tracks,
//   filters, shapes, counters); `url(<asset>)` names one of the theme's own
//   listed assets and is written as `var(--private-asset-<asset>)`, which the
//   page defines from the store's own origin;
// - its own custom properties, named `--t-*`.
// What it may not, each with its `reason`:
// - reach any file or host (`import`, `foreign_url`, `forbidden_function`);
// - read what a buyer types (`form_value_selector`, `state_selector`);
// - leave the private surfaces (`unscoped_selector`): every selector is
//   scoped under `[data-private]`, a rule for `:root`, `html` or `body` alone
//   is the page's own rule (`body[data-private-body]`), a root state stays in
//   front, and nothing may follow a surface root with a sibling combinator;
// - position anything over anything (`positioning`): no `top`/`left`/`inset`,
//   `z-index`, transforms, `position` other than `static` or `relative`,
//   grid placement or negative margins;
// - hide, cover or fake what a buyer must see (`protected_property`,
//   `protected_value`, `protected_pseudo`): a rule that can reach a protected
//   part, or anything inside one, may set only presentational properties
//   (`PROTECTED_PROPERTIES`). Only a rule anchored on the theme's own content
//   block (`[data-hook]` of a content node) or on a part the anatomy marks
//   free (`[data-part]` of an optional part, or a free hook) is free of it;
// - use escapes, nesting, other at-rules or more than 24 KiB.

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
export const PRIVATE_COMPILED_CSS_MAX_BYTES = 40 * 1024;
/**
 * The checker's version. A stylesheet compiled by an older one is never
 * served: the page compiles it again or draws without it.
 */
export const PRIVATE_CSS_SANITIZER_VERSION = 2 as const;

export const PRIVATE_CSS_REASONS = [
  "too_large", "syntax", "null_byte", "bad_string", "bad_url", "comment", "unbalanced", "escape", "nested_rule",
  "import", "unsupported_at_rule", "foreign_url", "forbidden_function", "custom_property",
  "form_value_selector", "state_selector", "unsupported_selector", "unscoped_selector",
  "positioning", "protected_property", "protected_value", "protected_pseudo", "unsafe_output",
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

/** What a stylesheet is checked against: the theme's assets and what it may restyle freely. */
export interface PrivateCssContext {
  /** The theme's listed assets (`privatePages.assets`), by key. */
  assets: ReadonlySet<string>;
  /** `data-hook` values of the theme's own content blocks (never of a layout node, which holds parts). */
  freeHooks: ReadonlySet<string>;
  /** `data-part` values a theme may restyle freely: optional parts, and hooks the anatomy marks free. */
  freeParts: ReadonlySet<string>;
}

const EMPTY_CONTEXT: PrivateCssContext = { assets: new Set(), freeHooks: new Set(), freeParts: new Set() };

/** The scope every private surface's root carries. */
export const PRIVATE_CSS_SCOPE = "[data-private]";
/** The page's own rule (`:root`, `html` or `body` alone). */
export const PRIVATE_CSS_PAGE = "body[data-private-body]";
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

/** Properties no rule may set: each can move one thing over another. */
const POSITIONING = new Set([
  "top", "right", "bottom", "left", "inset", "inset-block", "inset-inline", "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end",
  "z-index", "transform", "translate", "rotate", "scale", "transform-origin", "offset", "offset-path", "offset-distance", "offset-position", "offset-anchor", "offset-rotate",
  "grid-area", "grid-row", "grid-row-start", "grid-row-end", "grid-column", "grid-column-start", "grid-column-end", "anchor-name", "position-anchor", "position-area", "position-try",
]);
/** Never: script-era or non-standard properties. */
const FORBIDDEN = new Set(["behavior", "-moz-binding", "zoom"]);

type Check = (value: readonly CssNode[]) => string | null;

const words = (value: readonly CssNode[]) => value.filter((node) => node.type !== "whitespace");
const hasFunction = (value: readonly CssNode[]): boolean => value.some((node) => node.type === "fn" || (node.type === "block" && hasFunction(node.values)));
const length = (node: CssNode, floors: Record<string, number>): boolean | null => {
  if (node.type === "number") return node.value === 0 ? false : null;
  if (node.type === "percentage") return node.value >= (floors["%"] ?? 0);
  if (node.type === "dimension") {
    const floor = floors[node.unit.toLowerCase()];
    return floor === undefined ? false : node.value >= floor;
  }
  return null;
};

const anyValue: Check = () => null;
const noFunctions = (check: Check): Check => (value) => hasFunction(value) ? "a fixed value (no var(), calc() or other function) where it can reach a part a buyer must see" : check(value);
const keywords = (allowed: readonly string[]): Check => (value) => {
  const items = words(value);
  return items.every((node) => node.type === "ident" && allowed.includes(node.value.toLowerCase())) ? null : `one of ${allowed.join(", ")}`;
};
const nonNegative: Check = noFunctions((value) => words(value).some((node) => (node.type === "number" || node.type === "dimension" || node.type === "percentage") && node.value < 0) ? "no negative length" : null);
const SIZE_FLOORS = { px: 16, rem: 1, em: 1, vw: 1, vh: 1, vmin: 1, vmax: 1, svh: 1, dvh: 1, lvh: 1, ch: 1, "%": 10 };
const sizeFloor: Check = noFunctions((value) => {
  for (const node of words(value)) {
    if (node.type === "ident" && ["auto", "none", "fit-content", "min-content", "max-content", "stretch"].includes(node.value.toLowerCase())) continue;
    if (length(node, SIZE_FLOORS) !== true) return "a size of at least 16px, 1rem or 10%, or auto";
  }
  return null;
});
const fontSize: Check = noFunctions((value) => {
  const items = words(value);
  if (items.length === 1 && items[0]!.type === "ident" && ["small", "medium", "large", "x-large", "xx-large", "xxx-large", "larger"].includes(items[0].value.toLowerCase())) return null;
  return items.length === 1 && length(items[0]!, { px: 11, rem: 0.7, em: 0.7, pt: 8.5, "%": 70 }) === true ? null : "a size of at least 11px, 0.7rem or 70%";
});
const lineHeight: Check = noFunctions((value) => {
  const items = words(value);
  const [only] = items;
  return items.length === 1 && ((only?.type === "ident" && only.value.toLowerCase() === "normal") || (only?.type === "number" && only.value >= 1)) ? null : "normal or a number of at least 1";
});
const spacing: Check = noFunctions((value) => {
  const items = words(value);
  const [only] = items;
  return items.length === 1 && ((only?.type === "ident" && only.value.toLowerCase() === "normal") || (only?.type === "number" && only.value === 0) || (only?.type === "dimension" && only.value >= 0)) ? null : "normal or a length of at least 0";
});
const DISPLAY = ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "flow-root", "contents", "list-item", "table", "table-row", "table-cell"];
/** A visible colour: no `transparent`, no alpha of 0, nothing that cannot be read here. */
const visibleColor: Check = (value) => {
  const items = words(value);
  if (items.length !== 1) return "one visible colour";
  const [only] = items;
  if (only!.type === "ident") return ["transparent"].includes(only!.value.toLowerCase()) ? "a visible colour (not transparent)" : null;
  if (only!.type === "hash") {
    const hex = only!.value;
    if (hex.length === 4) return hex[3] === "0" ? "a visible colour (alpha above 0)" : null;
    if (hex.length === 8) return hex.slice(6) === "00" ? "a visible colour (alpha above 0)" : null;
    return null;
  }
  if (only!.type === "fn" && ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch"].includes(only!.name)) {
    if (hasFunction(only!.values)) return "a colour of fixed numbers";
    const parts = words(only!.values).filter((node) => node.type !== "comma");
    const slash = parts.findIndex((node) => node.type === "delim" && node.value === "/");
    const alpha = slash >= 0 ? parts[slash + 1] : only!.name.endsWith("a") && parts.length === 4 ? parts[3] : undefined;
    if (alpha && (alpha.type === "number" || alpha.type === "percentage") && alpha.value === 0) return "a visible colour (alpha above 0)";
    return null;
  }
  return "a colour by name, hex or rgb()/hsl()/oklch() of fixed numbers";
};
const gridTracks: Check = (value) => {
  const zero = (nodes: readonly CssNode[], inMinmax = false): boolean => nodes.some((node, index) => {
    if (node.type === "fn") {
      if (node.name === "minmax") return zero(trim(node.values).filter((_item, position) => position > 0), true);
      return zero(node.values, inMinmax);
    }
    if (inMinmax && index === 0) return false;
    return (node.type === "number" || node.type === "dimension" || node.type === "percentage") && node.value <= 0;
  });
  return zero(value) ? "no track of size 0" : null;
};
const notText: Check = (value) => words(value).some((node) => node.type === "ident" && node.value.toLowerCase() === "text") ? "not text (the text would take the background's colour)" : null;
const listStyle: Check = (value) => hasFunction(value) ? "no image" : null;

/**
 * The properties a rule that can reach a protected part may set, and what
 * each may hold. Everything else (display none, visibility, opacity,
 * content, overflow, clipping, filters, masks, text-indent, animations,
 * pointer events, …) is refused there.
 */
export const PROTECTED_PROPERTIES: Readonly<Record<string, Check>> = {
  color: visibleColor,
  background: anyValue, "background-color": anyValue, "background-image": anyValue, "background-position": anyValue,
  "background-size": anyValue, "background-repeat": anyValue, "background-origin": anyValue, "background-clip": notText, "background-attachment": anyValue,
  "font-family": anyValue, "font-weight": anyValue, "font-style": anyValue, "font-stretch": anyValue, "font-variant": anyValue,
  "font-variant-numeric": anyValue, "font-variant-caps": anyValue, "font-feature-settings": anyValue, "font-kerning": anyValue,
  "font-size": fontSize, "line-height": lineHeight, "letter-spacing": spacing, "word-spacing": spacing,
  "text-transform": anyValue, "text-decoration": anyValue, "text-decoration-line": anyValue, "text-decoration-color": anyValue,
  "text-decoration-style": anyValue, "text-decoration-thickness": anyValue, "text-underline-offset": anyValue, "text-align": anyValue,
  "text-wrap": anyValue, "white-space": keywords(["normal", "nowrap", "pre-wrap", "pre-line", "break-spaces"]), "word-break": anyValue, "overflow-wrap": anyValue, "hyphens": anyValue,
  "text-shadow": anyValue, "box-shadow": anyValue,
  margin: nonNegative, "margin-top": nonNegative, "margin-right": nonNegative, "margin-bottom": nonNegative, "margin-left": nonNegative,
  "margin-block": nonNegative, "margin-inline": nonNegative, "margin-block-start": nonNegative, "margin-block-end": nonNegative, "margin-inline-start": nonNegative, "margin-inline-end": nonNegative,
  padding: anyValue, "padding-top": anyValue, "padding-right": anyValue, "padding-bottom": anyValue, "padding-left": anyValue,
  "padding-block": anyValue, "padding-inline": anyValue, "padding-block-start": anyValue, "padding-block-end": anyValue, "padding-inline-start": anyValue, "padding-inline-end": anyValue,
  gap: anyValue, "row-gap": anyValue, "column-gap": anyValue,
  border: anyValue, "border-width": anyValue, "border-style": anyValue, "border-color": anyValue,
  "border-top": anyValue, "border-right": anyValue, "border-bottom": anyValue, "border-left": anyValue,
  "border-block": anyValue, "border-inline": anyValue, "border-block-start": anyValue, "border-block-end": anyValue, "border-inline-start": anyValue, "border-inline-end": anyValue,
  "border-radius": anyValue, "border-start-start-radius": anyValue, "border-start-end-radius": anyValue, "border-end-start-radius": anyValue, "border-end-end-radius": anyValue,
  "border-top-left-radius": anyValue, "border-top-right-radius": anyValue, "border-bottom-left-radius": anyValue, "border-bottom-right-radius": anyValue,
  outline: anyValue, "outline-color": anyValue, "outline-style": anyValue, "outline-width": anyValue, "outline-offset": anyValue,
  "accent-color": anyValue, "caret-color": anyValue, cursor: anyValue,
  "align-items": anyValue, "align-content": anyValue, "align-self": anyValue, "justify-items": anyValue, "justify-content": anyValue, "justify-self": anyValue,
  "place-items": anyValue, "place-content": anyValue, "place-self": anyValue, "vertical-align": anyValue,
  "flex-direction": anyValue, "flex-wrap": anyValue, "flex-flow": anyValue, "flex-grow": anyValue, "flex-shrink": anyValue, "flex-basis": sizeFloor, order: anyValue,
  "grid-template-columns": gridTracks, "grid-template-rows": gridTracks, "grid-auto-columns": gridTracks, "grid-auto-rows": gridTracks, "grid-auto-flow": anyValue,
  display: keywords(DISPLAY), "box-sizing": anyValue,
  width: sizeFloor, "min-width": sizeFloor, "max-width": sizeFloor, height: sizeFloor, "min-height": sizeFloor, "max-height": sizeFloor,
  "inline-size": sizeFloor, "block-size": sizeFloor, "min-inline-size": sizeFloor, "max-inline-size": sizeFloor, "min-block-size": sizeFloor, "max-block-size": sizeFloor,
  "aspect-ratio": anyValue, "list-style": listStyle, "list-style-type": anyValue, "list-style-position": anyValue, "list-style-image": keywords(["none"]),
  "border-collapse": anyValue, "border-spacing": anyValue, "table-layout": anyValue, "object-fit": anyValue, "object-position": anyValue,
};

function checkDeclarationName(name: string): void {
  if (name.startsWith("--")) {
    if (!/^--t-[a-z0-9-]{1,40}$/.test(name)) refuse("custom_property", `${name}: the theme's own custom properties are named --t-<name>; the store's tokens are the theme's tokens, set in the theme document.`);
    return;
  }
  if (!/^[a-z][a-z-]*$/.test(name) || FORBIDDEN.has(name)) refuse("syntax", `${name} is not a property this stylesheet may set.`);
  if (POSITIONING.has(name)) refuse("positioning", `${name} can move one thing over another, which no rule here may do.`);
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

const isAttr = (simple: Simple, attr: string, value?: string): boolean =>
  simple.kind === "attr" && simple.name === attr && (value === undefined ? simple.op === null || simple.op === "=" : simple.op === "=" && simple.value === value);

/** A selector scoped to the private surfaces, and whether it is free of the protected-part limits. */
function scopeSelector(complex: Complex, context: PrivateCssContext): { text: string; free: boolean } {
  const [first, ...more] = complex.compounds;
  const firstCombinator = complex.combinators[0];
  const isRoot = first!.some((simple) => (simple.kind === "type" && (simple.name === "html" || simple.name === "body")) || (simple.kind === "pseudo" && simple.name === "root"));
  if (isRoot) {
    if (!first!.every((simple) => simple.kind === "attr" || (simple.kind === "pseudo" && !simple.selectors) || (simple.kind === "type" && (simple.name === "html" || simple.name === "body")))) {
      refuse("unscoped_selector", "The page root takes only a state (an attribute or a pseudo-class) before the rest of a selector.");
    }
    const state = first!.filter((simple) => simple.kind !== "type" && !(simple.kind === "pseudo" && simple.name === "root")).map(writeSimple).join("");
    const prefix = state ? `:root${state} ` : "";
    if (more.length === 0) return { text: `${prefix}${PRIVATE_CSS_PAGE}`, free: false };
    if (firstCombinator === "+" || firstCombinator === "~") refuse("unscoped_selector", "A sibling of the page root is outside the private pages.");
    const rest: Complex = { lead: null, compounds: more, combinators: complex.combinators.slice(1) };
    return { text: `${prefix}${PRIVATE_CSS_SCOPE} ${writeComplex(rest)}`, free: isFree(rest, context) };
  }
  if (isAttr(first![0]!, "data-private")) {
    if (firstCombinator === "+" || firstCombinator === "~") refuse("unscoped_selector", "A sibling of a private surface is outside it.");
    return { text: writeComplex(complex), free: isFree(complex, context) };
  }
  return { text: `${PRIVATE_CSS_SCOPE} ${writeComplex(complex)}`, free: isFree(complex, context) };
}

/**
 * True when the selector's subject is the theme's own content block, a part
 * the anatomy marks free, or inside one: some compound from the subject
 * leftwards, across descendant and child combinators only, is anchored on
 * one. Anything else (a type, a class, a layout node, a broad descendant)
 * can reach a protected part.
 */
function isFree(complex: Complex, context: PrivateCssContext): boolean {
  for (let index = complex.compounds.length - 1; index >= 0; index -= 1) {
    const compound = complex.compounds[index]!;
    if (compound.some((simple) => simple.kind === "attr" && simple.op === "=" && (
      (simple.name === "data-hook" && context.freeHooks.has(simple.value!))
      || (simple.name === "data-part" && context.freeParts.has(simple.value!))
    ))) return true;
    const joiner = complex.combinators[index - 1];
    if (joiner === "+" || joiner === "~") return false;
  }
  return false;
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
    let free: boolean;
    let pseudoElement = false;
    if (inKeyframes) {
      const frames = splitTop(trim(rule.prelude)).map((part) => {
        const [only, ...rest] = trim(part);
        if (rest.length === 0 && only?.type === "ident" && ["from", "to"].includes(only.value.toLowerCase())) return only.value.toLowerCase();
        if (rest.length === 0 && only?.type === "percentage" && only.value >= 0 && only.value <= 100) return `${only.repr}%`;
        return refuse("syntax", "A keyframe is from, to or a percentage.");
      });
      selector = frames.join(",");
      // Animations run only on what a rule may freely style (refused elsewhere).
      free = true;
    } else {
      const list = parseSelectorList(trim(rule.prelude), false, false);
      const scoped = list.map((complex) => scopeSelector(complex, this.context));
      selector = scoped.map((entry) => entry.text).join(",");
      free = scoped.every((entry) => entry.free);
      pseudoElement = list.some((complex) => complex.compounds[complex.compounds.length - 1]!.some((simple) => simple.kind === "element"));
      if (!free && pseudoElement) refuse("protected_pseudo", `${selector.slice(0, 80)}: a pseudo-element can cover or fake what a buyer must see; anchor the rule on your own content block or a free part.`);
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
        if (name === "position" && keywords(["static", "relative"])(value) !== null) refuse("positioning", "position may be static or relative only: nothing here is placed over anything.");
        if (/^margin/.test(name) && nonNegative(value) !== null) refuse("positioning", `${name} may not be negative or computed: a negative margin can pull one thing over another.`);
        if (!free && !name.startsWith("--")) {
          const check = PROTECTED_PROPERTIES[name];
          if (!check) refuse("protected_property", `${name} may not be set by ${selector.slice(0, 80)}: it can reach a part a buyer must see. Anchor the rule on your own content block or a free part, or set a presentational property.`);
          const problem = check!(value);
          if (problem) refuse("protected_value", `${name} needs ${problem} in ${selector.slice(0, 80)}.`);
        }
        declarations.push([declaration.name.startsWith("--") ? declaration.name : name, serializeCss(value), declaration.important]);
      } catch (error) {
        this.issue(error);
      }
    }
    return declarations.length > 0 ? { kind: "style", selector, declarations } : null;
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
  return read(parseRules(componentValues(tokenizeCss(css))));
}

/** Loading functions, escapes and markup an output may never hold, whatever the checks above decided. */
const UNSAFE_OUTPUT = /\\|url\s*\(|image(?:-set)?\s*\(|cross-fade|element\s*\(|src\s*\(|@import|@font-face|expression|attr\s*\(|<\/?style|<!--|-->/i;

/**
 * The theme's stylesheet checked and compiled. Any issue means a save is
 * refused; `css` is then "" (nothing is served from a stylesheet with an issue).
 */
export function compilePrivateCss(source: string, context: PrivateCssContext = EMPTY_CONTEXT): PrivateCssResult {
  if (new TextEncoder().encode(source).byteLength > PRIVATE_CSS_MAX_BYTES) {
    return { css: "", issues: [{ reason: "too_large", message: `The private pages' stylesheet is at most ${PRIVATE_CSS_MAX_BYTES / 1024} KiB.` }] };
  }
  const compiler = new Compiler(context);
  let rules: CssRule[];
  try {
    rules = parseRules(componentValues(tokenizeCss(source)));
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
