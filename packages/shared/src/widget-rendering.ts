import {
  sanitizeCssForStyleElementWithReport,
  type CssSanitizeReport,
} from "./css-sanitize";
import { scopeCss } from "./css-scope";
import { sanitizeHtml } from "./html-sanitize";
import { DomUtils, parseDocument } from "htmlparser2";
import { isTag, type ChildNode, type Element } from "domhandler";

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const RESERVED_WIDGET_RUNTIME_CLASSES = new Set([
  "widget-container",
  "cms-widget-frame",
  "widget-placement-zone",
]);
const RESERVED_WIDGET_RUNTIME_ATTRIBUTES = new Set([
  "data-scalius-widget-root",
  "data-widget-id",
]);

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

export interface WidgetRenderabilityReport extends PreparedScopedWidgetContent {
  hasInputHtml: boolean;
  hasRenderableHtml: boolean;
  hasInputCss: boolean;
  hasRenderableCss: boolean;
  warnings: string[];
}

export interface PrepareScopedWidgetContentOptions {
  transformHtml?: (html: string) => string;
  transformCss?: (css: string) => string;
}

export function hasLikelyTruncatedCss(css: string): boolean {
  const trimmed = css.trim();
  const openingBraces = (trimmed.match(/{/g) ?? []).length;
  const closingBraces = (trimmed.match(/}/g) ?? []).length;
  return /:\s*}/.test(trimmed) || /[:{,]\s*$/.test(trimmed) || openingBraces !== closingBraces;
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

/**
 * Generated widget HTML is content only. The storefront/admin preview add the
 * runtime root wrapper, so model-authored runtime classes or attrs must not be
 * saved as part of merchant content.
 */
export function stripWidgetRuntimeMarkup(html: string): string {
  if (!html.trim()) return "";

  const runtimeWrapperNodes = new WeakSet<Element>();
  const document = parseDocument(html, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
  });

  function visit(nodes: ChildNode[] = []): void {
    for (const node of nodes) {
      if (!isTag(node)) continue;

      const attributes = node.attribs ?? {};
      const originalClassNames = String(attributes.class ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const hadRuntimeClass = originalClassNames.some((className) =>
        RESERVED_WIDGET_RUNTIME_CLASSES.has(className),
      );
      const hadRuntimeAttribute = Object.keys(attributes).some((name) =>
        RESERVED_WIDGET_RUNTIME_ATTRIBUTES.has(name.toLowerCase()),
      );

      if (hadRuntimeClass || hadRuntimeAttribute) {
        runtimeWrapperNodes.add(node);
      }

      for (const attributeName of Object.keys(attributes)) {
        if (RESERVED_WIDGET_RUNTIME_ATTRIBUTES.has(attributeName.toLowerCase())) {
          delete attributes[attributeName];
        }
      }

      if (originalClassNames.length > 0) {
        const classNames = originalClassNames.filter(
          (className) => !RESERVED_WIDGET_RUNTIME_CLASSES.has(className),
        );
        if (classNames.length > 0) {
          attributes.class = classNames.join(" ");
        } else {
          delete attributes.class;
        }
      }

      node.attribs = attributes;
      visit(node.children ?? []);
    }
  }

  visit(document.children);

  const children = document.children.flatMap((node) => {
    if (!isNeutralRuntimeWrapper(node, runtimeWrapperNodes)) return [node];
    return node.children ?? [];
  });

  return DomUtils.getOuterHTML(children);
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
  const normalizedHtml = stripWidgetRuntimeMarkup(normalizeWidgetHtml(input.htmlContent ?? ""));
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

export function evaluateWidgetRenderability(
  widget: WidgetContentInput,
  options: PrepareScopedWidgetContentOptions = {},
): WidgetRenderabilityReport {
  const parts = normalizeWidgetParts(widget);
  const prepared = prepareScopedWidgetContent(widget, options);
  const hasInputHtml = parts.html.trim().length > 0;
  const hasRenderableHtml = prepared.html.trim().length > 0;
  const hasInputCss = parts.css.trim().length > 0;
  const hasRenderableCss = prepared.css.trim().length > 0;
  const warnings = [...prepared.cssReport.warnings];

  if (hasInputHtml && !hasRenderableHtml) {
    warnings.push("Widget HTML was removed during sanitization.");
  }

  if (hasInputCss && !prepared.cssReport.css.trim()) {
    warnings.push("Widget CSS was removed during sanitization.");
  } else if (hasInputCss && !hasRenderableCss) {
    warnings.push("Widget CSS was removed during scoping.");
  }

  return {
    ...prepared,
    hasInputHtml,
    hasRenderableHtml,
    hasInputCss,
    hasRenderableCss,
    warnings,
  };
}

function isNeutralRuntimeWrapper(
  node: ChildNode,
  runtimeWrapperNodes: WeakSet<Element>,
): node is Element {
  if (!isTag(node) || node.name !== "div" || !runtimeWrapperNodes.has(node)) {
    return false;
  }

  return Object.keys(node.attribs ?? {}).length === 0;
}
