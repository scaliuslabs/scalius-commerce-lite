import { sanitizeCssForStyleElement } from "@scalius/shared/css-sanitize";
import { scopeCss } from "@scalius/shared/css-scope";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import {
  optimizeCssImageUrls,
  optimizeRichContentImages,
} from "./rich-content-media";

interface WidgetContentInput {
  id: string;
  htmlContent?: string | null;
  cssContent?: string | null;
}

interface PrepareWidgetContentOptions {
  priority?: boolean;
}

export interface PreparedWidgetContent {
  scopeClass: string;
  html: string;
  css: string;
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

export function prepareWidgetContent(
  widget: WidgetContentInput,
  options: PrepareWidgetContentOptions = {},
): PreparedWidgetContent {
  const scopeClass = getWidgetScopeClass(widget.id);
  const html = optimizeRichContentImages(
    sanitizeHtml(normalizeWidgetHtml(widget.htmlContent ?? "")),
    { priority: options.priority },
  );
  const css = scopeCss(
    optimizeCssImageUrls(
      sanitizeCssForStyleElement(normalizeWidgetCss(widget.cssContent)),
    ),
    scopeClass,
  );

  return { scopeClass, html, css };
}
