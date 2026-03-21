// src/lib/shortcodes.ts
import { getProductBySlug, getWidgetById } from "@/lib/api";
import { scopeCss } from "@scalius/shared/css-scope";

export interface ShortcodeMatch {
  fullMatch: string;
  type: "widget" | "product";
  id: string;
  attributes: Record<string, string>;
}

// Parse shortcodes from content (this function remains the same)
export function parseShortcodes(content: string): ShortcodeMatch[] {
  const shortcodeRegex = /\[(\w+)([^\]]*)\]/g;
  const matches: ShortcodeMatch[] = [];
  let match;

  while ((match = shortcodeRegex.exec(content)) !== null) {
    const [fullMatch, type, attributesString] = match;

    if (type === "widget" || type === "product") {
      const attributes: Record<string, string> = {};

      const attrRegex = /(\w+)=["']([^"']*)["']/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attributesString)) !== null) {
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

    if (!widgetData || !widgetData.isActive) {
      return `<div class="shortcode-error">Widget not found or inactive: ${widgetId}</div>`;
    }

    const scopeClass = `sw-${widgetId}`;
    let html = widgetData.htmlContent;
    if (widgetData.cssContent) {
      html = `<style>${scopeCss(widgetData.cssContent, scopeClass)}</style>${html}`;
    }

    return `<div class="widget-shortcode not-prose ${scopeClass}" data-widget-id="${widgetId}">${html}</div>`;
  } catch (error: unknown) {
    console.error("Error rendering widget shortcode:", error);
    return `<div class="shortcode-error">Error loading widget: ${widgetId}</div>`;
  }
}

// REFACTORED: Render a placeholder for the product shortcode
export async function renderProductShortcode(
  productSlug: string,
): Promise<string> {
  try {
    const productData = await getProductBySlug(productSlug);

    if (!productData) {
      return `<div class="shortcode-error">Product not found: ${productSlug}</div>`;
    }

    // Encode as URI component for safe embedding in data attribute
    const props = encodeURIComponent(JSON.stringify(productData));

    // Render a placeholder div for the React component to hydrate into.
    return `<div class="product-shortcode-container" data-props="${props}"></div>`;
  } catch (error: unknown) {
    console.error("Error rendering product shortcode:", error);
    return `<div class="shortcode-error">Error loading product: ${productSlug}</div>`;
  }
}

// REFACTORED: Parallel processing — resolve all shortcodes concurrently, then replace
export async function processShortcodes(content: string): Promise<string> {
  const shortcodes = parseShortcodes(content);
  if (shortcodes.length === 0) return content;

  // Phase 1: Resolve all shortcodes in parallel (each triggers an API call)
  const resolvedMap = new Map<string, string>();
  await Promise.all(
    shortcodes.map(async (shortcode) => {
      let replacement = "";
      if (shortcode.type === "widget") {
        replacement = await renderWidgetShortcode(shortcode.id);
      } else if (shortcode.type === "product") {
        replacement = await renderProductShortcode(shortcode.id);
      }
      resolvedMap.set(shortcode.fullMatch, replacement);
    }),
  );

  // Phase 2: Replace all resolved shortcodes in a single pass
  let processedContent = content;
  for (const [original, replacement] of resolvedMap) {
    processedContent = processedContent.replace(original, replacement);
  }

  return processedContent;
}
