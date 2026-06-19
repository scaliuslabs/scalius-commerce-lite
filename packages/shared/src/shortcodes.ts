export interface ShortcodeMatch {
  fullMatch: string;
  type: "widget" | "product";
  id: string;
  attributes: Record<string, string>;
}

export function normalizeShortcodeAttributeQuotes(value: string): string {
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
    const fullMatch = match[0];
    const type = match[1];
    const attributesString = match[2] ?? "";

    if (type === "widget" || type === "product") {
      const attributes: Record<string, string> = {};
      const normalizedAttributesString =
        normalizeShortcodeAttributeQuotes(attributesString);

      const attrRegex = /(\w+)=["']([^"']*)["']/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(normalizedAttributesString)) !== null) {
        const key = attrMatch[1];
        const value = attrMatch[2];
        if (key && value !== undefined) {
          attributes[key] = value;
        }
      }

      const id = attributes.id || attributes.slug;
      if (id) {
        matches.push({
          fullMatch,
          type,
          id,
          attributes,
        });
      }
    }
  }

  return matches;
}
