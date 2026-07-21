import { DomUtils, parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode } from "domhandler";
import { normalizeVideoEmbed } from "./video-embed";

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "iframe",
  "img",
  "ins",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "picture",
  "pre",
  "s",
  "section",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const DROP_WITH_CONTENT = new Set([
  "applet",
  "base",
  "embed",
  "link",
  "meta",
  "object",
  "script",
  "style",
  "template",
]);

const GENERAL_ATTRIBUTES = new Set([
  "class",
  "dir",
  "id",
  "lang",
  "role",
  "style",
  "tabindex",
  "title",
]);

const TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "name", "rel", "target"]),
  button: new Set(["disabled", "type"]),
  col: new Set(["span", "width"]),
  iframe: new Set([
    "allow",
    "allowfullscreen",
    "frameborder",
    "loading",
    "referrerpolicy",
    "src",
    "title",
  ]),
  img: new Set([
    "alt",
    "decoding",
    "fetchpriority",
    "height",
    "loading",
    "sizes",
    "src",
    "srcset",
    "width",
  ]),
  source: new Set(["height", "media", "sizes", "src", "srcset", "type", "width"]),
  table: new Set(["summary"]),
  td: new Set(["colspan", "headers", "rowspan"]),
  th: new Set(["colspan", "headers", "rowspan", "scope"]),
};

const BOOLEAN_ATTRIBUTES = new Set(["allowfullscreen", "disabled"]);
const URL_ATTRIBUTES = new Set(["href", "src"]);
const IMAGE_URL_TAGS = new Set(["img", "source"]);
const ALLOWED_BUTTON_TYPES = new Set(["button", "submit", "reset"]);
const ALLOWED_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const PLAIN_TEXT_BOUNDARY_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const RENDERABLE_EMPTY_TAGS = new Set(["hr", "iframe", "img"]);

/**
 * Sanitizes admin-authored rich HTML using a parser-backed allowlist.
 *
 * The sanitizer preserves layout/content tags used by CMS pages,
 * while dropping script-capable tags, event attributes, unsafe protocols, and
 * dangerous CSS patterns. Unknown tags are unwrapped so merchant-authored text
 * survives without preserving unsafe elements.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";

  const normalized = html.replace(/[\x00\u200B\u200C\u200D\uFEFF]/g, "");
  const document = parseDocument(normalized, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
  });

  const children = sanitizeNodes(document.children);
  return DomUtils.getOuterHTML(children);
}

/**
 * Converts merchant-authored rich text to normalized plain text without using
 * regex-based tag stripping. Script-capable nodes are removed by the same
 * allowlist as `sanitizeHtml`, and block boundaries remain readable spaces.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";

  const document = parseDocument(sanitizeHtml(html), {
    decodeEntities: true,
    lowerCaseTags: true,
  });
  const parts: string[] = [];
  appendPlainText(document.children, parts);

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

  const document = parseDocument(sanitizeHtml(html), {
    decodeEntities: true,
    lowerCaseTags: true,
  });
  return nodesHaveRenderableContent(document.children);
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

function sanitizeNodes(nodes: ChildNode[] = []): ChildNode[] {
  const sanitized: ChildNode[] = [];

  for (const node of nodes) {
    if (isText(node)) {
      sanitized.push(node);
      continue;
    }

    if (!isTag(node)) {
      continue;
    }

    const tagName = (node.name || "").toLowerCase();
    if (DROP_WITH_CONTENT.has(tagName)) continue;

    const children = sanitizeNodes(node.children ?? []);
    if (!ALLOWED_TAGS.has(tagName)) {
      sanitized.push(...children);
      continue;
    }

    node.name = tagName;
    node.attribs = sanitizeAttributes(tagName, node.attribs ?? {});
    if (tagName === "iframe" && !node.attribs.src) continue;
    node.children = children;
    sanitized.push(node);
  }

  return sanitized;
}

function sanitizeAttributes(
  tagName: string,
  attributes: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  if (tagName === "iframe") {
    const embed = normalizeVideoEmbed(attributes.src);
    if (!embed) return sanitized;
    sanitized.src = embed.src;
    sanitized.title = attributes.title?.trim() || `${embed.provider === "youtube" ? "YouTube" : "Vimeo"} video`;
    sanitized.loading = "lazy";
    sanitized.referrerpolicy = "strict-origin-when-cross-origin";
    sanitized.allow = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    sanitized.allowfullscreen = "";
  }

  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("on")) continue;
    if (!isAllowedAttribute(tagName, name)) continue;

    if (tagName === "iframe") continue;

    if (BOOLEAN_ATTRIBUTES.has(name)) {
      sanitized[name] = "";
      continue;
    }

    const value = String(rawValue ?? "");
    if (name === "style") {
      const style = sanitizeCss(value);
      if (style) sanitized[name] = style;
      continue;
    }

    if (URL_ATTRIBUTES.has(name)) {
      const url = sanitizeUrl(value, IMAGE_URL_TAGS.has(tagName));
      if (url) sanitized[name] = url;
      continue;
    }

    if (name === "srcset") {
      const srcset = sanitizeSrcset(value);
      if (srcset) sanitized[name] = srcset;
      continue;
    }

    if (name === "target") {
      const target = value.toLowerCase();
      if (ALLOWED_TARGETS.has(target)) sanitized[name] = target;
      continue;
    }

    if (name === "rel") {
      const rel = sanitizeTokenList(value);
      if (rel) sanitized[name] = rel;
      continue;
    }

    if (name === "type" && tagName === "button") {
      const type = value.toLowerCase();
      sanitized[name] = ALLOWED_BUTTON_TYPES.has(type) ? type : "button";
      continue;
    }

    sanitized[name] = value;
  }

  if (tagName === "a" && sanitized.target === "_blank") {
    const rel = new Set((sanitized.rel || "").split(/\s+/).filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    sanitized.rel = [...rel].join(" ");
  }

  if (tagName === "img") {
    addCloudflareImageDimensions(sanitized);
  }

  return sanitized;
}

function isAllowedAttribute(tagName: string, name: string): boolean {
  if (GENERAL_ATTRIBUTES.has(name)) return true;
  if (name.startsWith("data-") || name.startsWith("aria-")) return true;
  return TAG_ATTRIBUTES[tagName]?.has(name) === true;
}

function sanitizeUrl(value: string, imageUrl: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
  if (
    compact.startsWith("javascript:") ||
    compact.startsWith("vbscript:") ||
    compact.startsWith("file:")
  ) {
    return "";
  }

  if (compact.startsWith("data:")) {
    return imageUrl && SAFE_DATA_IMAGE_RE.test(compact) ? trimmed : "";
  }

  if (compact.startsWith("mailto:") || compact.startsWith("tel:")) {
    return imageUrl ? "" : trimmed;
  }

  if (HAS_SCHEME_RE.test(compact)) {
    return compact.startsWith("http:") || compact.startsWith("https:")
      ? trimmed
      : "";
  }

  return trimmed;
}

function sanitizeSrcset(value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = sanitizeUrl(parts[0] || "", true);
      if (!url) return "";
      return [url, ...parts.slice(1)].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function addCloudflareImageDimensions(attributes: Record<string, string>): void {
  const src = attributes.src;
  if (!src || (attributes.width && attributes.height)) return;

  const dimensions = getCloudflareImageTransformDimensions(src);
  if (!dimensions) return;

  attributes.width ||= String(dimensions.width);
  attributes.height ||= String(dimensions.height);
}

function getCloudflareImageTransformDimensions(src: string): { width: number; height: number } | null {
  const match = src.match(/\/cdn-cgi\/image\/([^/]+)\//i);
  if (!match?.[1]) return null;

  let width: number | null = null;
  let height: number | null = null;
  for (const option of match[1].split(",")) {
    const [rawKey, rawValue] = option.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = Number.parseInt(rawValue?.trim() ?? "", 10);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) continue;
    if (key === "width") width = value;
    if (key === "height") height = value;
  }

  return width && height ? { width, height } : null;
}

function sanitizeTokenList(value: string): string {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/[^\w:-]/g, "").toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function sanitizeCss(value: string): string {
  return value
    .split(";")
    .map(sanitizeCssDeclaration)
    .filter(Boolean)
    .join("; ");
}

function sanitizeCssDeclaration(declaration: string): string {
  const trimmed = declaration.trim();
  if (!trimmed) return "";
  if (/^@import\b/i.test(trimmed)) return "";

  const separator = trimmed.indexOf(":");
  if (separator <= 0) return "";

  const property = trimmed.slice(0, separator).trim().toLowerCase();
  const propertyValue = trimmed.slice(separator + 1).trim();
  if (!/^(?:-?[a-z][a-z0-9-]*|--[a-z0-9-]+)$/i.test(property)) return "";
  if (/^(?:behavior|(?:-moz-|-webkit-)?binding)$/i.test(property)) return "";
  if (hasUnsafeCssValue(propertyValue)) return "";

  return `${property}: ${propertyValue}`;
}

function hasUnsafeCssValue(value: string): boolean {
  const decoded = decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, "");
  const compact = decoded.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
  if (
    compact.includes("expression(") ||
    compact.includes("javascript:") ||
    compact.includes("vbscript:") ||
    compact.includes("file:")
  ) {
    return true;
  }

  for (const match of decoded.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const url = match[2]?.trim() ?? "";
    if (!sanitizeUrl(url, true)) return true;
  }

  return false;
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_match, escape: string) => {
    const hex = escape.trim();
    if (/^[0-9a-fA-F]+$/.test(hex)) {
      const codePoint = Number.parseInt(hex, 16);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return "";
    }
    return escape;
  });
}
