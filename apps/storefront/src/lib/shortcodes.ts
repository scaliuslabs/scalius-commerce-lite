// src/lib/shortcodes.ts
import { getProductBySlug } from "@/lib/api";
import { escapeHtml } from "@scalius/shared/html-escape";
import { unwrapParagraphWrappedShortcodes } from "./shortcode-content";
import { withOptimizedProductPageImages } from "./serialized-media";

interface ProductShortcodeMatch {
  fullMatch: string;
  id: string;
}

function normalizeAttributeQuotes(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function parseProductShortcodes(content: string): ProductShortcodeMatch[] {
  const matches: ProductShortcodeMatch[] = [];
  const shortcodePattern = /\[product\b([^\]]*)\]/g;
  let match: RegExpExecArray | null;

  while ((match = shortcodePattern.exec(content)) !== null) {
    const fullMatch = match[0];
    const attributes = normalizeAttributeQuotes(match[1] ?? "");
    const values: Record<string, string> = {};
    const attributePattern = /(\w+)=["']([^"']*)["']/g;
    let attributeMatch: RegExpExecArray | null;

    while ((attributeMatch = attributePattern.exec(attributes)) !== null) {
      const key = attributeMatch[1];
      const value = attributeMatch[2];
      if (key && value !== undefined) {
        values[key] = value;
      }
    }

    const id = values.id || values.slug;
    if (id) {
      matches.push({ fullMatch, id });
    }
  }

  return matches;
}

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

// Resolve unique shortcodes concurrently, then replace every matching token.
export async function processShortcodes(content: string): Promise<string> {
  const normalizedContent = unwrapParagraphWrappedShortcodes(content);
  const shortcodes = parseProductShortcodes(normalizedContent);
  if (shortcodes.length === 0) return normalizedContent;

  const replacementPromises = new Map<string, Promise<string>>();
  for (const shortcode of shortcodes) {
    if (!replacementPromises.has(shortcode.id)) {
      replacementPromises.set(
        shortcode.id,
        renderProductShortcode(shortcode.id),
      );
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
      resolvedByKey.get(shortcode.id) ?? "",
    );
  }

  let processedContent = normalizedContent;
  for (const [original, replacement] of resolvedMap) {
    processedContent = processedContent.split(original).join(replacement);
  }

  return processedContent;
}
