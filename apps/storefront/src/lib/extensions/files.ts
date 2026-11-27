// An app's storefront files on the store's own origin: `/_x/<plugin id>/<release>/<path>`
// (its stylesheet, islands, fonts and images). A release's files never
// change, so each is served immutable and kept in this data center's cache:
// after the first request a file costs one cache read. Bundled apps' files
// are compiled into this Worker; the others come from the API, which checks
// each against the release's sealed digest. The gateway answers these paths
// before Astro: no page render, no layout read.

import { INTERNAL_SERVICE_ORIGIN } from "@scalius/shared/platform-config";
import { STOREFRONT_BUYER_CHROME_FILE, STOREFRONT_FILE_PATH, parseStorefrontExtensionPath, storefrontFileContentType } from "@scalius/shared/plugins/storefront-protocol";
import { BUNDLED_STOREFRONT_EXTENSIONS } from "@/extensions/bundled.gen";
import { backendFetch } from "./backend";
import { parsePixelFrameUrl, PIXEL_FILE, pixelFrameDocument } from "../buyer-events/pixel-frame";

export interface ExtensionFile {
  bytes: Uint8Array;
  contentType: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The data-center cache key of one app file; `store` (the store's own origin) keeps one store's cache from serving another's. */
export function extensionFileCacheKey(store: string, pluginId: string, release: string, path: string): string {
  return `${INTERNAL_SERVICE_ORIGIN}/__storefront-extension/${encodeURIComponent(store)}/${pluginId}/${release}/${path}`;
}

function defaultCache(): Cache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default?: Cache }).default ?? null;
}

/** One storefront file of an app release; null when it is not one. */
export async function readExtensionFile(
  env: { BACKEND_API?: Fetcher },
  store: string,
  pluginId: string,
  release: string,
  path: string,
): Promise<ExtensionFile | null> {
  const contentType = storefrontFileContentType(path);
  if (!contentType) return null;
  const bundled = BUNDLED_STOREFRONT_EXTENSIONS[pluginId];
  if (bundled && bundled.release === release) {
    const file = (await bundled.files()).FILES[path];
    if (!file) return null;
    return { bytes: file.base64 !== undefined ? decodeBase64(file.base64) : new TextEncoder().encode(file.text ?? ""), contentType };
  }
  const cache = defaultCache();
  const key = extensionFileCacheKey(store, pluginId, release, path);
  const cached = await cache?.match(key).catch(() => undefined);
  if (cached?.ok) return { bytes: new Uint8Array(await cached.arrayBuffer()), contentType };
  const response = await backendFetch(env, `/api/v1/storefront/extensions/${encodeURIComponent(pluginId)}/${release}?path=${encodeURIComponent(path)}`);
  if (!response?.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  await cache?.put(key, new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": IMMUTABLE } })).catch(() => undefined);
  return { bytes, contentType };
}

/**
 * An app pixel's frame (lib/buyer-events/pixel-frame.ts): the release's
 * `pixel.js` inside the storefront's document, under the frame's own policy
 * (an opaque origin, its two scripts, the hosts its URL names). Immutable:
 * the URL names the release, the hosts and the storefront build.
 */
async function servePixelFrame(
  request: Request,
  env: { BACKEND_API?: Fetcher },
  store: string,
  frame: { pluginId: string; release: string; connect: string[] },
  notFound: () => Response,
): Promise<Response> {
  const file = await readExtensionFile(env, store, frame.pluginId, frame.release, PIXEL_FILE).catch(() => null);
  if (!file) return notFound();
  const { html, policy } = await pixelFrameDocument(new TextDecoder().decode(file.bytes), frame.connect);
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": IMMUTABLE,
      "Content-Security-Policy": policy,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// ── A buyer page chrome's stylesheet, on the store's own path ──────────────
//
// `/_buyer-chrome/<plugin id>/<release>/<sha256>.css`: the store's reading of
// an app's stylesheet (the release's `buyer-chrome.css`, which the upload
// accepted only as exactly what the store writes from `styles.css`), served
// only when its bytes hash to the name and are plain ASCII, as
// `text/css; charset=utf-8`, immutable. Beside it, `public/<path>` serves the
// release's public files, which the sheet's URLs name relative to it. Outside
// every app's file path (`/_x/<app>/...`): an app ships no file a buyer
// page's chrome imports. The page names the path; it never parses a sheet.

const BUYER_CHROME_PATH = /^\/_buyer-chrome\/([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)\/([0-9a-f]{64})\/(?:([0-9a-f]{64})\.css|(public\/.+))$/;

/** The store's path of a release's derived buyer-chrome sheet. */
export function buyerChromeSheetPath(pluginId: string, release: string, sha256: string): string {
  return `/_buyer-chrome/${pluginId}/${release}/${sha256}.css`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The release's derived buyer-chrome sheet and its hash; null when it ships none or it is not plain ASCII. Throws when it cannot be read now. */
export async function readBuyerChromeSheet(env: { BACKEND_API?: Fetcher }, store: string, pluginId: string, release: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  const file = await readExtensionFile(env, store, pluginId, release, STOREFRONT_BUYER_CHROME_FILE);
  if (!file) return null;
  // The store writes it in ASCII: any other byte is not the store's reading.
  if (file.bytes.some((byte) => byte < 0x20 || byte > 0x7e)) return null;
  return { bytes: file.bytes, sha256: await sha256Hex(file.bytes) };
}

async function serveBuyerChromeFile(request: Request, env: { BACKEND_API?: Fetcher }, url: URL, notFound: () => Response): Promise<Response> {
  const match = BUYER_CHROME_PATH.exec(url.pathname);
  if (!match) return notFound();
  const [, pluginId, release, sha256, publicPath] = match as unknown as [string, string, string, string | undefined, string | undefined];
  let bytes: Uint8Array;
  let contentType: string;
  if (sha256) {
    const sheet = await readBuyerChromeSheet(env, url.origin, pluginId, release).catch(() => null);
    if (!sheet || sheet.sha256 !== sha256) return notFound();
    bytes = sheet.bytes;
    contentType = "text/css; charset=utf-8";
  } else {
    const path = publicPath!;
    if (!STOREFRONT_FILE_PATH.test(path)) return notFound();
    const file = await readExtensionFile(env, url.origin, pluginId, release, path).catch(() => null);
    if (!file) return notFound();
    bytes = file.bytes;
    contentType = file.contentType;
  }
  return new Response(request.method === "HEAD" ? null : bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...(contentType === "image/svg+xml" ? { "Content-Security-Policy": "sandbox" } : {}),
    },
  });
}

/** The gateway's answer for a `/_x/…` or `/_buyer-chrome/…` path; null for any other path. */
export async function serveExtensionFile(request: Request, env: { BACKEND_API?: Fetcher }): Promise<Response | null> {
  const url = new URL(request.url);
  const buyerChrome = url.pathname.startsWith("/_buyer-chrome/");
  if (!url.pathname.startsWith("/_x/") && !buyerChrome) return null;
  const notFound = () => new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  if (buyerChrome) return serveBuyerChromeFile(request, env, url, notFound);
  const frame = parsePixelFrameUrl(url);
  if (frame) return servePixelFrame(request, env, url.origin, frame, notFound);
  const target = parseStorefrontExtensionPath(url.pathname);
  // A pixel's code runs only inside its sandboxed frame, never as a file of the store's origin.
  if (!target || target.path === PIXEL_FILE) return notFound();
  const file = await readExtensionFile(env, url.origin, target.pluginId, target.release, target.path).catch(() => null);
  if (!file) return notFound();
  return new Response(request.method === "HEAD" ? null : file.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...(file.contentType === "image/svg+xml" ? { "Content-Security-Policy": "sandbox" } : {}),
    },
  });
}
