// src/html-sanitize.ts
// Lightweight HTML sanitizer for admin-authored widget content.
// Strips the most common XSS vectors while preserving all other HTML.

/** Remove <script> tags and content, on* event handlers, and javascript: URLs */
export function sanitizeHtml(html: string): string {
  if (!html) return "";

  let result = html;

  // Remove <script> tags and everything between them
  result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "");
  // Remove self-closing or unclosed script tags
  result = result.replace(/<script\b[^>]*\/?>/gi, "");

  // Remove on* event handler attributes (onclick, onerror, onload, etc.)
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // Remove javascript: URLs from href, src, action attributes
  result = result.replace(
    /(href|src|action)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi,
    '$1=""'
  );

  return result;
}
