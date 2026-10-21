// The checks on a plugin's listing images (icon, screenshots;
// packages/plugin-sdk/docs/apps.md, "Listing"). The packer runs them before it
// bundles an image, and the API runs them again before it serves one, so an
// image that reaches the dashboard is always a real PNG, JPEG or WebP, or an
// SVG that cannot run code or load anything:
//
// - the bytes must match the declared type (magic numbers), within the size cap;
// - an SVG is parsed as XML and must use only drawing elements, no event
//   handler attributes, no references except to its own `#ids`, and no
//   `@import`, `url()` to outside or `expression()` in styles. No DOCTYPE or
//   entity. An SVG that breaks a rule is refused, never rewritten.
//
// The API also serves every image with `Content-Security-Policy: sandbox` and
// `nosniff`, so a check that missed something still cannot run.

import { Parser } from "htmlparser2";
import { STOREFRONT_COMPONENT_LIMITS, STOREFRONT_FILE_PATH, STOREFRONT_PUBLIC_FILE_TYPES } from "./storefront-components";
import {
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_ICON_TYPES,
  PLUGIN_SCREENSHOT_MAX_BYTES,
  PLUGIN_SCREENSHOT_TYPES,
} from "./manifest";

export type PluginAssetRole = "icon" | "screenshot";

const SVG_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "metadata", "style",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textpath",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "marker",
  "filter", "feblend", "fecolormatrix", "fecomposite", "feflood", "fegaussianblur", "femerge", "femergenode", "feoffset",
]);

/** `url(#id)` only: a reference into the same image. */
const OUTSIDE_URL = /url\(\s*(?!['"]?#)/i;
const UNSAFE_STYLE = /@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i;

/** Null when the SVG is safe to serve, else the reason it is refused. */
export function checkPluginSvg(text: string): string | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return "An SVG may not declare a DOCTYPE or entities.";
  let problem: string | null = null;
  let depth = 0;
  let root: string | null = null;
  let inStyle = false;
  const fail = (reason: string) => {
    problem ??= reason;
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const element = name.toLowerCase();
        if (depth === 0) root ??= element;
        depth += 1;
        if (!SVG_ELEMENTS.has(element)) return fail(`An SVG may not use <${name}>.`);
        if (element === "style") inStyle = true;
        for (const [attribute, value] of Object.entries(attributes)) {
          const key = attribute.toLowerCase();
          if (key.startsWith("on")) return fail(`An SVG may not use the ${attribute} attribute.`);
          if ((key === "href" || key.endsWith(":href")) && !value.trim().startsWith("#")) {
            return fail("An SVG may refer only to its own elements (#id).");
          }
          if (OUTSIDE_URL.test(value) || UNSAFE_STYLE.test(value)) return fail(`An SVG may not load anything (${attribute}).`);
        }
      },
      ontext(data) {
        if (inStyle && (OUTSIDE_URL.test(data) || UNSAFE_STYLE.test(data))) fail("An SVG style may not load anything.");
      },
      onclosetag(name) {
        depth -= 1;
        if (name.toLowerCase() === "style") inStyle = false;
      },
      onprocessinginstruction(name) {
        if (!/^\?xml$/i.test(name)) fail("An SVG may not hold processing instructions.");
      },
      oncdatastart() {
        if (!inStyle) fail("An SVG may not hold CDATA outside a style.");
      },
    },
    { xmlMode: true, recognizeCDATA: true },
  );
  parser.write(text);
  parser.end();
  if (problem) return problem;
  if (root !== "svg") return "The file is not an SVG image.";
  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Whether the bytes are what the content type says. */
function matchesType(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "image/avif":
      // An ISO-BMFF `ftyp` box of an AVIF brand.
      return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) && /^avi[fs]$/.test(String.fromCharCode(...bytes.slice(8, 12)));
    case "font/woff2":
      return startsWith(bytes, [0x77, 0x4f, 0x46, 0x32]);
    case "font/woff":
      return startsWith(bytes, [0x77, 0x4f, 0x46, 0x46]);
    default:
      return false;
  }
}

/**
 * Null when the file may be the app's icon or a screenshot, else the reason it
 * is refused. `path` is the manifest's asset path (its extension names the type).
 */
export function checkPluginAsset(path: string, bytes: Uint8Array, role: PluginAssetRole): string | null {
  const types: Record<string, string> = role === "icon" ? PLUGIN_ICON_TYPES : PLUGIN_SCREENSHOT_TYPES;
  const contentType = types[path.slice(path.lastIndexOf(".") + 1)];
  if (!contentType) return `${path}: the ${role} must be ${Object.keys(types).join(", ")}.`;
  const max = role === "icon" ? PLUGIN_ICON_MAX_BYTES : PLUGIN_SCREENSHOT_MAX_BYTES;
  if (bytes.byteLength === 0) return `${path} is empty.`;
  if (bytes.byteLength > max) return `${path} is ${bytes.byteLength} bytes; the ${role} limit is ${max}.`;
  if (contentType === "image/svg+xml") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return `${path} is not UTF-8 text.`;
    }
    const problem = checkPluginSvg(text);
    return problem ? `${path}: ${problem}` : null;
  }
  return matchesType(bytes, contentType) ? null : `${path} is not a ${contentType} file.`;
}

/**
 * Null when the file may be one of an app's storefront public files (a font
 * or an image under `public/`, served from the store's origin), else the
 * reason it is refused. The same rules as listing images: real bytes of the
 * named type, and an SVG that cannot run code or load anything.
 */
export function checkStorefrontPublicFile(path: string, bytes: Uint8Array): string | null {
  if (!STOREFRONT_FILE_PATH.test(`public/${path}`) || path.includes("..")) {
    return `public/${path}: use lower-case names (a-z, 0-9, -, _, .) at most four folders deep.`;
  }
  const contentType = STOREFRONT_PUBLIC_FILE_TYPES[path.slice(path.lastIndexOf(".") + 1)];
  if (!contentType) return `public/${path}: public files are ${Object.keys(STOREFRONT_PUBLIC_FILE_TYPES).join(", ")}.`;
  if (bytes.byteLength === 0) return `public/${path} is empty.`;
  if (bytes.byteLength > STOREFRONT_COMPONENT_LIMITS.publicFileBytes) {
    return `public/${path} is ${bytes.byteLength} bytes; one public file is at most ${STOREFRONT_COMPONENT_LIMITS.publicFileBytes}.`;
  }
  if (contentType === "image/svg+xml") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return `public/${path} is not UTF-8 text.`;
    }
    const problem = checkPluginSvg(text);
    return problem ? `public/${path}: ${problem}` : null;
  }
  return matchesType(bytes, contentType) ? null : `public/${path} is not a ${contentType} file.`;
}
