import {
  sanitizeCssForStyleElementWithReport,
  type CssSanitizeReport,
} from "./css-sanitize";
import { scopeCss } from "./css-scope";
import { sanitizeHtml } from "./html-sanitize";

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

export interface WidgetContentInput {
  id: string;
  htmlContent?: string | null;
  cssContent?: string | null;
}

export interface NormalizedWidgetParts {
  html: string;
  css: string;
  extractedCss: string;
}

export interface PreparedScopedWidgetContent {
  scopeClass: string;
  html: string;
  css: string;
  cssReport: CssSanitizeReport;
}

export interface PrepareScopedWidgetContentOptions {
  transformHtml?: (html: string) => string;
  transformCss?: (css: string) => string;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:html|css)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? content;
}

function stripTagWrapper(content: string, tagName: string): string {
  const fullTagPattern = new RegExp(
    String.raw`^\s*<${tagName}\b[^>]*>([\s\S]*?)</${tagName}>\s*$`,
    "i",
  );
  const fullMatch = content.match(fullTagPattern);
  if (fullMatch?.[1] !== undefined) {
    return fullMatch[1].trim();
  }

  return content
    .replace(new RegExp(String.raw`^\s*<${tagName}\b[^>]*>\s*`, "i"), "")
    .replace(new RegExp(String.raw`\s*</${tagName}>\s*$`, "i"), "")
    .trim();
}

function repairGeneratedCssComments(css: string): string {
  return css
    .replace(/\/\*\s*([^*\n]*?)\s\/\s*(?=\r?\n)/g, "/* $1 */")
    .replace(/;\s\/\s([^*{}\n][^*{}]*?)\s\*\//g, "; /* $1 */");
}

export function normalizeWidgetHtml(html: string): string {
  let normalized = stripCodeFence(html);
  normalized = stripTagWrapper(normalized, "htmljs");
  normalized = stripTagWrapper(normalized, "html");
  return normalized;
}

export function normalizeWidgetCss(css: string | null | undefined): string {
  if (!css) return "";

  let normalized = stripCodeFence(css);
  normalized = stripTagWrapper(normalized, "css");
  return repairGeneratedCssComments(normalized);
}

export function getWidgetScopeClass(widgetId: string): string {
  const normalized = `sw-${widgetId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "sw-widget";
}

export function normalizeWidgetParts(input: {
  htmlContent?: string | null;
  cssContent?: string | null;
}): NormalizedWidgetParts {
  const normalizedHtml = normalizeWidgetHtml(input.htmlContent ?? "");
  const extractedCssBlocks: string[] = [];
  const html = normalizedHtml.replace(STYLE_BLOCK_RE, (_match, css: string) => {
    if (css.trim()) extractedCssBlocks.push(css.trim());
    return "";
  });
  const explicitCss = normalizeWidgetCss(input.cssContent);
  const extractedCss = extractedCssBlocks.join("\n\n");
  const css = [explicitCss, extractedCss].filter(Boolean).join("\n\n");

  return { html, css, extractedCss };
}

export function prepareScopedWidgetContent(
  widget: WidgetContentInput,
  options: PrepareScopedWidgetContentOptions = {},
): PreparedScopedWidgetContent {
  const scopeClass = getWidgetScopeClass(widget.id);
  const parts = normalizeWidgetParts(widget);
  const sanitizedHtml = sanitizeHtml(parts.html);
  const html = options.transformHtml ? options.transformHtml(sanitizedHtml) : sanitizedHtml;
  const cssReport = sanitizeCssForStyleElementWithReport(parts.css);
  const transformedCss = options.transformCss
    ? options.transformCss(cssReport.css)
    : cssReport.css;
  const css = scopeCss(transformedCss, scopeClass);

  return { scopeClass, html, css, cssReport };
}
