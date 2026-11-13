import { parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode } from "domhandler";
import { RAW_TEXT_ELEMENTS, VOID_ELEMENTS, escapeHtmlText, parseUntrustedHtml, writeStartTag } from "./html-writer";
import { normalizeVideoEmbed } from "./video-embed";

declare const SAFE_HTML: unique symbol;

/**
 * HTML written by `sanitizeHtml`: the only HTML a page inserts unescaped
 * (`set:html`, `dangerouslySetInnerHTML`, the editor's content). Only this
 * module brands a string as `SafeHtml`.
 */
export type SafeHtml = string & { readonly [SAFE_HTML]: true };

const ALLOWED_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "button", "caption", "code", "col", "colgroup", "dd",
  "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "img", "ins", "li", "main", "mark", "nav", "ol", "p", "picture", "pre", "s", "section",
  "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul",
]);

/**
 * Dropped with everything inside them: raw text (never unwrapped, or its
 * decoded text would come out as markup), foreign content, and elements that
 * load or run something. A video `iframe` is the one raw-text element kept,
 * written empty.
 */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  ...RAW_TEXT_ELEMENTS, "applet", "base", "embed", "frame", "frameset", "head", "link", "math", "meta", "object",
  "param", "portal", "svg",
]);

/**
 * What the dashboard editor writes (TipTap: links, lists, tables with column
 * widths, aligned paragraphs and headings, sized images, video embeds), and
 * nothing that lets copy cover the page or clobber its globals: no `id`, no
 * `name`, no event handler, no class or data attribute storefront code acts on.
 */
const GLOBAL_ATTRIBUTES = new Set(["class", "dir", "lang", "style", "title"]);
const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "rel", "target"]),
  button: new Set(["disabled", "type"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span"]),
  details: new Set(["open"]),
  div: new Set(["data-video-provider"]),
  img: new Set(["alt", "decoding", "fetchpriority", "height", "loading", "sizes", "src", "srcset", "width"]),
  ol: new Set(["reversed", "start", "type"]),
  source: new Set(["height", "media", "sizes", "src", "srcset", "type", "width"]),
  td: new Set(["colspan", "data-colwidth", "rowspan"]),
  th: new Set(["colspan", "data-colwidth", "rowspan", "scope"]),
};
/** Classes the editor writes; any other class is left out. */
const ALLOWED_CLASSES = new Set(["list-decimal", "list-disc", "ps-5", "rich-video-embed", "text-primary", "underline"]);
const ARIA_ATTRIBUTE = /^aria-[a-z]{2,24}$/;
const BOOLEAN_ATTRIBUTES = new Set(["disabled", "open", "reversed"]);
const ENUMERATED: Readonly<Record<string, ReadonlySet<string>>> = {
  decoding: new Set(["async", "auto", "sync"]),
  dir: new Set(["auto", "ltr", "rtl"]),
  fetchpriority: new Set(["auto", "high", "low"]),
  loading: new Set(["eager", "lazy"]),
  scope: new Set(["col", "colgroup", "row", "rowgroup"]),
  target: new Set(["_blank", "_parent", "_self", "_top"]),
  "data-video-provider": new Set(["vimeo", "youtube"]),
};
const NUMBER_ATTRIBUTES = new Set(["colspan", "height", "rowspan", "span", "start", "width"]);
const URL_ATTRIBUTES = new Set(["href", "src"]);
const IMAGE_URL_TAGS = new Set(["img", "source"]);
const ALLOWED_BUTTON_TYPES = new Set(["button", "reset", "submit"]);
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MAX_ATTRIBUTE_VALUE = 4_000;

/** Inline style: the declarations the editor writes, with plain values only (no `url()`, no function, no `position`). */
const LENGTH = String.raw`(?:0|\d{1,5}(?:\.\d{1,4})?(?:px|%|rem|em))`;
const STYLE_VALUES: Readonly<Record<string, RegExp>> = {
  "text-align": /^(?:left|right|center|justify|start|end)$/,
  width: new RegExp(`^(?:auto|${LENGTH})$`),
  "min-width": new RegExp(`^${LENGTH}$`),
  "max-width": new RegExp(`^(?:none|${LENGTH})$`),
  height: new RegExp(`^(?:auto|${LENGTH})$`),
  "margin-left": new RegExp(`^(?:auto|${LENGTH})$`),
  "margin-right": new RegExp(`^(?:auto|${LENGTH})$`),
  display: /^(?:block|inline|inline-block)$/,
  "border-radius": new RegExp(`^${LENGTH}$`),
};

const PLAIN_TEXT_BOUNDARY_TAGS = new Set([
  "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "h1",
  "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "section", "table", "td", "th", "tr",
  "ul",
]);
const RENDERABLE_EMPTY_TAGS = new Set(["hr", "iframe", "img"]);

export interface SanitizeHtmlOptions {
  /**
   * Trusted presentation for a kept element (the storefront's image
   * renditions, link prefetch, one H1 per page): it may change the kept
   * attributes and return another allowed tag to write instead. Its values
   * are escaped like any other.
   */
  present?: (tag: string, attributes: Map<string, string>) => string | void;
}

/**
 * Sanitizes merchant rich text (the dashboard editor, agents, apps, imports)
 * with a parser-backed allowlist and writes the result itself
 * (`html-writer.ts`): every text escaped, every attribute value quoted and
 * escaped, no raw-text element written with content. Unknown tags are
 * unwrapped (their text stays text); raw-text, foreign and loading elements
 * go with their content; comments go. Sanitizing its output again changes
 * nothing.
 */
export function sanitizeHtml(html: string | null | undefined, options: SanitizeHtmlOptions = {}): SafeHtml {
  if (!html) return "" as SafeHtml;
  return writeSanitized(parseUntrustedHtml(html), options) as SafeHtml;
}

/** `sanitizeHtml` for a stored field: null and undefined (not sent) pass through. */
export function sanitizeHtmlField(value: string): SafeHtml;
export function sanitizeHtmlField(value: string | null): SafeHtml | null;
export function sanitizeHtmlField(value: string | undefined): SafeHtml | undefined;
export function sanitizeHtmlField(value: string | null | undefined): SafeHtml | null | undefined;
export function sanitizeHtmlField(value: string | null | undefined): SafeHtml | null | undefined {
  return value === null || value === undefined ? value : sanitizeHtml(value);
}

/**
 * Converts merchant-authored rich text to normalized plain text without using
 * regex-based tag stripping. Script-capable nodes are removed by the same
 * allowlist as `sanitizeHtml`, and block boundaries remain readable spaces.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";

  const parts: string[] = [];
  appendPlainText(parseSanitized(html), parts);

  return parts
    .join("")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,;:!?])/gu, "$1")
    .trim();
}

/** Returns whether sanitized rich text has visible text or an empty visual node. */
export function hasRenderableHtmlContent(html: string | null | undefined): boolean {
  if (!html) return false;
  return nodesHaveRenderableContent(parseSanitized(html));
}

function parseSanitized(html: string): ChildNode[] {
  return parseDocument(sanitizeHtml(html), { decodeEntities: true, lowerCaseTags: true }).children;
}

function appendPlainText(nodes: ChildNode[] = [], parts: string[]): void {
  for (const node of nodes) {
    if (isText(node)) {
      parts.push(node.data);
      continue;
    }
    if (!isTag(node)) continue;

    const isBoundary = PLAIN_TEXT_BOUNDARY_TAGS.has(node.name);
    if (isBoundary) parts.push(" ");
    appendPlainText(node.children ?? [], parts);
    if (isBoundary) parts.push(" ");
  }
}

function nodesHaveRenderableContent(nodes: ChildNode[] = []): boolean {
  for (const node of nodes) {
    if (isText(node) && node.data.trim().length > 0) return true;
    if (!isTag(node)) continue;
    if (RENDERABLE_EMPTY_TAGS.has(node.name)) return true;
    if (nodesHaveRenderableContent(node.children ?? [])) return true;
  }
  return false;
}

/** The walk, with an explicit stack: nesting depth never costs call stack. */
function writeSanitized(nodes: ChildNode[], options: SanitizeHtmlOptions): string {
  const out: string[] = [];
  const stack: Array<{ nodes: ChildNode[]; index: number; close: string }> = [{ nodes, index: 0, close: "" }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const node = frame.nodes[frame.index++];
    if (!node) {
      stack.pop();
      out.push(frame.close);
      continue;
    }
    if (isText(node)) {
      out.push(escapeHtmlText(node.data));
      continue;
    }
    if (!isTag(node)) continue; // comments, CDATA, processing instructions, doctype
    const tag = node.name.toLowerCase();
    if (tag === "iframe") {
      const embed = videoEmbedAttributes(node.attribs);
      if (embed) out.push(`${writeStartTag("iframe", embed)}</iframe>`);
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrapped: its children are written in its place.
      stack.push({ nodes: node.children, index: 0, close: "" });
      continue;
    }
    const attributes = sanitizeAttributes(tag, node.attribs);
    const presented = options.present?.(tag, attributes);
    const name = presented && ALLOWED_TAGS.has(presented) && VOID_ELEMENTS.has(presented) === VOID_ELEMENTS.has(tag) ? presented : tag;
    out.push(writeStartTag(name, attributes));
    if (!VOID_ELEMENTS.has(tag)) stack.push({ nodes: node.children, index: 0, close: `</${name}>` });
  }
  return out.join("");
}

/** A YouTube or Vimeo player, normalized (attributes in the editor's order); null for any other source. */
function videoEmbedAttributes(attributes: Record<string, string>): Map<string, string> | null {
  const embed = normalizeVideoEmbed(attributes.src);
  if (!embed) return null;
  const title = attributes.title?.trim().slice(0, 200);
  return new Map([
    ["src", embed.src],
    ["title", title || `${embed.provider === "youtube" ? "YouTube" : "Vimeo"} video`],
    ["loading", "lazy"],
    ["allow", "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"],
    ["allowfullscreen", ""],
    ["referrerpolicy", "strict-origin-when-cross-origin"],
  ]);
}

function sanitizeAttributes(tag: string, input: Record<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    const value = attributeValue(tag, name, String(rawValue ?? ""));
    if (value !== null) result.set(name, value);
  }
  if (tag === "a" && result.get("target") === "_blank") {
    const rel = new Set((result.get("rel") ?? "").split(" ").filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    result.set("rel", [...rel].join(" "));
  }
  return result;
}

function attributeValue(tag: string, name: string, value: string): string | null {
  if (!(GLOBAL_ATTRIBUTES.has(name) || TAG_ATTRIBUTES[tag]?.has(name) || ARIA_ATTRIBUTE.test(name))) return null;
  if (value.length > MAX_ATTRIBUTE_VALUE) return null;
  if (BOOLEAN_ATTRIBUTES.has(name)) return "";
  const choices = ENUMERATED[name];
  if (choices) return choices.has(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
  if (NUMBER_ATTRIBUTES.has(name)) return /^\d{1,5}%?$/.test(value.trim()) ? value.trim() : null;
  switch (name) {
    case "class": {
      const classes = value.split(/\s+/).filter((token) => ALLOWED_CLASSES.has(token));
      return classes.length > 0 ? classes.join(" ") : null;
    }
    case "style":
      return sanitizeStyle(value);
    case "href":
    case "src":
      return sanitizeUrl(value, IMAGE_URL_TAGS.has(tag)) || null;
    case "srcset":
      return sanitizeSrcset(value) || null;
    case "rel":
      return value.split(/\s+/).map((token) => token.toLowerCase()).filter((token) => /^[a-z-]{1,20}$/.test(token)).join(" ") || null;
    case "type":
      if (tag === "button") return ALLOWED_BUTTON_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : "button";
      if (tag === "ol") return /^[1aAiI]$/.test(value) ? value : null;
      return /^[a-z]+\/[a-z0-9.+-]+$/i.test(value) ? value : null;
    case "data-colwidth":
      return /^\d{1,5}(?:,\d{1,5}){0,20}$/.test(value) ? value : null;
    case "lang":
      return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(value) ? value : null;
    default:
      return value;
  }
}

function sanitizeStyle(value: string): string | null {
  const declarations: string[] = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const body = declaration.slice(colon + 1).trim().toLowerCase();
    if (STYLE_VALUES[property]?.test(body)) declarations.push(`${property}: ${body}`);
  }
  return declarations.length > 0 ? declarations.join("; ") : null;
}

function sanitizeUrl(value: string, imageUrl: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
  if (compact.startsWith("data:")) {
    return imageUrl && SAFE_DATA_IMAGE_RE.test(compact) ? trimmed : "";
  }
  if (compact.startsWith("mailto:") || compact.startsWith("tel:")) {
    return imageUrl ? "" : trimmed;
  }
  if (HAS_SCHEME_RE.test(compact)) {
    return compact.startsWith("http:") || compact.startsWith("https:") ? trimmed : "";
  }
  // A relative URL: a browser reads `\` as `/`, and a scheme can hide behind control characters.
  return /[\u0000-\u001F\u007F\\]/.test(trimmed) ? "" : trimmed;
}

function sanitizeSrcset(value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const [url = "", ...descriptors] = candidate.trim().split(/\s+/);
      const safe = sanitizeUrl(url, true);
      if (!safe || !descriptors.every((descriptor) => /^\d+(?:\.\d+)?[wx]$/.test(descriptor))) return "";
      return [safe, ...descriptors].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}
