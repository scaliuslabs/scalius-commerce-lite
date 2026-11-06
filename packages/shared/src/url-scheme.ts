// src/url-scheme.ts
// URL scheme validation for safe rendering of user-supplied URLs as clickable links.
// Only http:/https: schemes are permitted; javascript:, data:, vbscript: and unparseable
// values return false so callers render them as plain text instead of <a href>.

/** Only http:/https: URLs are rendered as clickable links; everything else returns false. */
export function isValidUrlScheme(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
