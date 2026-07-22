const LINK_WHITESPACE = /\s/;

export function normalizeRichTextLinkUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (LINK_WHITESPACE.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return trimmed.length > 1 ? trimmed : null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      return url.hostname && !url.username && !url.password ? trimmed : null;
    }
    if (protocol === "mailto:" || protocol === "tel:") {
      return url.pathname ? trimmed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeRichTextImageUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}
