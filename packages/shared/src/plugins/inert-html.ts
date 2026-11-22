// An app skin's markup rebuilt for a buyer's private page (the theme's header
// and footer there, `privatePages.chrome: theme`). It runs on markup the
// plugin sanitizer already checked (`sanitizePluginHtml`) and writes a new
// document from an allow-list, so nothing a skin draws there can run, load,
// frame, post, collect, cover or impersonate anything:
// - elements: text, lists, links, images, disclosure (`details`), tables and
//   SVG drawing only; a button only as `type="button"`;
// - forms: none but one search form the host builds from the skin's intent
//   (its first GET form to the store's search path): GET to that path, one
//   search field named the store's query parameter, in the store's words,
//   and at most one submit. Every other form, field, select, text area and
//   label goes with its content, so no form here takes what a buyer types;
// - islands are unwrapped (no app script loads), deferred markup is drawn in
//   place, and script, style, link, base, meta, frames, objects, embeds,
//   media, dialogs and templates go with their content;
// - attributes: no `style`, event handler, `popover`, form action or URL
//   reference in SVG; class names and ids are the region's own
//   (`tc-<name>`), as are the ids ARIA attributes name, so chrome never
//   shares a class with the store's CSS or an id with a host element; the
//   only data attributes are the store's chrome behaviours (signed-in
//   versions, the colour scheme switch, the account link). A link keeps an
//   href only to a path on this store; an image only a source the page allows.
// The host draws the result inside a sealed free region (`data-free`).
import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { UNTRUSTED_HTML_PARSING, VOID_ELEMENTS, escapeHtmlText, untrustedHtml, writeStartTag } from "../html-writer";

export interface InertChromeOptions {
  /** The store's search path (`/search`): the one form a skin may keep. */
  searchAction: string;
  /** The store's search query parameter (`q`): the search field's name. */
  searchParam: string;
  /** The store's word for search, in the page's language: the field's and the button's name. */
  searchLabel: string;
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

/** A path on this store (not `//host`), or a fragment. */
const storePath = (href: string) => /^(?:\/(?![/\\])|#)[^\s"<>\\]*$/.test(href);

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
      if (tag === "a" && storePath(value)) out.push([name, value]);
      continue;
    }
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

const SEARCH_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>';

function* elements(nodes: readonly ChildNode[]): Generator<Element> {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    yield node;
    yield* elements(node.children);
  }
}

/**
 * The one search form, built by the host from the skin's: GET to the store's
 * search path, one search field named the query parameter and at most one
 * submit, both in the store's words; the skin keeps only its class names.
 */
function searchForm(node: Element, options: InertChromeOptions): string | null {
  const method = (node.attribs.method ?? "get").toLowerCase();
  if (method !== "get" || node.attribs.action !== options.searchAction) return null;
  const all = [...elements(node.children)];
  const field = all.find((child) => child.name.toLowerCase() === "input" && ["search", "text", ""].includes((child.attribs.type ?? "").toLowerCase()));
  if (!field) return null;
  const submit = all.find((child) => (child.name.toLowerCase() === "button" && (child.attribs.type ?? "submit").toLowerCase() === "submit")
    || (child.name.toLowerCase() === "input" && (child.attribs.type ?? "").toLowerCase() === "submit"));
  const classOf = (element: Element): Array<[string, string]> => {
    const names = ownList(element.attribs.class ?? "");
    return names ? [["class", names]] : [];
  };
  const label = options.searchLabel;
  let out = writeStartTag("form", [["action", options.searchAction], ["method", "get"], ["role", "search"], ...classOf(node)]);
  out += writeStartTag("input", [["type", "search"], ["name", options.searchParam], ["aria-label", label], ["placeholder", label], ["autocomplete", "off"], ["enterkeyhint", "search"], ...classOf(field)]);
  if (submit) out += `${writeStartTag("button", [["type", "submit"], ["aria-label", label], ...classOf(submit)])}${SEARCH_ICON}</button>`;
  return `${out}</form>`;
}

function walk(nodes: ChildNode[], options: InertChromeOptions, out: string[], search: { used: boolean }): void {
  for (const node of nodes) {
    if (isText(node)) { out.push(escapeHtmlText(node.data)); continue; }
    if (!isTag(node)) continue;
    const tag = node.name.toLowerCase();
    if (tag === "form" && !search.used) {
      const form = searchForm(node, options);
      if (form) { out.push(form); search.used = true; }
      continue;
    }
    if (DROP.has(tag)) continue;
    if (UNWRAP.has(tag)) {
      // Deferred markup's one child is its template: drawn in place here.
      const children = node.children.flatMap((child) => isTag(child) && child.name.toLowerCase() === "template"
        ? ((child as Element & { content?: { children: ChildNode[] } }).content?.children ?? child.children)
        : [child]);
      walk(children, options, out, search);
      continue;
    }
    if (!KEEP.has(tag)) {
      walk(node.children, options, out, search);
      continue;
    }
    const kept = attributes(tag, node.attribs, options);
    if (!kept) continue;
    out.push(writeStartTag(tag, kept));
    if (VOID_ELEMENTS.has(tag)) continue;
    walk(node.children, options, out, search);
    out.push(`</${tag}>`);
  }
}

/** Checked skin markup rebuilt with nothing left that runs, loads, frames, posts, collects or shadows the page. */
export function inertChromeHtml(html: string, options: InertChromeOptions): string {
  const out: string[] = [];
  walk(parseDocument(untrustedHtml(html), { ...UNTRUSTED_HTML_PARSING, recognizeSelfClosing: true }).children, options, out, { used: false });
  return out.join("");
}
