// An app skin's markup rebuilt for a buyer's private page (the theme's header
// and footer there, `privatePages.chrome: theme`). It runs on markup the
// plugin sanitizer already checked (`sanitizePluginHtml`) and writes a new
// document from an allow-list, so nothing a skin draws there can run, load,
// frame, post, collect, cover or impersonate anything:
// - elements: text, lists, links, images, disclosure (`details`), tables and
//   SVG drawing only; a button only as `type="button"`;
// - forms: none. Every form, field, select, text area and label goes with
//   its content, so nothing here takes what a buyer types; the store's own
//   search sits beside the region where the theme places it
//   (`privatePages.search`, the header's `PrivateSearch`), never inside it;
// - islands are unwrapped (no app script loads), deferred markup is drawn in
//   place, and script, style, link, base, meta, frames, objects, embeds,
//   media, dialogs and templates go with their content;
// - attributes: no `style`, event handler, `popover`, form action or URL
//   reference in SVG; class names and ids are the region's own
//   (`tc-<name>`), as are the ids ARIA attributes name, so chrome never
//   shares a class with the store's CSS or an id with a host element; the
//   only data attributes are the store's chrome behaviours (signed-in
//   versions, the colour scheme switch, the account link); no live region,
//   alert or modal role. A link keeps an href only to a clean path on this
//   store (no `//`, no dot segment) or to one of the region's own ids; an
//   image only a source the page allows.
// The host draws the result inside a sealed free region (`data-free`).
import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { storefrontBrowsingPath } from "../storefront-routes";
import { UNTRUSTED_HTML_PARSING, VOID_ELEMENTS, escapeHtmlText, untrustedHtml, writeStartTag } from "../html-writer";

export interface InertChromeOptions {
  /** Whether an image source may load on this page (same-origin paths and the page's allowed image origins). */
  imageAllowed(src: string): boolean;
}

/** A region's own class names and ids (private-css.ts writes the stylesheet's the same way). */
export const CHROME_NAME_PREFIX = "tc-";

const KEEP = new Set([
  "a", "abbr", "article", "aside", "b", "bdi", "blockquote", "br", "button", "caption", "code", "dd", "del", "details",
  "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "i", "img", "ins", "li", "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "section", "small", "source", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs",
]);
/** Gone with everything inside. */
const DROP = new Set([
  "script", "style", "link", "base", "meta", "iframe", "frame", "frameset", "object", "embed", "applet", "param", "template",
  "noscript", "video", "audio", "canvas", "math", "foreignobject", "use", "image", "portal", "form", "input", "select",
  "textarea", "option", "optgroup", "label", "datalist", "output", "fieldset", "dialog", "slot", "lineargradient",
  "radialgradient", "clippath", "mask", "pattern", "filter", "marker", "symbol", "animate", "animatemotion", "animatetransform", "set",
]);
/** Gone, its content kept. */
const UNWRAP = new Set(["scalius-island", "scalius-deferred"]);

const GENERAL = new Set(["role", "title", "hidden", "lang", "dir", "translate"]);
/** Roles that would speak over the page or pose as one of its dialogs. */
const LOUD_ROLES = new Set(["dialog", "alertdialog", "alert", "status", "log", "marquee", "timer"]);
const LOUD_ARIA = new Set(["aria-modal", "aria-live", "aria-atomic", "aria-relevant", "aria-busy"]);
const BY_TAG: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "hreflang"]),
  img: new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding", "fetchpriority"]),
  source: new Set(["srcset", "sizes", "media", "type", "width", "height"]),
  details: new Set(["open"]),
  button: new Set(["disabled"]),
  ol: new Set(["start", "reversed", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope", "abbr"]),
  time: new Set(["datetime"]),
};
const SVG = new Set([
  "viewbox", "preserveaspectratio", "focusable", "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "stroke-opacity", "opacity",
  "vector-effect", "pathlength", "transform", "d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "xmlns",
]);
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs"]);
/** ARIA attributes that name ids: each id is the region's own. */
const ID_REFERENCES = new Set(["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-details", "aria-errormessage", "aria-flowto", "headers"]);
/** The store's chrome behaviours a skin may mark (plugin-sdk `whenSignedIn`, `colorSchemeToggle`, `accountLink`). */
const BEHAVIOURS: Record<string, (tag: string, value: string) => boolean> = {
  "data-scalius-when": (_tag, value) => value === "signed-in" || value === "signed-out",
  "data-color-scheme-toggle": (tag) => tag === "button",
  "data-account-link": (tag) => tag === "a",
};

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const own = (name: string) => `${CHROME_NAME_PREFIX}${name}`;
const ownList = (value: string) => value.split(/\s+/).filter((name) => NAME.test(name)).map(own).join(" ");

/** A clean path on this store: one leading slash, no `//` anywhere, no dot segment, nothing a browser would rewrite. */
const storePath = (href: string) => /^(?!.*\/\/)\/[^\s"<>\\#]*(?:#[^\s"<>\\]*)?$/.test(href)
  && !href.split(/[?#]/)[0]!.split("/").some((segment) => segment === "." || segment === ".." || /^%2e/i.test(segment));

function allowedSrcset(value: string, options: InertChromeOptions): boolean {
  return value.split(",").every((candidate) => {
    const url = candidate.trim().split(/\s+/)[0] ?? "";
    return url !== "" && options.imageAllowed(url);
  });
}

function attributes(tag: string, input: Record<string, string>, options: InertChromeOptions): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    const value = String(rawValue ?? "");
    if (name === "class") {
      const names = ownList(value);
      if (names) out.push([name, names]);
      continue;
    }
    if (name === "id") {
      if (NAME.test(value)) out.push([name, own(value)]);
      continue;
    }
    if (ID_REFERENCES.has(name)) {
      const names = ownList(value);
      if (names) out.push([name, names]);
      continue;
    }
    if (name.startsWith("data-")) {
      if (BEHAVIOURS[name]?.(tag, value)) out.push([name, value]);
      continue;
    }
    if (name === "href") {
      if (tag !== "a") continue;
      if (value.startsWith("#")) { if (NAME.test(value.slice(1))) out.push([name, `#${own(value.slice(1))}`]); continue; }
      if (storePath(value) && storefrontBrowsingPath(value)) out.push([name, value]);
      continue;
    }
    if (LOUD_ARIA.has(name) || (name === "role" && LOUD_ROLES.has(value.trim().toLowerCase()))) continue;
    if (name === "src") {
      if (tag !== "img") continue;
      if (!options.imageAllowed(value)) return null;
      out.push([name, value]);
      continue;
    }
    if (name === "srcset") {
      if (allowedSrcset(value, options)) out.push([name, value]);
      continue;
    }
    if (name === "tabindex") {
      if (value === "0" || value === "-1") out.push([name, value]);
      continue;
    }
    if (SVG_TAGS.has(tag) && SVG.has(name)) {
      if (!/url\s*\(|javascript:/i.test(value)) out.push([name, value]);
      continue;
    }
    if (GENERAL.has(name) || (name.startsWith("aria-") && /^aria-[a-z]+$/.test(name)) || BY_TAG[tag]?.has(name)) out.push([name, value]);
  }
  if (tag === "img" && !out.some(([name]) => name === "src")) return null;
  if (tag === "button") out.push(["type", "button"]);
  return out;
}

function walk(nodes: ChildNode[], options: InertChromeOptions, out: string[]): void {
  for (const node of nodes) {
    if (isText(node)) { out.push(escapeHtmlText(node.data)); continue; }
    if (!isTag(node)) continue;
    const tag = node.name.toLowerCase();
    if (DROP.has(tag)) continue;
    if (UNWRAP.has(tag)) {
      // Deferred markup's one child is its template: drawn in place here.
      const children = node.children.flatMap((child) => isTag(child) && child.name.toLowerCase() === "template"
        ? ((child as Element & { content?: { children: ChildNode[] } }).content?.children ?? child.children)
        : [child]);
      walk(children, options, out);
      continue;
    }
    if (!KEEP.has(tag)) {
      walk(node.children, options, out);
      continue;
    }
    const kept = attributes(tag, node.attribs, options);
    if (!kept) continue;
    out.push(writeStartTag(tag, kept));
    if (VOID_ELEMENTS.has(tag)) continue;
    walk(node.children, options, out);
    out.push(`</${tag}>`);
  }
}

/** Checked skin markup rebuilt with nothing left that runs, loads, frames, posts, collects or shadows the page. */
export function inertChromeHtml(html: string, options: InertChromeOptions): string {
  const out: string[] = [];
  walk(parseDocument(untrustedHtml(html), { ...UNTRUSTED_HTML_PARSING, recognizeSelfClosing: true }).children, options, out);
  return out.join("");
}
