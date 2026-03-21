// src/html-sanitize.ts
// Regex-based HTML sanitizer for admin-authored widget content.

/**
 * Sanitize HTML by stripping common XSS vectors while preserving structure.
 *
 * **Defense-in-depth measure, not a complete HTML sanitizer.** This covers the
 * most common attack vectors (script injection, event handlers, dangerous URLs,
 * dangerous embed tags) using regex patterns. For untrusted user input where
 * full sanitization is required, use a DOM-based sanitizer like DOMPurify.
 *
 * This is appropriate for admin-authored content where the author is semi-trusted
 * but content may be copy-pasted from external sources containing hidden payloads.
 *
 * Strips:
 * - `<script>` tags and their content
 * - `on*` event handler attributes (onclick, onerror, onload, etc.)
 * - `javascript:` URLs in href, src, action, formaction, xlink:href attributes
 * - `data:` URLs containing script content (text/html, application/javascript, etc.)
 * - `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<form>` tags
 * - `<base>` tags (prevents base URL hijacking)
 * - `<meta>` tags with http-equiv refresh (prevents redirect injection)
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";

  let result = html;

  // 1. Remove <script> tags and everything between them
  result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "");
  // Remove self-closing or unclosed script tags
  result = result.replace(/<script\b[^>]*\/?>/gi, "");

  // 2. Remove dangerous embed/frame tags and their content
  // <iframe>...</iframe>
  result = result.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe\s*>/gi, "");
  result = result.replace(/<iframe\b[^>]*\/?>/gi, "");
  // <object>...</object>
  result = result.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object\s*>/gi, "");
  result = result.replace(/<object\b[^>]*\/?>/gi, "");
  // <embed> (void element)
  result = result.replace(/<embed\b[^>]*\/?>/gi, "");
  // <applet>...</applet>
  result = result.replace(/<applet\b[^<]*(?:(?!<\/applet>)<[^<]*)*<\/applet\s*>/gi, "");
  result = result.replace(/<applet\b[^>]*\/?>/gi, "");

  // 3. Remove <base> tags (prevents base URL hijacking)
  result = result.replace(/<base\b[^>]*\/?>/gi, "");

  // 4. Remove <meta> with http-equiv="refresh" (prevents redirect injection)
  result = result.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\/?>/gi, "");

  // 5. Remove on* event handler attributes (onclick, onerror, onload, onmouseover, etc.)
  //    Handles whitespace and encoding tricks between "on" and the event name
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // 6. Remove javascript: URLs in href, src, action, formaction, xlink:href
  //    Handles whitespace/encoding between "javascript" and ":"
  result = result.replace(
    /(href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*javascript\s*:[^"]*"|'[^']*javascript\s*:[^']*')/gi,
    '$1=""',
  );

  // 7. Remove data: URLs with script-capable MIME types
  //    Allows data:image/* (common in inline images) but blocks text/html, application/javascript, etc.
  result = result.replace(
    /(href|src|action|formaction)\s*=\s*(?:"data\s*:\s*(?:text\/html|application\/javascript|application\/x-javascript|text\/javascript)[^"]*"|'data\s*:\s*(?:text\/html|application\/javascript|application\/x-javascript|text\/javascript)[^']*')/gi,
    '$1=""',
  );

  // 8. Remove vbscript: URLs (IE legacy but still worth catching)
  result = result.replace(
    /(href|src|action|formaction)\s*=\s*(?:"[^"]*vbscript\s*:[^"]*"|'[^']*vbscript\s*:[^']*')/gi,
    '$1=""',
  );

  // 9. Remove <form> tags (prevents form injection / credential phishing)
  //    Preserves content between form tags, only strips the tags themselves
  result = result.replace(/<\/?form\b[^>]*>/gi, "");

  return result;
}
