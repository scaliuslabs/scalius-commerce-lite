// The sanitizer for HTML a plugin returns to the storefront (sections,
// product blocks and proxy pages; docs/platform/PLUGINS.md, "Storefront
// surfaces"). Stricter than the merchant rich-text sanitizer
// (`html-sanitize.ts`), because a plugin is third-party code:
//
// - an allowlist of content, table, list and form tags; script, style,
//   iframe, svg, template, meta/link/base and anything executable are
//   dropped with their content; unknown tags are unwrapped;
// - no event handlers, no inline `style`, no `id` or stray `name` (no DOM
//   clobbering of the page's own ids and globals), no `h1` (the page owns
//   it);
// - links: same-store paths, https, mailto/tel and fragments only; images:
//   https or same-store paths only (no `data:`, no http);
// - forms post only to the app's own storefront proxy
//   (`/apps/<plugin id>/...`), and only for apps with the proxy;
// - bounded input, output, depth and element count. Over a bound the
//   result is empty (the surface renders nothing), never truncated markup.
//
// Pure and deterministic: the API sanitizes section and block HTML before it
// stores it under dependency validation; the storefront sanitizes proxy page
// HTML before it renders it in the store layout.

import { DomUtils, parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode, type Element } from "domhandler";

/** Largest HTML a plugin may return for one surface. */
export const PLUGIN_HTML_MAX_INPUT_BYTES = 128 * 1024;
/** Largest sanitized HTML one surface renders. */
export const PLUGIN_HTML_MAX_OUTPUT_BYTES = 64 * 1024;
export const PLUGIN_HTML_MAX_DEPTH = 32;
export const PLUGIN_HTML_MAX_ELEMENTS = 2_000;

const ALLOWED_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "button", "caption", "code", "dd", "del", "details",
  "div", "dl", "dt", "em", "figcaption", "figure", "footer", "form", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "i", "img", "input", "ins", "label", "li", "mark", "nav", "ol", "optgroup", "option", "p", "picture", "pre", "q",
  "s", "section", "select", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "textarea", "tfoot", "th", "thead", "time", "tr", "u", "ul",
]);

/** Dropped with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "applet", "audio", "base", "canvas", "embed", "frame", "frameset", "head", "iframe", "link", "math", "meta",
  "noembed", "noframes", "noscript", "object", "param", "portal", "script", "style", "svg", "template", "title",
  "video", "xmp",
]);

const GENERAL_ATTRIBUTES = new Set(["class", "dir", "lang", "role", "title", "hidden"]);
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
const BOOLEAN_ATTRIBUTES = new Set(["hidden", "disabled", "required", "checked", "selected", "readonly", "multiple", "open", "reversed"]);
const INPUT_TYPES = new Set(["hidden", "text", "email", "tel", "number", "search", "checkbox", "radio", "submit", "button", "reset", "date", "url"]);
const BUTTON_TYPES = new Set(["button", "submit", "reset"]);
const INTEGER_ATTRIBUTES = new Set(["width", "height", "colspan", "rowspan", "rows", "cols", "size", "start", "minlength", "maxlength"]);
const MAX_ATTRIBUTE_VALUE = 2_000;
const MAX_CLASS_TOKENS = 40;
const CLASS_TOKEN = /^[A-Za-z0-9_:/[\]().%#!@,-]{1,80}$/;
const DATA_ATTRIBUTE = /^data-[a-z][a-z0-9-]{0,40}$/;
const ARIA_ATTRIBUTE = /^aria-[a-z]{2,24}$/;

export interface PluginHtmlOptions {
  /** The app whose proxy forms may post to (`/apps/<pluginId>/...`). */
  pluginId: string;
  /** Whether the app has the storefront proxy (forms are dropped without it). */
  forms: boolean;
}

export type PluginHtmlResult =
  | { ok: true; html: string }
  | { ok: false; reason: "too_large" | "too_complex" };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** A same-store path (`/x`, never `//x` or `/\x`), a fragment, or one of the schemes allowed for this attribute. */
export function sanitizePluginUrl(value: string, kind: "link" | "image"): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ATTRIBUTE_VALUE) return null;
  if (/[\u0000-\u001F\u007F\\]/.test(trimmed)) return null;
  if (trimmed.startsWith("/")) return trimmed.startsWith("//") ? null : trimmed;
  if (kind === "link" && trimmed.startsWith("#")) return /^#[A-Za-z0-9_-]{0,80}$/.test(trimmed) ? trimmed : null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.username || url.password ? null : url.href;
  if (kind === "link" && (url.protocol === "mailto:" || url.protocol === "tel:")) return trimmed;
  return null;
}

function sanitizeSrcset(value: string): string | null {
  const candidates = value.split(",").map((candidate) => {
    const [url = "", ...descriptors] = candidate.trim().split(/\s+/);
    const safe = sanitizePluginUrl(url, "image");
    if (!safe || !descriptors.every((descriptor) => /^\d+(?:\.\d+)?[wx]$/.test(descriptor))) return null;
    return [safe, ...descriptors].join(" ");
  });
  return candidates.every((candidate) => candidate !== null) && candidates.length > 0 ? candidates.join(", ") : null;
}

/** A form action: only the app's own proxy path on this store. */
function sanitizeFormAction(value: string, pluginId: string): string | null {
  const safe = sanitizePluginUrl(value, "link");
  if (!safe || !safe.startsWith(`/apps/${pluginId}/`)) return null;
  const path = safe.split(/[?#]/, 1)[0]!;
  if (path.split("/").some((segment) => segment === "." || segment === ".." || /%2e|%2f|%5c/i.test(segment))) return null;
  return safe;
}

function sanitizeAttributes(tag: string, attributes: Record<string, string>, options: PluginHtmlOptions): Record<string, string> | null {
  const allowed = TAG_ATTRIBUTES[tag];
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    const value = String(rawValue ?? "");
    if (name.startsWith("on") || value.length > MAX_ATTRIBUTE_VALUE) continue;
    const isAria = ARIA_ATTRIBUTE.test(name);
    const isData = DATA_ATTRIBUTE.test(name);
    if (!GENERAL_ATTRIBUTES.has(name) && !allowed?.has(name) && !isAria && !isData) continue;
    if (BOOLEAN_ATTRIBUTES.has(name)) {
      result[name] = "";
      continue;
    }
    if (INTEGER_ATTRIBUTES.has(name)) {
      if (/^\d{1,5}$/.test(value.trim())) result[name] = value.trim();
      continue;
    }
    switch (name) {
      case "class": {
        const tokens = value.split(/\s+/).filter((token) => CLASS_TOKEN.test(token)).slice(0, MAX_CLASS_TOKENS);
        if (tokens.length > 0) result.class = tokens.join(" ");
        break;
      }
      case "href": {
        const href = sanitizePluginUrl(value, "link");
        if (href) result.href = href;
        break;
      }
      case "src": {
        const src = sanitizePluginUrl(value, "image");
        if (src) result.src = src;
        break;
      }
      case "srcset": {
        const srcset = sanitizeSrcset(value);
        if (srcset) result.srcset = srcset;
        break;
      }
      case "target":
        if (value === "_blank" || value === "_self") result.target = value;
        break;
      case "rel":
        result.rel = value.split(/\s+/).filter((token) => /^[a-z-]{1,20}$/.test(token)).join(" ");
        break;
      case "loading":
        if (value === "lazy" || value === "eager") result.loading = value;
        break;
      case "decoding":
        if (value === "async" || value === "sync" || value === "auto") result.decoding = value;
        break;
      case "type":
        if (tag === "input") {
          const type = value.toLowerCase();
          if (!INPUT_TYPES.has(type)) return null; // a password, file or image input is dropped
          result.type = type;
        } else if (tag === "button") {
          result.type = BUTTON_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : "button";
        } else if (tag === "ol") {
          if (/^[1aAiI]$/.test(value)) result.type = value;
        } else if (tag === "source") {
          if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(value)) result.type = value;
        }
        break;
      case "action": {
        const action = options.forms ? sanitizeFormAction(value, options.pluginId) : null;
        if (!action) return null;
        result.action = action;
        break;
      }
      case "method":
        result.method = value.toLowerCase() === "post" ? "post" : "get";
        break;
      case "autocomplete":
        if (/^[a-z -]{1,40}$/.test(value)) result.autocomplete = value;
        break;
      case "dir":
        if (value === "ltr" || value === "rtl" || value === "auto") result.dir = value;
        break;
      default:
        result[name] = value;
    }
  }
  if (tag === "a" && result.target === "_blank") {
    const rel = new Set((result.rel ?? "").split(/\s+/).filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    result.rel = [...rel].join(" ");
  }
  if (tag === "img") {
    if (!result.src) return null;
    result.loading ??= "lazy";
    result.decoding ??= "async";
    result.alt ??= "";
  }
  if (tag === "form") {
    if (!result.action) return null;
    result.method ??= "get";
  }
  if (tag === "button") result.type ??= "button";
  return result;
}

class Budget {
  elements = 0;
  exceeded = false;
}

function sanitizeNodes(nodes: ChildNode[], depth: number, options: PluginHtmlOptions, budget: Budget, inForm: boolean): ChildNode[] {
  const result: ChildNode[] = [];
  for (const node of nodes) {
    if (budget.exceeded) break;
    if (isText(node)) {
      result.push(node);
      continue;
    }
    if (!isTag(node)) continue; // comments, processing instructions, doctype
    const tag = node.name.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (depth > PLUGIN_HTML_MAX_DEPTH) {
      budget.exceeded = true;
      break;
    }
    const nestedForm = tag === "form" && inForm;
    const children = sanitizeNodes(node.children ?? [], depth + 1, options, budget, inForm || tag === "form");
    if (!ALLOWED_TAGS.has(tag) || nestedForm) {
      result.push(...children);
      continue;
    }
    const attributes = sanitizeAttributes(tag, (node as Element).attribs ?? {}, options);
    if (!attributes) {
      // An unsafe image, input or form: the element goes, its text stays.
      if (tag !== "img" && tag !== "input") result.push(...children);
      continue;
    }
    budget.elements += 1;
    if (budget.elements > PLUGIN_HTML_MAX_ELEMENTS) {
      budget.exceeded = true;
      break;
    }
    node.name = tag;
    (node as Element).attribs = attributes;
    node.children = children;
    for (const child of children) child.parent = node;
    result.push(node);
  }
  return result;
}

/**
 * Sanitizes one surface's HTML. `ok: false` means render nothing (and log
 * it for the merchant): the input or output is over its size bound, or the
 * markup is deeper or larger than a storefront surface may be.
 */
export function sanitizePluginHtml(html: string, options: PluginHtmlOptions): PluginHtmlResult {
  if (typeof html !== "string") return { ok: false, reason: "too_complex" };
  if (byteLength(html) > PLUGIN_HTML_MAX_INPUT_BYTES) return { ok: false, reason: "too_large" };
  const normalized = html.replace(/[\x00\u200B-\u200D\uFEFF]/g, "");
  const document = parseDocument(normalized, { decodeEntities: true, lowerCaseAttributeNames: true, lowerCaseTags: true });
  const budget = new Budget();
  const nodes = sanitizeNodes(document.children, 1, options, budget, false);
  if (budget.exceeded) return { ok: false, reason: "too_complex" };
  const output = DomUtils.getOuterHTML(nodes, { encodeEntities: "utf8" });
  if (byteLength(output) > PLUGIN_HTML_MAX_OUTPUT_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, html: output };
}
