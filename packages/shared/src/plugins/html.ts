// The one sanitizer for HTML an app gives the storefront: an allowlist with
// two profiles.
//
// - "surface": checkout and account blocks and proxy pages
//   (docs/platform/PLUGINS.md, "Storefront surfaces"). Content, table, list
//   and form tags; no inline style, no `id`, no `h1` (the page owns it), no
//   SVG; forms post only to the app's own proxy (`/apps/<plugin id>/...`),
//   and only for apps with the proxy.
// - "component": storefront components: sections, product blocks and skins
//   (docs/STOREFRONT-COMPONENTS.md, "Output"). Adds what a theme draws with:
//   `h1`, `video`, an SVG drawing subset, inline style that loads nothing
//   (no `url()` or other loading function, no escapes, no comments), `id`s
//   under the app's own prefix (`<app name>-…`, so markup never clobbers the
//   page's ids), forms posting to any same-store path, islands, core embeds
//   and schema.org JSON-LD (re-serialized; left out on a `noindex` page).
//
// Both profiles: no event handlers, no script-capable URLs (links: same-store
// paths, https, mailto/tel and fragments; images and video: https or
// same-store paths), no `name` outside form controls, no host-owned
// `data-sx-*` attributes. Unknown tags are unwrapped; executable or raw-text
// ones are dropped with their content. Input, output, depth and element count
// are bounded: over a bound the result is `ok: false` (render nothing), never
// truncated markup.
//
// Parser differentials (mXSS) cannot change the result: the input is parsed
// into a tree and the output written from what is kept, every text escaped
// (`& < >`) and every attribute value quoted and escaped (`& < > "`). No
// raw-text, RCDATA or foreign-content trap is ever written (style, script,
// noscript, template, title, xmp, iframe, math, SVG foreignObject and
// animation; a textarea keeps its text only; JSON-LD is re-serialized with no
// `<`, `>` or `&`). So the browser reads exactly the tags written here,
// whatever htmlparser2 made of the input, and decoded entities stay text.
//
// Pure and deterministic: the API sanitizes checkout and account block HTML
// before it stores it; the storefront sanitizes proxy pages and component
// output before it renders them.

import { parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { STOREFRONT_COMPONENT_LIMITS } from "./storefront-protocol";

/** Largest HTML a plugin may return for one surface. */
export const PLUGIN_HTML_MAX_INPUT_BYTES = 128 * 1024;
/** Largest sanitized HTML one surface renders. */
export const PLUGIN_HTML_MAX_OUTPUT_BYTES = 64 * 1024;
export const PLUGIN_HTML_MAX_DEPTH = 32;
export const PLUGIN_HTML_MAX_ELEMENTS = 2_000;

export type PluginHtmlProfile = "surface" | "component";

export interface PluginHtmlOptions {
  /** The app the markup belongs to: its proxy (surface forms) and its id prefix (component ids). */
  pluginId: string;
  /** Surface: whether the app has the storefront proxy (forms are dropped without it). */
  forms?: boolean;
  /** Default "surface". */
  profile?: PluginHtmlProfile;
  /** Component: keep schema.org JSON-LD (false on a `noindex` page). Default true. */
  jsonLd?: boolean;
}

export type PluginHtmlResult =
  | { ok: true; html: string; /** Elements and attributes left out (an author diagnostic). */ dropped: number }
  | { ok: false; reason: "too_large" | "too_complex" };

// ── Elements ──────────────────────────────────────────────────────────────

const SURFACE_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "button", "caption", "code", "dd", "del", "details",
  "div", "dl", "dt", "em", "figcaption", "figure", "footer", "form", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "i", "img", "input", "ins", "label", "li", "mark", "nav", "ol", "optgroup", "option", "p", "picture", "pre", "q",
  "s", "section", "select", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "textarea", "tfoot", "th", "thead", "time", "tr", "u", "ul",
]);

/** SVG drawing elements, by lower-case name, with the spelling written out. */
const SVG_TAGS: Readonly<Record<string, string>> = {
  svg: "svg", g: "g", path: "path", circle: "circle", ellipse: "ellipse", line: "line", polyline: "polyline",
  polygon: "polygon", rect: "rect", defs: "defs", lineargradient: "linearGradient", radialgradient: "radialGradient",
  stop: "stop", clippath: "clipPath",
};

const COMPONENT_TAGS = new Set([...SURFACE_TAGS, "h1", "video", "scalius-island", "scalius-embed", ...Object.keys(SVG_TAGS)]);

/** Dropped with everything inside them (executable, raw text, foreign parsing, or loading). */
const DROP_WITH_CONTENT = new Set([
  "applet", "audio", "base", "canvas", "embed", "frame", "frameset", "head", "iframe", "link", "math", "meta",
  "noembed", "noframes", "noscript", "object", "param", "plaintext", "portal", "script", "style", "template",
  "title", "xmp", "foreignobject", "animate", "animatemotion", "animatetransform", "set", "use", "image",
  "feimage", "mpath", "discard",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "wbr"]);

// ── Attributes ────────────────────────────────────────────────────────────

const GENERAL_ATTRIBUTES = new Set(["class", "dir", "lang", "role", "title", "hidden"]);
/** What components may add on any element. */
const COMPONENT_GENERAL_ATTRIBUTES = new Set([
  ...GENERAL_ATTRIBUTES, "id", "style", "tabindex", "inert", "translate", "popover", "popovertarget", "popovertargetaction",
]);
const TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "target", "hreflang"]),
  button: new Set(["type", "name", "value", "disabled"]),
  details: new Set(["open"]),
  form: new Set(["action", "method"]),
  img: new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"]),
  input: new Set([
    "type", "name", "value", "placeholder", "required", "min", "max", "step", "minlength", "maxlength", "pattern",
    "checked", "disabled", "readonly", "autocomplete", "inputmode", "size",
  ]),
  ol: new Set(["start", "reversed", "type"]),
  optgroup: new Set(["label", "disabled"]),
  option: new Set(["value", "selected", "disabled", "label"]),
  select: new Set(["name", "required", "disabled", "multiple", "size"]),
  source: new Set(["srcset", "sizes", "media", "type", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  textarea: new Set(["name", "rows", "cols", "minlength", "maxlength", "placeholder", "required", "disabled", "readonly"]),
  th: new Set(["colspan", "rowspan", "scope", "abbr"]),
  time: new Set(["datetime"]),
};
/** What components may add on these elements. */
const COMPONENT_TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  img: new Set(["fetchpriority"]),
  input: new Set(["autofocus"]),
  label: new Set(["for"]),
  "scalius-embed": new Set(["kind"]),
  source: new Set(["src"]),
  video: new Set(["src", "poster", "preload", "muted", "loop", "playsinline", "controls", "autoplay", "width", "height"]),
};
/** SVG presentation attributes, by lower-case name, with the spelling written out. */
const SVG_ATTRIBUTES: Readonly<Record<string, string>> = Object.fromEntries([
  "viewBox", "preserveAspectRatio", "focusable", "fill", "fill-opacity", "fill-rule", "clip-rule", "clip-path",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "stroke-miterlimit", "stroke-opacity", "opacity", "vector-effect", "pathLength", "transform", "d", "points", "cx",
  "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "offset", "stop-color", "stop-opacity",
  "gradientUnits", "gradientTransform", "fx", "fy", "spreadMethod", "clipPathUnits",
].map((name) => [name.toLowerCase(), name]));
/** An SVG attribute value: numbers, paths, colours and `url(#…)` references only. */
const SVG_VALUE = /^[\w\s#.,%()+-]{0,4000}$/;

const BOOLEAN_ATTRIBUTES = new Set([
  "hidden", "disabled", "required", "checked", "selected", "readonly", "multiple", "open", "reversed", "inert",
  "autofocus", "muted", "loop", "playsinline", "controls", "autoplay",
]);
const INPUT_TYPES = new Set(["hidden", "text", "email", "tel", "number", "search", "checkbox", "radio", "submit", "button", "reset", "date", "url"]);
const BUTTON_TYPES = new Set(["button", "submit", "reset"]);
const INTEGER_ATTRIBUTES = new Set(["width", "height", "colspan", "rowspan", "rows", "cols", "size", "start", "minlength", "maxlength"]);
const ENUMERATED: Readonly<Record<string, ReadonlySet<string>>> = {
  loading: new Set(["lazy", "eager"]),
  decoding: new Set(["async", "sync", "auto"]),
  fetchpriority: new Set(["high", "low", "auto"]),
  preload: new Set(["none", "metadata", "auto"]),
  target: new Set(["_blank", "_self"]),
  dir: new Set(["ltr", "rtl", "auto"]),
  popover: new Set(["", "auto", "manual", "hint"]),
  popovertargetaction: new Set(["show", "hide", "toggle"]),
  translate: new Set(["yes", "no"]),
};
const MAX_ATTRIBUTE_VALUE = 2_000;
const MAX_CLASS_TOKENS = 40;
const CLASS_TOKEN = /^[A-Za-z0-9_:/[\]().%#!@,-]{1,80}$/;
const DATA_ATTRIBUTE = /^data-(?!sx-)[a-z][a-z0-9-]{0,40}$/;
const ARIA_ATTRIBUTE = /^aria-[a-z]{2,24}$/;
const ID_REFERENCE = /^[A-Za-z][\w-]{0,99}$/;

/**
 * Inline style that loads and hides nothing: `property: value` declarations
 * whose functions are computing or colour ones (no `url()`, `image-set()`,
 * `attr()`, `src()`, …), without escapes, comments, rules or markup.
 */
const STYLE_FUNCTIONS = /^(?:var|calc|min|max|clamp|rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|(?:repeating-)?(?:linear|radial|conic)-gradient|translate(?:x|y|3d)?|rotate|scale(?:x|y)?|skew(?:x|y)?|matrix|cubic-bezier|steps|minmax|repeat|fit-content)$/;
const STYLE_PROPERTY = /^(?:--[\w-]{1,60}|-?[a-z][a-z-]{1,40})$/;

function safeStyle(value: string): string | null {
  if (/[\\<>{}@]|\/\*/.test(value)) return null;
  for (const call of value.matchAll(/([\w-]*)\s*\(/g)) {
    if (call[1] && !STYLE_FUNCTIONS.test(call[1].toLowerCase())) return null;
  }
  const declarations: string[] = [];
  for (const declaration of value.split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const body = declaration.slice(colon + 1).trim();
    if (colon < 0 || !STYLE_PROPERTY.test(property) || !body) return null;
    declarations.push(`${property}:${body}`);
  }
  return declarations.length > 0 ? declarations.join(";") : null;
}

// ── URLs ──────────────────────────────────────────────────────────────────

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** A C0 control character or DEL anywhere in the value. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-store path (`/x`, never `//x` or `/\x`), a fragment, or one of the
 * schemes allowed for this attribute. `http` also allows http URLs: component
 * media comes from the store's own media origin, which is http on a local stack.
 */
export function sanitizePluginUrl(value: string, kind: "link" | "image", http = false): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ATTRIBUTE_VALUE) return null;
  if (trimmed.includes("\\") || hasControlCharacter(trimmed)) return null;
  if (trimmed.startsWith("/")) return trimmed.startsWith("//") ? null : trimmed;
  if (kind === "link" && trimmed.startsWith("#")) return /^#[A-Za-z0-9_-]{0,80}$/.test(trimmed) ? trimmed : null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol === "https:" || (http && url.protocol === "http:")) return url.username || url.password ? null : url.href;
  if (kind === "link" && (url.protocol === "mailto:" || url.protocol === "tel:")) return trimmed;
  return null;
}

function sanitizeSrcset(value: string, http: boolean): string | null {
  const candidates = value.split(",").map((candidate) => {
    const [url = "", ...descriptors] = candidate.trim().split(/\s+/);
    const safe = sanitizePluginUrl(url, "image", http);
    if (!safe || !descriptors.every((descriptor) => /^\d+(?:\.\d+)?[wx]$/.test(descriptor))) return null;
    return [safe, ...descriptors].join(" ");
  });
  return candidates.every((candidate) => candidate !== null) && candidates.length > 0 ? candidates.join(", ") : null;
}

/** A form action: a same-store path; on a surface, only the app's own proxy. */
function sanitizeFormAction(value: string, scope: Scope): string | null {
  const safe = sanitizePluginUrl(value, "link");
  if (!safe?.startsWith("/")) return null;
  if (scope.component) return safe;
  if (!scope.forms || !safe.startsWith(`/apps/${scope.pluginId}/`)) return null;
  const path = safe.split(/[?#]/, 1)[0]!;
  if (path.split("/").some((segment) => segment === "." || segment === ".." || /%2e|%2f|%5c/i.test(segment))) return null;
  return safe;
}

// ── JSON-LD ───────────────────────────────────────────────────────────────

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the element or start markup. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

/** A schema.org JSON-LD object, serialized for a script element; null for anything else. */
export function serializeSchemaJsonLd(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const context = entry["@context"];
  if (context !== "https://schema.org" && context !== "http://schema.org" && context !== "https://schema.org/") return null;
  if (typeof entry["@type"] !== "string" || !/^[A-Za-z]{2,60}$/.test(entry["@type"])) return null;
  try {
    return serializeJsonLd({ ...entry, "@context": "https://schema.org" });
  } catch {
    return null;
  }
}

// ── The walk ──────────────────────────────────────────────────────────────

interface Scope {
  pluginId: string;
  component: boolean;
  forms: boolean;
  jsonLd: boolean;
  /** Component ids start with it: `<app name>-`. */
  idPrefix: string;
  maxDepth: number;
  maxElements: number;
  elements: number;
  dropped: number;
  exceeded: boolean;
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", " ": "&nbsp;" };
const escapeText = (value: string) => value.replace(/[&<> ]/g, (char) => ESCAPES[char]!);
const escapeAttribute = (value: string) => value.replace(/[&<>" ]/g, (char) => ESCAPES[char]!);

function attribute(name: string, value: string, tag: string, svg: boolean, scope: Scope): [string, string] | null {
  if (name.startsWith("on") || value.length > MAX_ATTRIBUTE_VALUE) return null;
  if (svg && SVG_ATTRIBUTES[name]) {
    if (!SVG_VALUE.test(value) || /url\s*\(\s*(?!#)/i.test(value)) return null;
    return [SVG_ATTRIBUTES[name]!, value];
  }
  const allowed = TAG_ATTRIBUTES[tag]?.has(name) || GENERAL_ATTRIBUTES.has(name)
    || (scope.component && (COMPONENT_GENERAL_ATTRIBUTES.has(name) || COMPONENT_TAG_ATTRIBUTES[tag]?.has(name)))
    || ARIA_ATTRIBUTE.test(name) || DATA_ATTRIBUTE.test(name);
  if (!allowed) return null;
  if (BOOLEAN_ATTRIBUTES.has(name)) return [name, ""];
  if (INTEGER_ATTRIBUTES.has(name)) return /^\d{1,5}$/.test(value.trim()) ? [name, value.trim()] : null;
  const choices = ENUMERATED[name];
  if (choices) return choices.has(value.toLowerCase()) ? [name, value.toLowerCase()] : null;
  switch (name) {
    case "class": {
      const tokens = value.split(/\s+/).filter((token) => CLASS_TOKEN.test(token)).slice(0, MAX_CLASS_TOKENS);
      return tokens.length > 0 ? [name, tokens.join(" ")] : null;
    }
    case "id":
      return value.startsWith(scope.idPrefix) && ID_REFERENCE.test(value) ? [name, value] : null;
    case "for":
    case "popovertarget":
      return ID_REFERENCE.test(value) ? [name, value] : null;
    case "tabindex":
      return /^-?\d{1,3}$/.test(value.trim()) ? [name, value.trim()] : null;
    case "style": {
      const style = safeStyle(value);
      return style ? [name, style] : null;
    }
    case "href": {
      const href = sanitizePluginUrl(value, "link", scope.component);
      return href ? [name, href] : null;
    }
    case "src":
    case "poster": {
      const src = sanitizePluginUrl(value, "image", scope.component);
      return src ? [name, src] : null;
    }
    case "srcset": {
      const srcset = sanitizeSrcset(value, scope.component);
      return srcset ? [name, srcset] : null;
    }
    case "rel":
      return [name, value.split(/\s+/).filter((token) => /^[a-z-]{1,20}$/.test(token)).join(" ")];
    case "type":
      if (tag === "input") return INPUT_TYPES.has(value.toLowerCase()) ? [name, value.toLowerCase()] : null;
      if (tag === "button") return [name, BUTTON_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : "button"];
      if (tag === "ol") return /^[1aAiI]$/.test(value) ? [name, value] : null;
      if (tag === "source") return /^[a-z]+\/[a-z0-9.+-]+$/i.test(value) ? [name, value] : null;
      return null;
    case "action": {
      const action = sanitizeFormAction(value, scope);
      return action ? [name, action] : null;
    }
    case "method":
      return [name, value.toLowerCase() === "post" ? "post" : "get"];
    case "autocomplete":
      return /^[a-z -]{1,40}$/.test(value) ? [name, value] : null;
    default:
      return [name, value];
  }
}

/** The element's kept attributes; null when the element itself must go (an unsafe image, input, form or video). */
function attributes(tag: string, input: Record<string, string>, svg: boolean, scope: Scope): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(input)) {
    const kept = attribute(rawName.toLowerCase(), String(rawValue ?? ""), tag, svg, scope);
    if (kept) result.set(kept[0], kept[1]);
    else scope.dropped += 1;
  }
  if (tag === "input" && input.type !== undefined && !result.has("type")) return null; // a password, file or image input
  if (tag === "a" && result.get("target") === "_blank") {
    const rel = new Set((result.get("rel") ?? "").split(/\s+/).filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    result.set("rel", [...rel].join(" "));
  }
  if (tag === "img") {
    if (!result.has("src")) return null;
    if (!result.has("loading")) result.set("loading", "lazy");
    if (!result.has("decoding")) result.set("decoding", "async");
    if (!result.has("alt")) result.set("alt", "");
  }
  if (tag === "video" && !result.has("src") && input.src !== undefined) return null;
  if (tag === "form") {
    if (!result.has("action")) return null;
    if (!result.has("method")) result.set("method", "get");
  }
  if (tag === "button" && !result.has("type")) result.set("type", "button");
  return result;
}

function textOf(nodes: ChildNode[]): string {
  return nodes.map((node) => (isText(node) ? node.data : isTag(node) ? textOf(node.children) : "")).join("");
}

function walk(nodes: ChildNode[], depth: number, scope: Scope, inForm: boolean, svg: boolean, out: string[]): void {
  for (const node of nodes) {
    if (scope.exceeded) return;
    if (isText(node)) {
      out.push(escapeText(node.data));
      continue;
    }
    if (!isTag(node)) continue; // comments, CDATA, processing instructions, doctype
    const tag = node.name.toLowerCase();
    if (tag === "script" && scope.component && (node.attribs.type ?? "").trim().toLowerCase() === "application/ld+json") {
      let json: string | null = null;
      try {
        json = scope.jsonLd ? serializeSchemaJsonLd(JSON.parse(textOf(node.children))) : null;
      } catch {
        json = null;
      }
      if (json) out.push(`<script type="application/ld+json">${json}</script>`);
      else scope.dropped += 1;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag) || (tag === "svg" && !scope.component)) {
      scope.dropped += 1;
      continue;
    }
    if (depth > scope.maxDepth) {
      scope.exceeded = true;
      return;
    }
    const allowed = (scope.component ? COMPONENT_TAGS : SURFACE_TAGS).has(tag)
      && (svg ? SVG_TAGS[tag] !== undefined || tag === "a" : tag === "svg" || SVG_TAGS[tag] === undefined)
      && !(tag === "form" && inForm);
    const kept = allowed ? attributes(tag, node.attribs, svg || tag === "svg", scope) : null;
    if (!kept) {
      // An unknown or unsafe element goes, its text stays (an image, input or video has none).
      scope.dropped += 1;
      if (tag !== "img" && tag !== "input" && tag !== "video") walk(node.children, depth + 1, scope, inForm || tag === "form", svg, out);
      continue;
    }
    scope.elements += 1;
    if (scope.elements > scope.maxElements) {
      scope.exceeded = true;
      return;
    }
    const name = SVG_TAGS[tag] ?? tag;
    let open = `<${name}`;
    for (const [key, value] of kept) open += value === "" ? ` ${key}` : ` ${key}="${escapeAttribute(value)}"`;
    out.push(`${open}>`);
    if (VOID_TAGS.has(tag)) continue;
    // RCDATA in the browser: a textarea shows text only.
    if (tag === "textarea") out.push(escapeText(textOf(node.children)));
    else walk(node.children, depth + 1, scope, inForm || tag === "form", svg || tag === "svg", out);
    out.push(`</${name}>`);
  }
}

/**
 * Sanitizes one surface's or component's HTML. `ok: false` means render
 * nothing (and log it for the merchant): the input or output is over its
 * size bound, or the markup is deeper or larger than its profile allows.
 */
export function sanitizePluginHtml(html: string, options: PluginHtmlOptions): PluginHtmlResult {
  const component = options.profile === "component";
  const maxBytes = component ? STOREFRONT_COMPONENT_LIMITS.htmlBytes : PLUGIN_HTML_MAX_INPUT_BYTES;
  if (typeof html !== "string") return { ok: false, reason: "too_complex" };
  if (byteLength(html) > maxBytes) return { ok: false, reason: "too_large" };
  const normalized = html.replaceAll("\0", "").replace(/[​-‍﻿]/g, "");
  const document = parseDocument(normalized, {
    decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true,
  });
  const scope: Scope = {
    pluginId: options.pluginId,
    component,
    forms: options.forms === true,
    jsonLd: options.jsonLd !== false,
    idPrefix: `${options.pluginId.slice(options.pluginId.indexOf(".") + 1)}-`,
    maxDepth: component ? STOREFRONT_COMPONENT_LIMITS.htmlDepth : PLUGIN_HTML_MAX_DEPTH,
    maxElements: component ? STOREFRONT_COMPONENT_LIMITS.htmlElements : PLUGIN_HTML_MAX_ELEMENTS,
    elements: 0,
    dropped: 0,
    exceeded: false,
  };
  const out: string[] = [];
  walk(document.children, 1, scope, false, false, out);
  if (scope.exceeded) return { ok: false, reason: "too_complex" };
  const output = out.join("");
  if (byteLength(output) > (component ? maxBytes : PLUGIN_HTML_MAX_OUTPUT_BYTES)) return { ok: false, reason: "too_large" };
  return { ok: true, html: output, dropped: scope.dropped };
}
