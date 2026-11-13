// `[product slug="…"]` in merchant rich text: a product card the page
// hydrates. Cards are resolved before the text is sanitized and written by
// the sanitizer itself (renderRichHtml), in place of the shortcode's text, so
// a shortcode can never cut through markup.
import { htmlToPlainText, type PresentedElement } from "@scalius/shared/html-sanitize";
import { getProductBySlug } from "@/lib/api";

const SHORTCODE_PATTERN = /\[product\b([^\]]*)\]/g;
const LONE_SHORTCODE_PATTERN = /^\s*\[product\b[^\]]*\]\s*$/;

function normalizeAttributeQuotes(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/** The product a shortcode names (`id` or `slug`), or null. */
function shortcodeProduct(attributes: string): string | null {
  const values: Record<string, string> = {};
  for (const [, key, value] of normalizeAttributeQuotes(attributes).matchAll(/(\w+)=["']([^"']*)["']/g)) {
    if (key && value !== undefined) values[key] = value;
  }
  return values.id || values.slug || null;
}

/** The products the content's shortcodes name, each once (read from its text, as the cards are placed). */
export function productShortcodeIds(content: string): string[] {
  const ids = new Set<string>();
  for (const [, attributes] of htmlToPlainText(content).matchAll(SHORTCODE_PATTERN)) {
    const id = shortcodeProduct(attributes ?? "");
    if (id) ids.add(id);
  }
  return [...ids];
}

/** A product's card placeholder, or a note that it could not be shown. */
export async function renderProductShortcode(productSlug: string): Promise<PresentedElement> {
  try {
    const productData = await getProductBySlug(productSlug);
    if (!productData) {
      return { tag: "div", attributes: [["class", "shortcode-error"]], text: `Product not found: ${productSlug}` };
    }
    // The card hydrates from these props (URI-encoded JSON).
    return {
      tag: "div",
      attributes: [["class", "product-shortcode-container"], ["data-props", encodeURIComponent(JSON.stringify(productData))]],
    };
  } catch (error: unknown) {
    console.error("Error rendering product shortcode:", error);
    return { tag: "div", attributes: [["class", "shortcode-error"]], text: `Error loading product: ${productSlug}` };
  }
}

/** Every product the content's shortcodes name, resolved concurrently. */
export async function resolveProductShortcodes(content: string): Promise<Map<string, PresentedElement>> {
  const ids = productShortcodeIds(content);
  return new Map(await Promise.all(ids.map(async (id) => [id, await renderProductShortcode(id)] as const)));
}

/** A text with its shortcodes replaced by their cards; nothing when it has none. */
export function presentProductShortcodes(
  text: string,
  cards: ReadonlyMap<string, PresentedElement>,
): Array<string | PresentedElement> | void {
  if (!text.includes("[product")) return;
  const parts: Array<string | PresentedElement> = [];
  let last = 0;
  for (const match of text.matchAll(SHORTCODE_PATTERN)) {
    const card = cards.get(shortcodeProduct(match[1] ?? "") ?? "");
    if (!card) continue;
    parts.push(text.slice(last, match.index), card);
    last = match.index + match[0].length;
  }
  if (last === 0) return;
  parts.push(text.slice(last));
  return parts.filter((part) => part !== "");
}

/** A paragraph that holds only a shortcode: its card replaces the paragraph (a block cannot sit in a paragraph). */
export function isLoneProductShortcode(text: string): boolean {
  return LONE_SHORTCODE_PATTERN.test(text);
}
