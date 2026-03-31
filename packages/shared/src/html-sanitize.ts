// src/html-sanitize.ts
// Regex-based HTML sanitizer for admin-authored widget content.

/**
 * Sanitize HTML by stripping common XSS vectors while preserving structure.
 *
 * **Defense-in-depth measure for semi-trusted admin content.** Covers:
 * - `<script>` tags and their content
 * - Dangerous embed/frame tags (`<iframe>`, `<object>`, `<embed>`, `<applet>`)
 * - `<base>`, `<link>`, `<template>` tags
 * - `<meta>` tags with http-equiv refresh
 * - `on*` event handler attributes (including HTML-entity-encoded variants)
 * - `javascript:`, `vbscript:`, `data:` (non-image) URLs
 * - CSS expressions and `url(javascript:...)` in style attributes
 * - Null bytes and zero-width characters used to bypass filters
 * - `<form>` tags (prevents credential phishing)
 *
 * For fully untrusted user input, use a DOM-based sanitizer like DOMPurify.
 * This is appropriate for admin-authored content where the author is semi-trusted
 * but content may be copy-pasted from external sources containing hidden payloads.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";

  let result = html;

  // ── Phase 0: Strip null bytes and zero-width characters ──
  // These can be injected between characters to bypass pattern matching
  // e.g., <scri\0pt> or on\u200Bclick
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x00\u200B\u200C\u200D\uFEFF]/g, "");

  // ── Phase 1: Decode HTML entities in dangerous contexts ──
  // Attackers encode "on" as "&#111;n" or "&#x6F;n" to bypass event handler detection.
  // We normalize numeric HTML entities to their character equivalents before filtering.
  // This runs BEFORE attribute stripping so encoded payloads are caught.
  result = decodeNumericEntities(result);

  // ── Phase 2: Remove dangerous tags and their content ──

  // <script>...</script> and unclosed/self-closing variants
  result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "");
  result = result.replace(/<script\b[^>]*\/?>/gi, "");

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

  // <base> tags (prevents base URL hijacking)
  result = result.replace(/<base\b[^>]*\/?>/gi, "");

  // <link> tags (prevents stylesheet injection, import attacks)
  result = result.replace(/<link\b[^>]*\/?>/gi, "");

  // <template>...</template> (can contain executable content in some contexts)
  result = result.replace(/<template\b[^<]*(?:(?!<\/template>)<[^<]*)*<\/template\s*>/gi, "");
  result = result.replace(/<template\b[^>]*\/?>/gi, "");

  // <meta> with http-equiv="refresh" (prevents redirect injection)
  result = result.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\/?>/gi, "");

  // ── Phase 3: Remove event handler attributes ──
  // Matches on* attributes even with whitespace tricks between attribute name and =
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // ── Phase 4: Remove dangerous URL protocols ──

  // javascript: URLs in href, src, action, formaction, xlink:href
  result = result.replace(
    /(href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*javascript\s*:[^"]*"|'[^']*javascript\s*:[^']*')/gi,
    '$1=""',
  );

  // vbscript: URLs
  result = result.replace(
    /(href|src|action|formaction)\s*=\s*(?:"[^"]*vbscript\s*:[^"]*"|'[^']*vbscript\s*:[^']*')/gi,
    '$1=""',
  );

  // data: URLs with script-capable MIME types (preserves data:image/*)
  result = result.replace(
    /(href|src|action|formaction)\s*=\s*(?:"data\s*:\s*(?:text\/html|application\/javascript|application\/x-javascript|text\/javascript|text\/xml|application\/xml|text\/css)[^"]*"|'data\s*:\s*(?:text\/html|application\/javascript|application\/x-javascript|text\/javascript|text\/xml|application\/xml|text\/css)[^']*')/gi,
    '$1=""',
  );

  // ── Phase 5: Neutralize dangerous CSS patterns ──
  // CSS expression() (IE legacy but still worth catching for defense-in-depth)
  // and url(javascript:...) in style attributes
  result = result.replace(
    /style\s*=\s*("[^"]*"|'[^']*')/gi,
    (match) => {
      return match
        .replace(/expression\s*\(/gi, "blocked(")
        .replace(/url\s*\(\s*(['"]?\s*javascript\s*:)/gi, "url(blocked:");
    },
  );

  // ── Phase 6: Remove <form> tags (preserves content) ──
  result = result.replace(/<\/?form\b[^>]*>/gi, "");

  return result;
}

/**
 * Decode numeric HTML entities (&#NNN; and &#xHH;) to their character equivalents.
 * This prevents attackers from encoding "onclick" as "&#111;nclick" to bypass filters.
 * Only decodes printable ASCII range (32-126) to avoid introducing control characters.
 */
function decodeNumericEntities(html: string): string {
  return html.replace(/&#(x?)([\da-fA-F]+);?/g, (_match, isHex: string, digits: string) => {
    const codePoint = isHex ? parseInt(digits, 16) : parseInt(digits, 10);
    // Only decode printable ASCII to prevent reintroducing control chars
    if (codePoint >= 32 && codePoint <= 126) {
      return String.fromCharCode(codePoint);
    }
    // Leave non-printable entities as-is (they're harmless as entities)
    return _match;
  });
}
