// An app skin's markup rebuilt for a buyer's private page (the theme's header
// and footer there, `privatePages.chrome: theme`). It runs on markup the
// plugin sanitizer already checked (`sanitizePluginHtml`) and writes a new
// document from an allow-list, so nothing a skin draws there can run, load,
// frame, post, collect, cover, impersonate or steer anything:
// - elements: text, lists, links, images, disclosure (`details`), tables and
//   SVG drawing only. No button: nothing inert is a control, so a skin's
//   buttons go with their content;
// - forms: none. Every form, field, select, text area and label goes with
//   its content, so nothing here takes what a buyer types; the store's own
//   search sits beside the region where the theme places it
//   (`privatePages.search`, the header's `PrivateSearch`), never inside it;
// - islands are unwrapped (no app script loads), deferred markup is drawn in
//   place, and script, style, link, base, meta, frames, objects, embeds,
//   media, dialogs and templates go with their content;
// - attributes: an allow-list, each with no meaning to the host. No `style`,
//   event handler, `popover`, `tabindex`, form action or URL reference in SVG,
//   and no host behaviour: none of the store's chrome attributes (the colour
//   scheme switch, the account link, signed-in versions), so nothing in a
//   region triggers a host action or makes a host part yield. Class names and
//   ids are the region's own (`tc-<name>`), as are the ids ARIA attributes
//   name; the only data attributes are the buyer UI's style words (`data-ui`,
//   `data-tone`), each from a fixed list; roles and ARIA attributes only from
//   their lists (no live region, alert, modal, control or role description).
//   A link keeps an href only to a clean path on this store (no `//`, no dot
//   segment) or to one of the region's own ids; an image only a source the
//   page allows.
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
  "a", "abbr", "article", "aside", "b", "bdi", "blockquote", "br", "caption", "code", "dd", "del", "details",
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
  "button",
]);
/** Gone, its content kept. */
const UNWRAP = new Set(["scalius-island", "scalius-deferred"]);

/** Attributes any element may carry. */
const GENERAL = new Set(["title", "hidden", "lang", "dir", "translate", "role", "aria-label", "aria-hidden", "aria-current", "aria-level"]);
/** ARIA attributes that name ids: each id is the region's own. */
const ID_REFERENCES = new Set(["aria-labelledby", "aria-describedby", "aria-details", "headers"]);
/**
 * Attributes whose value must be one of a list: the roles that only describe
 * structure (none announces a control, speaks over the page or poses as a
 * dialog), and the buyer UI's style words (the theme's content blocks carry
 * them, so one stylesheet styles both). None is read by a host script.
 */
const VALUES: Record<string, readonly string[]> = {
  role: ["none", "presentation", "img", "note", "group", "list", "listitem", "navigation", "figure", "separator", "heading", "term", "definition", "paragraph"],
  "data-ui": ["banner", "badge", "text", "heading", "link", "image", "disclosure", "divider", "stack", "columns"],
  "data-tone": ["neutral", "info", "success", "warning", "critical"],
};
const BY_TAG: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "hreflang"]),
  img: new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding", "fetchpriority"]),
  source: new Set(["srcset", "sizes", "media", "type", "width", "height"]),
  details: new Set(["open"]),
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

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const own = (name: string) => `${CHROME_NAME_PREFIX}${name}`;
const ownList = (value: string) => value.split(/\s+/).filter((name) => NAME.test(name)).map(own).join(" ");

/** A srcset candidate's descriptor: a width, a density or a height. */
const DESCRIPTOR = /^(?:\d+w|\d*\.?\d+(?:e[+-]?\d+)?x|\d+h)$/i;

/** Every candidate as the browser splits it (URL, then descriptors), each URL allowed and each descriptor one. */
function allowedSrcset(value: string, options: InertChromeOptions): boolean {
  return value.split(",").every((candidate) => {
    const [url = "", ...descriptors] = candidate.trim().split(/[\t\n\f\r ]+/);
    return url !== "" && options.imageAllowed(url) && descriptors.every((descriptor) => DESCRIPTOR.test(descriptor));
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
    if (VALUES[name]) {
      const word = value.trim().toLowerCase();
      if (VALUES[name].includes(word)) out.push([name, word]);
      continue;
    }
    if (name === "href") {
      if (tag !== "a") continue;
      if (value.startsWith("#")) { if (NAME.test(value.slice(1))) out.push([name, `#${own(value.slice(1))}`]); continue; }
      if (storefrontBrowsingPath(value)) out.push([name, value]);
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
    if (SVG_TAGS.has(tag) && SVG.has(name)) {
      if (!/url\s*\(|javascript:/i.test(value)) out.push([name, value]);
      continue;
    }
    if (GENERAL.has(name) || BY_TAG[tag]?.has(name)) out.push([name, value]);
  }
  if (tag === "img" && !out.some(([name]) => name === "src")) return null;
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

/**
 * Everything the rebuild can emit, as data: its elements, the attributes any
 * of them may carry, those of one element, SVG's, and the attributes whose
 * value is one of a list. The host's content blocks draw from the same words.
 */
export const INERT_MARKUP = {
  tags: [...KEEP],
  attributes: [...GENERAL, "class", "id", ...ID_REFERENCES, ...Object.keys(VALUES)],
  byTag: Object.fromEntries(Object.entries(BY_TAG).map(([tag, names]) => [tag, [...names]])) as Record<string, string[]>,
  svgTags: [...SVG_TAGS],
  svg: [...SVG],
  values: VALUES as Record<string, string[]>,
};

/**
 * Why each element inside `root` is not one the rebuild could have written
 * ([] when every one is). Self-contained, so the rendered gate runs this very
 * function inside the page, on every free region it draws.
 */
export function inertMarkupProblems(root: { querySelectorAll(selector: string): ArrayLike<{ localName: string; attributes: ArrayLike<{ name: string; value: string }> }> }, markup: typeof INERT_MARKUP): string[] {
  const problems: string[] = [];
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tag = element.localName.toLowerCase();
    if (!markup.tags.includes(tag)) {
      problems.push(`<${tag}>: an element the inert markup never draws`);
      continue;
    }
    for (const { name: raw, value } of Array.from(element.attributes)) {
      const name = raw.toLowerCase();
      const known = markup.attributes.includes(name) || (markup.byTag[tag] ?? []).includes(name) || (markup.svgTags.includes(tag) && markup.svg.includes(name));
      if (!known) problems.push(`<${tag} ${name}>: an attribute the inert markup never draws`);
      else if (markup.values[name] && !markup.values[name].includes(value)) problems.push(`<${tag} ${name}="${value}">: a value the inert markup never draws`);
    }
  }
  return problems;
}

/**
 * The most markup one region rebuilds (UTF-8 bytes). Its rebuild then stays
 * within about 2 ms of CPU on a Worker (inert-html.test.ts measures it), so a
 * private page with a header and a footer keeps inside Workers Free's 10 ms;
 * a real header is a few KiB. Larger markup is not rebuilt: the store draws
 * its own chrome in its place.
 */
export const INERT_MARKUP_MAX_BYTES = 16 * 1024;

/** Checked skin markup rebuilt with nothing left that runs, loads, frames, posts, collects or shadows the page; null when it is over `INERT_MARKUP_MAX_BYTES`. */
export function inertChromeHtml(html: string, options: InertChromeOptions): string | null {
  if (html.length > INERT_MARKUP_MAX_BYTES / 3 && new TextEncoder().encode(html).byteLength > INERT_MARKUP_MAX_BYTES) return null;
  const out: string[] = [];
  walk(parseDocument(untrustedHtml(html), { ...UNTRUSTED_HTML_PARSING, recognizeSelfClosing: true }).children, options, out);
  return out.join("");
}
