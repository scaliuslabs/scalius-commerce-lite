const SHORTCODE_TAG = String.raw`(?:widget|product)`;
const SHORTCODE = String.raw`\[${SHORTCODE_TAG}\b[^\]]+\]`;

const PARAGRAPH_WRAPPED_SHORTCODE_PATTERN = new RegExp(
  String.raw`<p(?:\s[^>]*)?>\s*(${SHORTCODE})\s*</p>`,
  "gi",
);

const STANDALONE_SHORTCODE_PATTERN = new RegExp(
  String.raw`^\s*(?:<p(?:\s[^>]*)?>\s*)?${SHORTCODE}\s*(?:</p>)?\s*$`,
  "i",
);

export function unwrapParagraphWrappedShortcodes(content: string): string {
  return content.replace(PARAGRAPH_WRAPPED_SHORTCODE_PATTERN, "$1");
}

export function isStandaloneShortcodeContent(content: string): boolean {
  return STANDALONE_SHORTCODE_PATTERN.test(content);
}
