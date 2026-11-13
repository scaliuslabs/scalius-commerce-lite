const PRODUCT_SHORTCODE = String.raw`\[product\b[^\]]+\]`;

const PARAGRAPH_WRAPPED_SHORTCODE_PATTERN = new RegExp(
  String.raw`<p(?:\s[^>]*)?>\s*(${PRODUCT_SHORTCODE})\s*</p>`,
  "gi",
);

const STANDALONE_SHORTCODE_PATTERN = new RegExp(
  String.raw`^\s*(?:<p(?:\s[^>]*)?>\s*)?${PRODUCT_SHORTCODE}\s*(?:</p>)?\s*$`,
  "i",
);

export function unwrapParagraphWrappedShortcodes(content: string): string {
  return content.replace(PARAGRAPH_WRAPPED_SHORTCODE_PATTERN, "$1");
}

export function isStandaloneShortcodeContent(content: string): boolean {
  return STANDALONE_SHORTCODE_PATTERN.test(content);
}

/**
 * Plain text without its shortcodes: a description or excerpt cut from rich
 * content never shows `[product slug="..."]` to a search engine or a reader.
 */
export function withoutShortcodes(text: string): string {
  return text.replace(new RegExp(PRODUCT_SHORTCODE, "gi"), " ").replace(/\s+/g, " ").trim();
}
