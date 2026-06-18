// src/lib/shortcodes.ts
import { getProductBySlug, getWidgetById } from "@/lib/api";
import { escapeHtml } from "@scalius/shared/html-escape";
import { unwrapParagraphWrappedShortcodes } from "./shortcode-content";
import { withOptimizedProductPageImages } from "./serialized-media";
import { createScopedWidgetScript, prepareWidgetContent } from "./widget-content";

export interface ShortcodeMatch {
  fullMatch: string;
  type: "widget" | "product";
  id: string;
  attributes: Record<string, string>;
}

function normalizeShortcodeAttributeQuotes(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

export function parseShortcodes(content: string): ShortcodeMatch[] {
  const shortcodeRegex = /\[(\w+)([^\]]*)\]/g;
  const matches: ShortcodeMatch[] = [];
  let match;

  while ((match = shortcodeRegex.exec(content)) !== null) {
    const [fullMatch, type, attributesString] = match;

    if (type === "widget" || type === "product") {
      const attributes: Record<string, string> = {};
      const normalizedAttributesString =
        normalizeShortcodeAttributeQuotes(attributesString);

      const attrRegex = /(\w+)=["']([^"']*)["']/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(normalizedAttributesString)) !== null) {
        attributes[attrMatch[1]] = attrMatch[2];
      }

      if (attributes.id || attributes.slug) {
        matches.push({
          fullMatch,
          type: type as "widget" | "product",
          id: attributes.id || attributes.slug,
          attributes,
        });
      }
    }
  }

  return matches;
}

// Render widget shortcode
export async function renderWidgetShortcode(widgetId: string): Promise<string> {
  try {
    const widgetData = await getWidgetById(widgetId);
    const safeWidgetId = escapeHtml(widgetId);

    if (!widgetData || !widgetData.isActive) {
      return `<div class="shortcode-error">Widget not found or inactive: ${safeWidgetId}</div>`;
    }

    const { scopeClass, css, html: preparedHtml, js } =
      prepareWidgetContent(widgetData);
    let html = preparedHtml;
    if (css) {
      html = `<style>${css}</style>${html}`;
    }

    const scopedScript = createScopedWidgetScript(widgetData.id, js);
    return `<div class="widget-shortcode not-prose cms-widget-frame ${scopeClass}" data-widget-id="${safeWidgetId}" data-scalius-widget-root="true">${html}</div>${scopedScript ? `<script>${scopedScript}</script>` : ""}`;
  } catch (error: unknown) {
    console.error("Error rendering widget shortcode:", error);
    return `<div class="shortcode-error">Error loading widget: ${escapeHtml(widgetId)}</div>`;
  }
}

// REFACTORED: Render a placeholder for the product shortcode
export async function renderProductShortcode(
  productSlug: string,
): Promise<string> {
  try {
    const productData = await getProductBySlug(productSlug);
    const safeProductSlug = escapeHtml(productSlug);

    if (!productData) {
      return `<div class="shortcode-error">Product not found: ${safeProductSlug}</div>`;
    }

    // Encode as URI component for safe embedding in data attribute
    const props = encodeURIComponent(
      JSON.stringify(withOptimizedProductPageImages(productData)),
    );

    // Render a placeholder div for the React component to hydrate into.
    return `<div class="product-shortcode-container" data-props="${props}"></div>`;
  } catch (error: unknown) {
    console.error("Error rendering product shortcode:", error);
    return `<div class="shortcode-error">Error loading product: ${escapeHtml(productSlug)}</div>`;
  }
}

async function renderShortcode(shortcode: ShortcodeMatch): Promise<string> {
  if (shortcode.type === "widget") {
    return renderWidgetShortcode(shortcode.id);
  }
  return renderProductShortcode(shortcode.id);
}

function getShortcodeResolutionKey(shortcode: ShortcodeMatch): string {
  return `${shortcode.type}:${shortcode.id}`;
}

// Resolve unique shortcodes concurrently, then replace every matching token.
export async function processShortcodes(content: string): Promise<string> {
  const normalizedContent = unwrapParagraphWrappedShortcodes(content);
  const shortcodes = parseShortcodes(normalizedContent);
  if (shortcodes.length === 0) return normalizedContent;

  const replacementPromises = new Map<string, Promise<string>>();
  for (const shortcode of shortcodes) {
    const resolutionKey = getShortcodeResolutionKey(shortcode);
    if (!replacementPromises.has(resolutionKey)) {
      replacementPromises.set(resolutionKey, renderShortcode(shortcode));
    }
  }

  const resolvedByKey = new Map<string, string>(
    await Promise.all(
      Array.from(replacementPromises.entries(), async ([key, promise]) => [
        key,
        await promise,
      ] as const),
    ),
  );

  const resolvedMap = new Map<string, string>();
  for (const shortcode of shortcodes) {
    resolvedMap.set(
      shortcode.fullMatch,
      resolvedByKey.get(getShortcodeResolutionKey(shortcode)) ?? "",
    );
  }

  let processedContent = normalizedContent;
  for (const [original, replacement] of resolvedMap) {
    processedContent = processedContent.split(original).join(replacement);
  }

  return processedContent;
}
