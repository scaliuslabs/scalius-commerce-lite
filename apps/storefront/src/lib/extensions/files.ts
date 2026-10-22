// An app's storefront files on the store's own origin: `/_x/<plugin id>/<release>/<path>`
// (its stylesheet, islands, fonts and images). A release's files never
// change, so each is served immutable and kept in this data center's cache:
// after the first request a file costs one cache read. Bundled apps' files
// are compiled into this Worker; the others come from the API, which checks
// each against the release's sealed digest. The gateway answers these paths
// before Astro: no page render, no layout read.

import { INTERNAL_SERVICE_ORIGIN } from "@scalius/shared/platform-config";
import { parseStorefrontExtensionPath, storefrontFileContentType } from "@scalius/shared/plugins/storefront-protocol";
import { BUNDLED_STOREFRONT_EXTENSIONS } from "@/extensions/bundled.gen";
import { backendFetch } from "./backend";

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

/** The gateway's answer for a `/_x/…` path; null for any other path. */
export async function serveExtensionFile(request: Request, env: { BACKEND_API?: Fetcher }): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_x/")) return null;
  const notFound = () => new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const target = parseStorefrontExtensionPath(url.pathname);
  if (!target) return notFound();
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
