import type {
  Atrule,
  Declaration,
  EnterOrLeaveFn,
  Raw,
  StyleSheet,
  Value,
  WalkContext,
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

const LAYOUT_LIMITS_PX = {
  blockMargin: 48,
  blockPadding: 120,
  gap: 64,
  minHeight: 560,
  fixedHeight: 720,
} as const;

export interface CssSanitizeReport {
  css: string;
  recovered: boolean;
  discardedBlockCount: number;
  warnings: string[];
}

/**
 * Sanitizes full stylesheet text before it is injected into a `<style>` tag.
 *
 * This is intentionally stricter than inline style sanitization: widgets are
 * merchant/generated content, so stylesheets must not be able to break out of
 * the style element, load remote styles/fonts, or use script-capable CSS.
 */
export function sanitizeCssForStyleElement(css: string | null | undefined): string {
  return sanitizeCssForStyleElementWithReport(css).css;
}

export function sanitizeCssForStyleElementWithReport(
  css: string | null | undefined,
): CssSanitizeReport {
  if (!css) {
    return { css: "", recovered: false, discardedBlockCount: 0, warnings: [] };
  }

  const stripped = stripCssInput(css);
  if (!stripped.trim()) {
    return { css: "", recovered: false, discardedBlockCount: 0, warnings: [] };
  }

  const ast = parseStylesheet(stripped);
  if (ast && !hasUnsafeRawNodes(ast)) {
    sanitizeAst(ast);
    return {
      css: cssTree.generate(ast),
      recovered: false,
      discardedBlockCount: 0,
      warnings: [],
    };
  }

  const recovered = recoverStylesheet(stripped);
  return {
    css: recovered.css,
    recovered: true,
    discardedBlockCount: recovered.discardedBlockCount,
    warnings:
      recovered.css.length > 0
        ? ["Recovered valid CSS blocks after discarding malformed generated CSS."]
        : ["Discarded malformed generated CSS."],
  };
}

function stripCssInput(css: string): string {
  return css
    .replace(CONTROL_CHARS_RE, "")
    .replace(SCRIPT_TAG_RE, "")
    .replace(STYLE_TAG_RE, "")
    .replace(HTML_TAG_RE, "")
    .replace(CSS_COMMENT_RE, "");
}

function parseStylesheet(css: string): StyleSheet | null {
  try {
    return cssTree.parse(css, {
      context: "stylesheet",
      positions: false,
      parseAtrulePrelude: true,
      parseRulePrelude: true,
      parseValue: true,
      parseCustomProperty: false,
    }) as StyleSheet;
  } catch {
    return null;
  }
}

function recoverStylesheet(css: string): { css: string; discardedBlockCount: number } {
  const blocks = extractTopLevelCssBlocks(css);
  const sanitizedBlocks: string[] = [];
  let discardedBlockCount = 0;

  for (const block of blocks) {
    const ast = parseStylesheet(block);
    if (!ast || hasUnsafeRawNodes(ast)) {
      discardedBlockCount += 1;
      continue;
    }

    sanitizeAst(ast);
    const sanitized = cssTree.generate(ast).trim();
    if (sanitized) {
      sanitizedBlocks.push(sanitized);
    } else {
      discardedBlockCount += 1;
    }
  }

  if (blocks.length === 0 && css.trim()) {
    discardedBlockCount = 1;
  }

  return {
    css: sanitizedBlocks.join("\n"),
    discardedBlockCount,
  };
}

function extractTopLevelCssBlocks(css: string): string[] {
  const blocks: string[] = [];
  let blockStart = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < css.length; index++) {
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

    if (char === "{") {
      if (depth === 0) {
        blockStart = findRuleStart(css, blockStart, index);
      }
      depth += 1;
      continue;
    }

    if (char !== "}") continue;

    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const block = css.slice(blockStart, index + 1).trim();
      if (block) blocks.push(block);
      blockStart = index + 1;
    }
  }

  return blocks;
}

function hasUnsafeRawNodes(ast: StyleSheet): boolean {
  let hasRaw = false;
  const enter: EnterOrLeaveFn = function (this: WalkContext, node) {
    if (node.type === "Raw") {
      if (this.declaration) {
        return;
      }
      hasRaw = true;
    }
  };

  cssTree.walk(ast, {
    enter,
  });
  return hasRaw;
}

function findRuleStart(css: string, previousEnd: number, openBrace: number): number {
  const prefix = css.slice(previousEnd, openBrace);
  const lastCloseBrace = prefix.lastIndexOf("}");
  const lastSemicolon = prefix.lastIndexOf(";");
  return previousEnd + Math.max(lastCloseBrace, lastSemicolon, -1) + 1;
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

  const layoutNormalizedValue = normalizeGeneratedLayoutDeclaration(property, sanitizedValue);
  if (layoutNormalizedValue === null) {
    return true;
  }

  if (layoutNormalizedValue !== sanitizedValue) {
    node.value = parseCssValue(layoutNormalizedValue);
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

function normalizeGeneratedLayoutDeclaration(property: string, value: string): string | null {
  if (property === "margin-top" || property === "margin-bottom" || property === "margin-block-start" || property === "margin-block-end") {
    return normalizeLengthToken(value, LAYOUT_LIMITS_PX.blockMargin, { allowNegative: true });
  }

  if (property === "margin" || property === "margin-block") {
    return normalizeBoxShorthand(value, LAYOUT_LIMITS_PX.blockMargin, { allowNegative: true });
  }

  if (property === "padding-top" || property === "padding-bottom" || property === "padding-block-start" || property === "padding-block-end") {
    return normalizeLengthToken(value, LAYOUT_LIMITS_PX.blockPadding);
  }

  if (property === "padding" || property === "padding-block") {
    return normalizeBoxShorthand(value, LAYOUT_LIMITS_PX.blockPadding);
  }

  if (property === "gap" || property === "row-gap" || property === "column-gap") {
    return normalizeGapValue(value);
  }

  if (property === "min-height") {
    return normalizeLengthToken(value, LAYOUT_LIMITS_PX.minHeight);
  }

  if (property === "height") {
    const normalized = normalizeLengthToken(value, LAYOUT_LIMITS_PX.fixedHeight);
    return normalized === "0" ? null : normalized;
  }

  return value;
}

function normalizeGapValue(value: string): string {
  const parts = splitCssValueList(value);
  if (parts.length <= 1) return normalizeLengthToken(value, LAYOUT_LIMITS_PX.gap);
  return parts.map((part) => normalizeLengthToken(part, LAYOUT_LIMITS_PX.gap)).join(" ");
}

function normalizeBoxShorthand(
  value: string,
  maxBlockPx: number,
  options?: { allowNegative?: boolean },
): string {
  const parts = splitCssValueList(value);
  if (parts.length === 0) return value;

  if (parts.length === 1) {
    return normalizeLengthToken(parts[0]!, maxBlockPx, options);
  }

  if (parts.length === 2) {
    return [
      normalizeLengthToken(parts[0]!, maxBlockPx, options),
      parts[1],
    ].join(" ");
  }

  if (parts.length === 3) {
    return [
      normalizeLengthToken(parts[0]!, maxBlockPx, options),
      parts[1],
      normalizeLengthToken(parts[2]!, maxBlockPx, options),
    ].join(" ");
  }

  return [
    normalizeLengthToken(parts[0]!, maxBlockPx, options),
    parts[1],
    normalizeLengthToken(parts[2]!, maxBlockPx, options),
    parts[3],
    ...parts.slice(4),
  ].join(" ");
}

function normalizeLengthToken(token: string, maxPx: number, options?: { allowNegative?: boolean }): string {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "normal") return trimmed;

  const maxTokenPx = maxCssLengthPx(trimmed);
  if (maxTokenPx === null) return trimmed;
  if (maxTokenPx.sign < 0) {
    if (!options?.allowNegative) return "0";
    return maxTokenPx.magnitude <= maxPx ? trimmed : `-${maxPx}px`;
  }
  if (maxTokenPx.magnitude <= maxPx) return trimmed;
  return `${maxPx}px`;
}

function maxCssLengthPx(value: string): { magnitude: number; sign: 1 | -1 } | null {
  const matches = value.matchAll(/(-?\d*\.?\d+)\s*(px|rem|em|vh|svh|lvh|dvh)/gi);
  let max: { magnitude: number; sign: 1 | -1 } | null = null;

  for (const match of matches) {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (!Number.isFinite(amount) || !unit) continue;

    const px =
      unit === "px"
        ? amount
        : unit === "rem" || unit === "em"
          ? amount * 16
          : amount * 8;
    const magnitude = Math.abs(px);
    const sign = px < 0 ? -1 : 1;
    max = max === null || magnitude > max.magnitude ? { magnitude, sign } : max;
  }

  return max;
}

function splitCssValueList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (/\s/.test(char) && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
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
