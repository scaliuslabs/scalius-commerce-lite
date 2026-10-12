// What the storefront keeps of an app component's markup
// (docs/STOREFRONT-COMPONENTS.md, "Output"). Components have the freedom of
// HTML and CSS: any element, class, inline style, `<style>`, SVG, forms,
// iframes. Script runs only as declared islands, so the page's JavaScript
// stays what its islands' budgets allow and nothing in the markup can run
// code: script elements (JSON-LD aside), event handler attributes,
// script-capable URLs, plugins, base and meta refreshes are dropped. An
// element or attribute that breaks a rule is dropped, never rewritten into
// something else; the rest of the markup is kept as written.
//
// htmlparser2 tokenizes; every text and attribute value is re-escaped on the
// way out, so the output is well-formed whatever the input.

import { Parser } from "htmlparser2";

/** Elements dropped with everything inside them. */
const DROPPED_WITH_CONTENT = new Set(["script", "object", "embed", "applet", "frame", "frameset", "noembed", "noframes", "title", "xmp", "plaintext"]);
/** Elements dropped but whose content is kept. */
const DROPPED_TAG_ONLY = new Set(["html", "head", "body", "base", "meta", "link"]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Attributes whose value is a URL. */
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "xlink:href", "cite", "background", "longdesc", "ping", "manifest"]);
const SAFE_URL = /^(?:[a-z][a-z0-9+.-]*:)?/i;
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "sms:"]);
const UNSAFE_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import/i;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A URL a component may use: relative, a fragment, or http(s), mailto, tel, sms. */
export function isSafeStorefrontUrl(value: string): boolean {
  // Control characters and whitespace inside a scheme are how `java\tscript:` hides.
  let compact = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 0x20 && code !== 0x7f) compact += char;
  }
  const scheme = SAFE_URL.exec(compact)?.[0] ?? "";
  return scheme === "" || ALLOWED_SCHEMES.has(scheme.toLowerCase());
}

function safeSrcset(value: string): boolean {
  return value.split(",").every((candidate) => isSafeStorefrontUrl(candidate.trim().split(/\s+/)[0] ?? ""));
}

function keepAttribute(element: string, name: string, value: string): boolean {
  if (name.startsWith("on") || name === "srcdoc" || name === "formtarget" && value === "_parent") return false;
  if (name === "http-equiv") return false;
  if (URL_ATTRIBUTES.has(name)) {
    if (element === "iframe" && name === "src") return /^https:\/\//i.test(value.trim());
    if (name === "src" && element === "img" && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(value.trim())) return true;
    return isSafeStorefrontUrl(value);
  }
  if (name === "srcset" || name === "imagesrcset") return safeSrcset(value);
  if (name === "style") return !UNSAFE_CSS.test(value);
  return /^[a-z_:][a-z0-9_.:-]*$/i.test(name);
}

export interface StorefrontHtmlResult {
  html: string;
  /** Elements or attributes dropped (for the app's log). */
  dropped: number;
}

/** The markup the page may show of a component's output. */
export function sanitizeStorefrontHtml(input: string): StorefrontHtmlResult {
  const out: string[] = [];
  let dropped = 0;
  /** Depth inside an element dropped with its content (0: keeping). */
  let skipDepth = 0;
  /** Inside a kept raw text element: `style` or JSON-LD `script`. */
  let rawElement: "style" | "json" | null = null;
  let rawText = "";
  const stack: string[] = [];

  const parser = new Parser({
    onopentag(name, attributes) {
      if (skipDepth > 0) {
        if (!VOID_ELEMENTS.has(name)) skipDepth += 1;
        return;
      }
      if (name === "script" && (attributes.type ?? "").trim().toLowerCase() === "application/ld+json") {
        rawElement = "json";
        rawText = "";
        stack.push(name);
        return;
      }
      if (DROPPED_WITH_CONTENT.has(name)) {
        dropped += 1;
        if (!VOID_ELEMENTS.has(name)) skipDepth = 1;
        return;
      }
      if (DROPPED_TAG_ONLY.has(name)) {
        dropped += 1;
        if (!VOID_ELEMENTS.has(name)) stack.push(`!${name}`);
        return;
      }
      if (name === "iframe" && !/^https:\/\//i.test((attributes.src ?? "").trim())) {
        dropped += 1;
        skipDepth = 1;
        return;
      }
      let tag = `<${name}`;
      for (const [attribute, value] of Object.entries(attributes)) {
        const key = attribute.toLowerCase();
        if (!keepAttribute(name, key, value)) {
          dropped += 1;
          continue;
        }
        tag += value === "" && !URL_ATTRIBUTES.has(key) ? ` ${attribute}` : ` ${attribute}="${escapeAttribute(value)}"`;
      }
      if (name === "iframe" && !("loading" in attributes)) tag += ` loading="lazy"`;
      out.push(`${tag}>`);
      if (name === "style") {
        rawElement = "style";
        rawText = "";
      }
      if (!VOID_ELEMENTS.has(name)) stack.push(name);
    },
    ontext(text) {
      if (skipDepth > 0) return;
      if (rawElement) {
        rawText += text;
        return;
      }
      out.push(escapeText(text));
    },
    onclosetag(name, implied) {
      if (skipDepth > 0) {
        if (!VOID_ELEMENTS.has(name)) skipDepth -= 1;
        return;
      }
      if (VOID_ELEMENTS.has(name)) return;
      const open = stack.pop();
      if (open === undefined) return;
      if (rawElement === "json" && open === "script") {
        rawElement = null;
        try {
          // Re-serialized: nothing in it can close the element.
          const json = JSON.stringify(JSON.parse(rawText)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
          out.push(`<script type="application/ld+json">${json}</script>`);
        } catch {
          dropped += 1;
        }
        return;
      }
      if (rawElement === "style" && open === "style") {
        rawElement = null;
        if (UNSAFE_CSS.test(rawText)) {
          dropped += 1;
          out.push("</style>");
        } else {
          out.push(`${rawText.replace(/<\/style/gi, "<\\/style")}</style>`);
        }
        return;
      }
      if (open.startsWith("!")) return;
      out.push(`</${open}>`);
      void implied;
    },
    oncomment() {
      // Comments are dropped (no conditional comments, nothing to hide in).
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: false, recognizeSelfClosing: true });
  parser.write(input);
  parser.end();
  return { html: out.join(""), dropped };
}
