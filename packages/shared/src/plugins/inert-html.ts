// An app skin's markup made inert for a buyer's private page (the theme's
// header and footer there, `privatePages.chrome: theme`). It runs on markup
// the plugin sanitizer already checked (`sanitizePluginHtml`), and is an
// allow-list of its own, so nothing a skin draws there can run, load, frame,
// post or collect anything:
// - elements: text, lists, links, images, disclosure (`details`), tables and
//   SVG drawing only; a button only as `type="button"` (the store's
//   attribute behaviours, such as the menu drawer, run it);
// - forms: none, except one GET search form to the store's search path,
//   holding a search field, hidden fields and a submit button. Every other
//   form, field, select, text area and label goes with its content, so no
//   form can take what a buyer types and no app form token is ever written;
// - islands are unwrapped (no app script loads), deferred markup is drawn in
//   place, and script, style, link, base, meta, frames, objects, embeds,
//   media and templates go with their content;
// - attributes: presentation and accessibility only. A link keeps an href
//   only to a path on this store; an image only a source the page allows;
//   no event handler, `formaction`, `srcdoc`, `xlink:href`, app runtime or
//   form-owner attribute, and no style that names a URL.
import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { UNTRUSTED_HTML_PARSING, VOID_ELEMENTS, escapeHtmlText, untrustedHtml, writeStartTag } from "../html-writer";
import { APP_FORM_OWNER_ATTRIBUTE } from "./app-form";

export interface InertChromeOptions {
  /** The store's search path (`/search`): the one form a skin may keep. */
  searchAction: string;
  /** Whether an image source may load on this page (same-origin paths and the page's allowed image origins). */
  imageAllowed(src: string): boolean;
}

const KEEP = new Set([
  "a", "abbr", "article", "aside", "b", "bdi", "blockquote", "br", "button", "caption", "code", "dd", "del", "details",
  "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "i", "img", "ins", "li", "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "section", "small", "source", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs", "lineargradient", "radialgradient", "stop", "clippath",
]);
/** Gone with everything inside. */
const DROP = new Set([
  "script", "style", "link", "base", "meta", "iframe", "frame", "frameset", "object", "embed", "applet", "param", "template",
  "noscript", "video", "audio", "canvas", "math", "foreignobject", "use", "image", "portal", "form", "input", "select",
  "textarea", "option", "optgroup", "label", "datalist", "output", "fieldset", "dialog", "slot",
]);
/** Gone, its content kept. */
const UNWRAP = new Set(["scalius-island", "scalius-deferred"]);

const GENERAL = new Set(["class", "id", "role", "title", "hidden", "lang", "dir", "tabindex", "popover", "popovertarget", "popovertargetaction", "translate"]);
const BY_TAG: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "hreflang"]),
  img: new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding", "fetchpriority"]),
  source: new Set(["srcset", "sizes", "media", "type", "width", "height"]),
  details: new Set(["open"]),
  button: new Set(["type", "disabled"]),
  ol: new Set(["start", "reversed", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope", "abbr"]),
  time: new Set(["datetime"]),
};
const SVG = new Set([
  "viewbox", "preserveaspectratio", "focusable", "fill", "fill-opacity", "fill-rule", "clip-rule", "clip-path", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "stroke-opacity", "opacity",
  "vector-effect", "pathlength", "transform", "d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "fx", "fy", "spreadmethod", "clippathunits", "xmlns",
]);
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs", "lineargradient", "radialgradient", "stop", "clippath"]);
/** Attributes the app runtime or the form gateway read: never on a private page. */
const RUNTIME_DATA = /^data-(?:sx-|island$|props$|hydrate$)/;

/** A path on this store (not `//host`), or a fragment. */
const storePath = (href: string) => /^(?:\/(?![/\\])|#)[^\s"<>\\]*$/.test(href);

function allowedSrcset(value: string, options: InertChromeOptions): boolean {
  return value.split(",").every((candidate) => {
    const url = candidate.trim().split(/\s+/)[0] ?? "";
    return url !== "" && options.imageAllowed(url);
  });
}

function attributes(tag: string, input: Record<string, string>, options: InertChromeOptions, inSearch: boolean): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    const value = String(rawValue ?? "");
    if (name.startsWith("on") || name === APP_FORM_OWNER_ATTRIBUTE || RUNTIME_DATA.test(name)) continue;
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
    if (name === "style") {
      if (!/url\s*\(|\\|expression|image|@/i.test(value)) out.push([name, value]);
      continue;
    }
    if (tag === "button" && name === "type") {
      out.push([name, inSearch && value === "submit" ? "submit" : "button"]);
      continue;
    }
    if (GENERAL.has(name) || name.startsWith("aria-") || name.startsWith("data-") || BY_TAG[tag]?.has(name) || (SVG_TAGS.has(tag) && SVG.has(name))) {
      out.push([name, value]);
    }
  }
  if (tag === "img" && !out.some(([name]) => name === "src")) return null;
  if (tag === "button" && !out.some(([name]) => name === "type")) out.push(["type", "button"]);
  return out;
}

/** The one search form a skin may keep: GET to the store's search path, holding only search, hidden and submit controls. */
function searchForm(node: Element, options: InertChromeOptions, out: string[]): boolean {
  const method = (node.attribs.method ?? "get").toLowerCase();
  if (method !== "get" || node.attribs.action !== options.searchAction) return false;
  out.push(writeStartTag("form", [["action", options.searchAction], ["method", "get"], ["role", "search"]]));
  const walkSearch = (nodes: ChildNode[]) => {
    for (const child of nodes) {
      if (isText(child)) { out.push(escapeHtmlText(child.data)); continue; }
      if (!isTag(child)) continue;
      const tag = child.name.toLowerCase();
      if (tag === "input") {
        const type = (child.attribs.type ?? "text").toLowerCase();
        if (!["search", "text", "hidden"].includes(type)) continue;
        const kept: Array<[string, string]> = [["type", type]];
        for (const name of ["name", "value", "placeholder", "aria-label", "autocomplete", "enterkeyhint", "inputmode", "class", "id"]) {
          const value = child.attribs[name];
          if (value !== undefined) kept.push([name, value]);
        }
        out.push(writeStartTag("input", kept));
        continue;
      }
      if (tag === "form" || DROP.has(tag)) continue;
      walk([child], options, out, true);
    }
  };
  walkSearch(node.children);
  out.push("</form>");
  return true;
}

function walk(nodes: ChildNode[], options: InertChromeOptions, out: string[], inSearch: boolean, searchUsed = { value: false }): void {
  for (const node of nodes) {
    if (isText(node)) { out.push(escapeHtmlText(node.data)); continue; }
    if (!isTag(node)) continue;
    const tag = node.name.toLowerCase();
    if (tag === "form" && !inSearch && !searchUsed.value && searchForm(node, options, out)) { searchUsed.value = true; continue; }
    if (DROP.has(tag)) continue;
    if (UNWRAP.has(tag)) {
      // Deferred markup's one child is its template: drawn in place here.
      const children = node.children.flatMap((child) => isTag(child) && child.name.toLowerCase() === "template"
        ? ((child as Element & { content?: { children: ChildNode[] } }).content?.children ?? child.children)
        : [child]);
      walk(children, options, out, inSearch, searchUsed);
      continue;
    }
    if (!KEEP.has(tag)) {
      walk(node.children, options, out, inSearch, searchUsed);
      continue;
    }
    const kept = attributes(tag, node.attribs, options, inSearch);
    if (!kept) continue;
    out.push(writeStartTag(tag, kept));
    if (VOID_ELEMENTS.has(tag)) continue;
    walk(node.children, options, out, inSearch, searchUsed);
    out.push(`</${tag}>`);
  }
}

/** Checked skin markup with nothing left that runs, loads, frames, posts or collects. */
export function inertChromeHtml(html: string, options: InertChromeOptions): string {
  const out: string[] = [];
  walk(parseDocument(untrustedHtml(html), { ...UNTRUSTED_HTML_PARSING, recognizeSelfClosing: true }).children, options, out, false);
  return out.join("");
}
