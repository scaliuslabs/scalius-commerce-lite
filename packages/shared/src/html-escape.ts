// src/html-escape.ts
// HTML escape utility for sanitizing user-supplied values in HTML templates.

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escapes HTML special characters in a string to prevent HTML injection.
 * Safe for use in HTML element content and attribute values.
 */
export function escapeHtml(str: string): string {
  if (!str) return "";
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}
