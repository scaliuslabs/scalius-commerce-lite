// A theme's header or footer skin rebuilt for a buyer's own page (the account,
// the receipt, order tracking, warranty claims, the gift-card balance, the
// newsletter pages), where the skin declares `buyerPages: true`. It runs on
// markup the plugin sanitizer already checked (`sanitizePluginHtml`) and
// writes a new document from an allow-list. The storefront draws the result
// inside a declarative shadow root (apps/storefront PrivateChrome.astro), so
// the browser keeps the theme's selectors, ids, `popovertarget` and ARIA
// references inside it; this rebuild keeps everything that could act out of it:
// - no script, island (unwrapped: no app code loads), deferred script, style,
//   link, frame, object, media, template, slot or dialog; no form, field,
//   select, text area or label (each goes with its content), so nothing in the
//   chrome takes what a buyer types;
// - a button only as `type="button"`, and only with a host behaviour (the
//   store's light or dark switch, cart or search) or a `popovertarget` naming
//   one of the region's own popovers; any other button goes with its content;
// - nothing in the top layer: no `popover`, `popovertarget` or dialog. A
//   popover a kept button targets (a menu drawer, a dropdown) is lifted out of
//   the region whole, as a panel (`InertPanel`: its kind, `data-menu-drawer`
//   or `data-panel="drawer"` a drawer, else a menu) the store draws inside a
//   top-layer element of its own; the button that opened it opens the store's
//   panel instead (`data-buyer-panel-open`), and one that hid it closes it
//   (`data-buyer-panel-close`);
// - host behaviours only from a closed list (`INERT_BEHAVIOURS`), each on the
//   elements it belongs to; no other data attribute but the buyer UI's style
//   words; no handler, tab stop, access key, role description or live region
//   (but the cart count's `polite`);
// - `style` only as custom properties with plain values (`--logo-width:180px`):
//   nothing positions or sizes an element from markup;
// - a link only to a URL the skin was handed exactly as it was handed (its
//   data, the merchant's values: menus, social profiles, a review link), to a
//   clean browsing path of this store, or to a fragment; a link off the store
//   always `rel="noopener noreferrer"`, so the page's address never leaves it;
//   an image only from a source the page allows.
import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { STOREFRONT_ROUTE_SEGMENTS } from "../storefront-route-segments";
import { UNTRUSTED_HTML_PARSING, VOID_ELEMENTS, escapeHtmlText, untrustedHtml, writeStartTag } from "../html-writer";

export interface InertChromeOptions {
  /** Whether an image source may load on this page (same-origin paths and the page's allowed image origins). */
  imageAllowed(src: string): boolean;
  /** URLs the skin was handed (strings of its data and of the merchant's stored values): a link to one is kept as written. */
  links?: ReadonlySet<string>;
}

const KEEP = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "blockquote", "br", "button", "caption", "code", "dd", "del", "details",
  "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "i", "img", "ins", "li", "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "search", "section", "small", "source", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs",
]);
/** Gone with everything inside. */
const DROP = new Set([
  "script", "style", "link", "base", "meta", "iframe", "frame", "frameset", "object", "embed", "applet", "param", "template",
  "noscript", "video", "audio", "canvas", "math", "foreignobject", "use", "image", "portal", "form", "input", "select",
  "textarea", "option", "optgroup", "label", "datalist", "output", "fieldset", "dialog", "slot", "lineargradient",
  "radialgradient", "clippath", "mask", "pattern", "filter", "marker", "symbol", "animate", "animatemotion", "animatetransform", "set",
  "selectedcontent", "fencedframe",
]);
/** Gone, its content kept. */
const UNWRAP = new Set(["scalius-island", "scalius-deferred"]);

/**
 * The store's behaviours a skin's markup may keep (the SDK's helpers), each on
 * the elements it belongs to and, for one with words, with one of them. Each
 * asks the host to do a thing of its own: show the signed-in or guest version,
 * open its sign-in dialog, flip the colour scheme, open its cart or search, or
 * mark the menu drawer its phone tab bar opens. None reads or sends anything.
 */
export const INERT_BEHAVIOURS: Readonly<Record<string, { tags: readonly string[] | "any"; values?: readonly string[] }>> = {
  "data-scalius-when": { tags: "any", values: ["signed-in", "signed-out"] },
  "data-account-link": { tags: ["a"] },
  "data-color-scheme-toggle": { tags: ["button"] },
  "data-cart-open": { tags: ["a", "button"] },
  "data-search-open": { tags: ["a", "button"] },
  "data-menu-drawer": { tags: ["div", "nav", "aside", "section", "ul", "ol"] },
  "data-sticky-header": { tags: "any" },
  "data-scalius-cart-count": { tags: ["span"] },
};
/** The behaviours that keep a button: it does the store's thing. */
const BUTTON_BEHAVIOURS = ["data-color-scheme-toggle", "data-cart-open", "data-search-open"];

/** Attributes any element may carry. */
const GENERAL = new Set(["title", "hidden", "lang", "dir", "translate", "role", "aria-label", "aria-hidden", "aria-current", "aria-level"]);
/** ARIA attributes that name ids: the shadow root keeps each to the region's own. */
const ID_REFERENCES = new Set(["aria-labelledby", "aria-describedby", "aria-details", "aria-controls", "headers"]);
/**
 * Attributes whose value must be one of a list: the roles that only describe
 * structure (none announces a control or speaks over the page; `dialog` only
 * on the menu drawer), and the buyer UI's style words.
 */
const VALUES: Record<string, readonly string[]> = {
  role: ["none", "presentation", "img", "note", "group", "list", "listitem", "navigation", "banner", "contentinfo", "region", "figure", "separator", "heading", "term", "definition", "paragraph"],
  "aria-current": ["page", "step", "location", "date", "time", "true", "false"],
  "data-ui": ["banner", "badge", "text", "heading", "link", "image", "disclosure", "divider", "stack", "columns"],
  "data-tone": ["neutral", "info", "success", "warning", "critical"],
};
const BY_TAG: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "hreflang", "target"]),
  button: new Set(["aria-expanded", "aria-pressed"]),
  summary: new Set(["aria-expanded"]),
  img: new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding", "fetchpriority"]),
  source: new Set(["srcset", "sizes", "media", "type", "width", "height"]),
  details: new Set(["open", "name"]),
  ol: new Set(["start", "reversed", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope", "abbr"]),
  time: new Set(["datetime"]),
  span: new Set(["aria-live"]),
};
const SVG = new Set([
  "viewbox", "preserveaspectratio", "focusable", "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "stroke-opacity", "opacity",
  "vector-effect", "pathlength", "transform", "d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "xmlns",
]);
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs"]);

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CLASS_NAME = /^[^\s"'<>`=\\]{1,128}$/;
const names = (value: string, pattern: RegExp) => value.split(/\s+/).filter((name) => pattern.test(name)).join(" ");

/** A srcset candidate's descriptor: a width, a density or a height. */
const DESCRIPTOR = /^(?:\d+w|\d*\.?\d+(?:e[+-]?\d+)?x|\d+h)$/i;

/** Every candidate as the browser splits it (URL, then descriptors), each URL allowed and each descriptor one. */
function allowedSrcset(value: string, options: InertChromeOptions): boolean {
  return value.split(",").every((candidate) => {
    const [url = "", ...descriptors] = candidate.trim().split(/[\t\n\f\r ]+/);
    return url !== "" && options.imageAllowed(url) && !storeEndpoint(url) && descriptors.every((descriptor) => DESCRIPTOR.test(descriptor));
  });
}

/** Judged as the browser reads it: no control character or space (a browser strips some before parsing). */
const hasControl = (value: string) => [...value].some((character) => character <= "\u0020" || character === "\u007f");

/**
 * A browsing path of this store a theme's link may name without being handed
 * it: home, the catalogue (products, categories, collections, brands, search),
 * content (a page at a root slug no store route reserves, `/pages/…`, the blog)
 * and the buyer's own entry pages (the account, order tracking, the cart).
 * Never an action under them, a path that acts on a GET (`/buy/…`, the
 * preview's), an app's own page or file, or one that resolves off the store.
 */
export function storefrontBrowsingPath(path: string): boolean {
  if (hasControl(path) || !/^(?!.*\/\/)\/[^"<>\\#?]*(?:[?#][^"<>\\]*)?$/.test(path)) return false;
  if (new URL(path, "https://store.invalid").origin !== "https://store.invalid") return false;
  const segments = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || /%2e/i.test(segment) || /%2f|%5c/i.test(segment))) return false;
  if (segments.length === 0) return true;
  const first = segments[0]!.toLowerCase();
  if (segments.length === 1 && ["account", "track-order", "cart"].includes(first) && !/[?#]/.test(path)) return true;
  // A merchant's content page sits at a root slug no store route reserves (`/about`).
  if (segments.length === 1 && !STOREFRONT_ROUTE_SEGMENTS.has(first)) return true;
  return ["products", "categories", "collections", "brands", "pages", "blog", "search"].includes(first);
}

/** A handed URL kept as a link: a store path, https, mail or a phone number, as the plugin sanitizer allows. */
const HANDED_LINK = /^(?:https:\/\/[^/]|mailto:|tel:|\/(?![/\\]))/i;

function linkHref(value: string, options: InertChromeOptions): string | null {
  if (value === "#") return value;
  if (value.startsWith("#")) return NAME.test(value.slice(1)) ? value : null;
  if (options.links?.has(value) && HANDED_LINK.test(value) && !hasControl(value)) return value;
  return storefrontBrowsingPath(value) ? value : null;
}

/** A link that stays on the store's own pages: no `rel` needed to keep the page's address on it. */
const onStore = (href: string) => href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//"));

/** Custom properties a theme's sheet reads (`--logo-width: 180px`), with plain values: no string, escape, URL or loading function. */
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]{1,64}$/;
const PLAIN_VALUE = /^[A-Za-z0-9 .,%#()+*/-]{1,200}$/;
const LOADING = /(?:url|src|image|image-set|cross-fade|element|attr|paint)\s*\(/i;

function customProperties(style: string): string | null {
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const text = declaration.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    const name = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (CUSTOM_PROPERTY.test(name) && PLAIN_VALUE.test(value) && !LOADING.test(value)) kept.push(`${name}:${value}`);
  }
  return kept.length > 0 ? kept.join(";") : null;
}

const behaviourAllowed = (name: string, tag: string) => {
  const rule = INERT_BEHAVIOURS[name];
  return rule !== undefined && (rule.tags === "any" || rule.tags.includes(tag));
};

/** The elements a panel may be lifted from (a drawer, a dropdown panel, a list). */
const POPOVER_TAGS = new Set(["div", "nav", "aside", "section", "ul", "ol"]);

/** A theme's popover lifted out of its region: the store draws it in a top-layer element of its own. */
export interface InertPanel {
  /** A side sheet (`drawer`) or a panel under the button that opens it (`menu`). */
  kind: "drawer" | "menu";
  /** The theme's name for it (`aria-label`), or null. */
  label: string | null;
  /** The panel's own markup, rebuilt as the region's is. */
  html: string;
}

/** A region rebuilt: its markup, and the panels lifted out of it (in document order: `data-buyer-panel-open` names one by index). */
export interface InertChrome {
  html: string;
  panels: InertPanel[];
}

/**
 * The panels the markup holds: an element with `popover` and an id on one of
 * `POPOVER_TAGS` that a button of the same markup targets (`popovertarget`),
 * each with its index in document order.
 */
function panelIds(nodes: ChildNode[]): Map<string, number> {
  const declared: string[] = [];
  const targeted = new Set<string>();
  const visit = (list: ChildNode[]) => {
    for (const node of list) {
      if (!isTag(node)) continue;
      const tag = node.name.toLowerCase();
      if (DROP.has(tag)) continue;
      const id = node.attribs.id ?? "";
      if (POPOVER_TAGS.has(tag) && "popover" in node.attribs && NAME.test(id) && !declared.includes(id)) declared.push(id);
      if (tag === "button" && typeof node.attribs.popovertarget === "string") targeted.add(node.attribs.popovertarget);
      visit(UNWRAP.has(tag) ? node.children.flatMap((child) => isTag(child) && child.name.toLowerCase() === "template"
        ? ((child as Element & { content?: { children: ChildNode[] } }).content?.children ?? child.children) : [child]) : node.children);
    }
  };
  visit(nodes);
  return new Map(declared.filter((id) => targeted.has(id)).map((id, index) => [id, index]));
}

/** A same-store path under an app's proxy or the API (as the router decodes it): a request there reaches an app or acts, never draws a picture. */
function storeEndpoint(url: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  let path = url.split(/[?#]/)[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    return true;
  }
  return /^\/+(?:apps|api)(?:[/\\]|$)/i.test(path);
}

function attributes(tag: string, input: Record<string, string>, options: InertChromeOptions, panels: ReadonlyMap<string, number>): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  const has = (name: string) => Object.prototype.hasOwnProperty.call(input, name);
  if (tag === "button") {
    const panel = panels.get(input.popovertarget ?? "");
    if (panel === undefined && !BUTTON_BEHAVIOURS.some((name) => has(name))) return null;
    out.push(["type", "button"]);
    // The store's panel, never the theme's popover: a button that hid it closes it, any other opens it.
    if (panel !== undefined) out.push(input.popovertargetaction === "hide" ? ["data-buyer-panel-close", ""] : ["data-buyer-panel-open", String(panel)]);
  }
  const drawer = has("data-menu-drawer") && behaviourAllowed("data-menu-drawer", tag) && panels.has(input.id ?? "");
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    const value = String(rawValue ?? "");
    if (name === "type") continue;
    if (name === "class") {
      const kept = names(value, CLASS_NAME);
      if (kept) out.push([name, kept]);
      continue;
    }
    if (name === "id") {
      if (NAME.test(value)) out.push([name, value]);
      continue;
    }
    if (name === "style") {
      const kept = customProperties(value);
      if (kept) out.push([name, kept]);
      continue;
    }
    if (ID_REFERENCES.has(name)) {
      const kept = names(value, NAME);
      if (kept) out.push([name, kept]);
      continue;
    }
    // Nothing a theme styles is ever in the top layer: its panels are the store's (`InertPanel`).
    if (name === "popover" || name === "popovertarget" || name === "popovertargetaction" || name === "data-panel") continue;
    if (name in INERT_BEHAVIOURS) {
      if (name === "data-menu-drawer") {
        if (drawer) out.push([name, ""]);
        continue;
      }
      if (!behaviourAllowed(name, tag)) continue;
      const rule = INERT_BEHAVIOURS[name]!;
      if (rule.values) {
        if (rule.values.includes(value)) out.push([name, value]);
      } else out.push([name, ""]);
      continue;
    }
    if (name === "role") {
      const word = value.trim().toLowerCase();
      if (VALUES.role!.includes(word)) out.push([name, word]);
      continue;
    }
    if (VALUES[name]) {
      const word = value.trim().toLowerCase();
      if (VALUES[name].includes(word)) out.push([name, word]);
      continue;
    }
    if (name === "href") {
      if (tag !== "a") continue;
      const href = linkHref(value, options);
      if (href !== null) out.push([name, href]);
      continue;
    }
    if (name === "rel" || name === "target") continue; // written below, from the link kept
    if (name === "aria-expanded" || name === "aria-pressed") {
      if (BY_TAG[tag]?.has(name) && ["true", "false"].includes(value)) out.push([name, value]);
      continue;
    }
    if (name === "aria-live") {
      if (value === "polite" && has("data-scalius-cart-count")) out.push([name, value]);
      continue;
    }
    if (name === "src") {
      if (tag !== "img") continue;
      if (!options.imageAllowed(value) || storeEndpoint(value)) return null;
      out.push([name, value]);
      continue;
    }
    if (name === "srcset") {
      if (allowedSrcset(value, options)) out.push([name, value]);
      continue;
    }
    if (name === "name") {
      if (tag === "details" && NAME.test(value)) out.push([name, value]);
      continue;
    }
    if (SVG_TAGS.has(tag) && SVG.has(name)) {
      if (!/url\s*\(|javascript:/i.test(value)) out.push([name, value]);
      continue;
    }
    if (GENERAL.has(name) || BY_TAG[tag]?.has(name)) out.push([name, value]);
  }
  if (tag === "img" && !out.some(([name]) => name === "src")) return null;
  if (tag === "a") {
    const href = out.find(([name]) => name === "href")?.[1];
    if (href !== undefined && !onStore(href)) {
      if (input.target === "_blank") out.push(["target", "_blank"]);
      out.push(["rel", "noopener noreferrer"]);
    }
  }
  return out;
}

interface Rebuild {
  options: InertChromeOptions;
  panels: ReadonlyMap<string, number>;
  lifted: InertPanel[];
}

function walk(nodes: ChildNode[], rebuild: Rebuild, out: string[]): void {
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
      walk(children, rebuild, out);
      continue;
    }
    if (!KEEP.has(tag)) {
      walk(node.children, rebuild, out);
      continue;
    }
    const kept = attributes(tag, node.attribs, rebuild.options, rebuild.panels);
    if (!kept) continue;
    // A panel leaves the region whole: the store draws it in its own top-layer element.
    const panel = POPOVER_TAGS.has(tag) && "popover" in node.attribs ? rebuild.panels.get(node.attribs.id ?? "") : undefined;
    const target = panel === undefined ? out : [] as string[];
    target.push(writeStartTag(tag, kept));
    if (!VOID_ELEMENTS.has(tag)) {
      walk(node.children, rebuild, target);
      target.push(`</${tag}>`);
    }
    if (panel !== undefined) {
      const kind = "data-menu-drawer" in node.attribs || node.attribs["data-panel"] === "drawer" ? "drawer" : "menu";
      const label = (node.attribs["aria-label"] ?? "").trim().slice(0, 80) || null;
      rebuild.lifted[panel] = { kind, label, html: target.join("") };
    }
  }
}

/**
 * Everything the rebuild can emit, as data: its elements, the attributes any
 * of them may carry, those of one element, SVG's, and the attributes whose
 * value is one of a list.
 */
export const INERT_MARKUP = {
  tags: [...KEEP],
  attributes: [...GENERAL, "class", "id", "style", ...ID_REFERENCES, ...Object.keys(VALUES), ...Object.keys(INERT_BEHAVIOURS)],
  byTag: {
    ...Object.fromEntries(Object.entries(BY_TAG).map(([tag, list]) => [tag, [...list]])),
    // The store's panel behaviours the rebuild writes from a theme's `popovertarget` (never kept from markup).
    button: [...BY_TAG.button!, "type", "data-buyer-panel-open", "data-buyer-panel-close"],
    // The host's own state on a drawn page: the cart count marks itself empty (scripts/buyer-chrome.ts).
    span: [...BY_TAG.span!, "data-empty"],
  } as Record<string, string[]>,
  svgTags: [...SVG_TAGS],
  svg: [...SVG],
  values: { ...VALUES, type: ["button"], "aria-live": ["polite"], "data-scalius-when": ["signed-in", "signed-out"], "data-buyer-panel-close": [""] } as Record<string, readonly string[]>,
};

interface InertRegion {
  querySelectorAll(selector: string): ArrayLike<{ localName: string; attributes: ArrayLike<{ name: string; value: string }> }>;
}

/**
 * Why each element inside `root` is not one the rebuild could have written
 * ([] when every one is). Self-contained, so the rendered gate runs this very
 * function inside the page, on every shadow root the chrome draws.
 */
export function inertMarkupProblems(root: InertRegion, markup: typeof INERT_MARKUP): string[] {
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
 * The most markup one region rebuilds (UTF-8 bytes): a header with a full
 * category menu and its phone drawer is a few tens of KiB. A region rebuilds
 * once per isolate for the same markup (the storefront keeps it), and at the
 * bound within a few milliseconds of CPU (inert-html.test.ts measures it).
 * Larger markup is not rebuilt: the store draws its own chrome in its place.
 */
export const INERT_MARKUP_MAX_BYTES = 64 * 1024;

/**
 * Checked skin markup rebuilt with nothing left that runs, loads, frames,
 * posts, collects or acts outside it, its panels lifted out; null when it is
 * over `INERT_MARKUP_MAX_BYTES`.
 */
export function inertChrome(html: string, options: InertChromeOptions): InertChrome | null {
  if (html.length > INERT_MARKUP_MAX_BYTES / 3 && new TextEncoder().encode(html).byteLength > INERT_MARKUP_MAX_BYTES) return null;
  const document = parseDocument(untrustedHtml(html), { ...UNTRUSTED_HTML_PARSING, recognizeSelfClosing: true });
  const rebuild: Rebuild = { options, panels: panelIds(document.children), lifted: [] };
  const out: string[] = [];
  walk(document.children, rebuild, out);
  return { html: out.join(""), panels: rebuild.lifted.filter(Boolean) };
}

/** The region's own markup alone (its panels left out), or null over the bound. */
export function inertChromeHtml(html: string, options: InertChromeOptions): string | null {
  return inertChrome(html, options)?.html ?? null;
}
