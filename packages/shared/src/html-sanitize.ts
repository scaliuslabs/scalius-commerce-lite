import { DomUtils, parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode } from "domhandler";

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
  "iframe",
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

const BOOLEAN_ATTRIBUTES = new Set(["disabled"]);
const URL_ATTRIBUTES = new Set(["href", "src"]);
const IMAGE_URL_TAGS = new Set(["img", "source"]);
const ALLOWED_BUTTON_TYPES = new Set(["button", "submit", "reset"]);
const ALLOWED_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Sanitizes admin-authored rich HTML using a parser-backed allowlist.
 *
 * The sanitizer preserves layout/content tags used by CMS pages and widgets,
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

  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("on")) continue;
    if (!isAllowedAttribute(tagName, name)) continue;

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
