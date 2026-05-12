import type {
  Atrule,
  Declaration,
  EnterOrLeaveFn,
  Raw,
  StyleSheet,
  Value,
} from "css-tree";
import cssTree from "./css-tree-runtime";

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B\u200C\u200D\uFEFF]/g;
const STYLE_TAG_RE = /<\/?\s*style\b[^>]*>/gi;
const SCRIPT_TAG_RE = /<\s*script\b[\s\S]*?<\/\s*script\s*>/gi;
const HTML_TAG_RE = /<\/?[^>]+>/g;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const ALLOWED_BLOCK_AT_RULES = new Set([
  "container",
  "keyframes",
  "-webkit-keyframes",
  "layer",
  "media",
  "supports",
]);

/**
 * Sanitizes full stylesheet text before it is injected into a `<style>` tag.
 *
 * This is intentionally stricter than inline style sanitization: widgets are
 * merchant/generated content, so stylesheets must not be able to break out of
 * the style element, load remote styles/fonts, or use script-capable CSS.
 */
export function sanitizeCssForStyleElement(css: string | null | undefined): string {
  if (!css) return "";

  const stripped = css
    .replace(CONTROL_CHARS_RE, "")
    .replace(SCRIPT_TAG_RE, "")
    .replace(STYLE_TAG_RE, "")
    .replace(HTML_TAG_RE, "")
    .replace(CSS_COMMENT_RE, "");

  const ast = parseStylesheet(stripped);
  if (!ast) return "";

  sanitizeAst(ast);
  return cssTree.generate(ast);
}

function parseStylesheet(css: string): StyleSheet | null {
  try {
    return cssTree.parse(css, {
      context: "stylesheet",
      positions: false,
      parseValue: true,
      parseCustomProperty: false,
    }) as StyleSheet;
  } catch {
    return null;
  }
}

function sanitizeAst(ast: StyleSheet): void {
  const enter: EnterOrLeaveFn = (node, item, list) => {
    if (node.type === "Atrule" && shouldRemoveAtRule(node)) {
      list.remove(item);
      return;
    }

    if (node.type === "Declaration" && shouldRemoveDeclaration(node)) {
      list.remove(item);
    }
  };

  cssTree.walk(ast, {
    enter,
  });
}

function shouldRemoveAtRule(node: Atrule): boolean {
  const name = normalizeCssIdentifier(node.name);
  if (!ALLOWED_BLOCK_AT_RULES.has(name)) return true;
  return node.block === null;
}

function shouldRemoveDeclaration(node: Declaration): boolean {
  const property = normalizeCssIdentifier(node.property);
  if (!/^(?:-?[a-z][a-z0-9-]*|--[a-z0-9-]+)$/i.test(property)) return true;
  if (/^(?:behavior|(?:-moz-|-webkit-)?binding)$/i.test(property)) return true;

  const valueCss = cssTree.generate(node.value);
  const sanitizedValue = sanitizeCssUrls(valueCss);
  const compactValue = decodeCssEscapes(sanitizedValue)
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  if (
    compactValue.includes("expression(") ||
    compactValue.includes("javascript:") ||
    compactValue.includes("vbscript:") ||
    compactValue.includes("file:")
  ) {
    return true;
  }

  if (sanitizedValue !== valueCss) {
    node.value = parseCssValue(sanitizedValue);
  }

  return false;
}

function parseCssValue(value: string): Value | Raw {
  try {
    return cssTree.parse(value, {
      context: "value",
      positions: false,
      parseValue: true,
      parseCustomProperty: false,
    }) as Value;
  } catch {
    return { type: "Raw", value };
  }
}

function sanitizeCssUrls(css: string): string {
  let result = "";
  let index = 0;

  while (index < css.length) {
    const nextUrl = findNextCssUrl(css, index);
    if (!nextUrl) {
      result += css.slice(index);
      break;
    }

    result += css.slice(index, nextUrl.start);
    const closeParen = findCssFunctionClose(css, nextUrl.openParen);
    if (closeParen === -1) {
      result += 'url("about:blank")';
      break;
    }

    const originalUrl = css.slice(nextUrl.start, closeParen + 1);
    const rawUrl = unwrapCssUrl(css.slice(nextUrl.openParen + 1, closeParen));
    result += isUnsafeCssUrl(rawUrl) ? 'url("about:blank")' : originalUrl;
    index = closeParen + 1;
  }

  return result;
}

function findNextCssUrl(
  css: string,
  start: number,
): { start: number; openParen: number } | null {
  for (let index = start; index < css.length; index++) {
    if (css.slice(index, index + 3).toLowerCase() !== "url") continue;
    if (index > 0 && isCssIdentifierChar(css[index - 1]!)) continue;

    let cursor = index + 3;
    while (cursor < css.length && /\s/.test(css[cursor]!)) cursor++;
    if (css[cursor] === "(") return { start: index, openParen: cursor };
  }

  return null;
}

function findCssFunctionClose(css: string, openParen: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = openParen + 1; index < css.length; index++) {
    const char = css[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function unwrapCssUrl(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isCssIdentifierChar(char: string): boolean {
  return /[a-zA-Z0-9_-]/.test(char);
}

function isUnsafeCssUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  const compact = decodeCssEscapes(rawUrl)
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  return /^(?:javascript|vbscript|file|data):/.test(compact);
}

function normalizeCssIdentifier(value: string): string {
  return decodeCssEscapes(value)
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, "")
    .toLowerCase();
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
