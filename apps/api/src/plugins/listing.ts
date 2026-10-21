// What the Apps page lists an app by (packages/plugin-sdk/docs/apps.md, "Listing"):
// its tagline, categories, countries, links and images, from the manifest of
// an installed app or from the catalog of first-party plugins this
// deployment does not bundle (catalog.gen.ts).
//
// Images are served by `GET /api/v1/admin/apps/{id}/assets/{asset}` (same
// origin, session cookie). The address carries the app's bundle fingerprint
// (`?v=`), which also covers the images (the packer seals their digests into
// the bundle), so a matching address is cached for a year and a new version
// gets a new address. Bundled and catalogued images come from the generated
// assets.gen.ts; a sandboxed app's from R2 beside its bundle. Every image is
// checked again before it is served (@scalius/shared/plugins/assets).

import { checkPluginAsset, type PluginAssetRole } from "@scalius/shared/plugins/assets";
import { pluginAssetContentType, type PluginCategory, type PluginManifest, type PluginTranslation } from "@scalius/shared/plugins";

/** One listing image compiled into the Worker. */
export interface PluginAssetFile {
  type: string;
  sha256: string;
  /** The bytes, base64. */
  data: string;
}

type ListingFields =
  | "name" | "version" | "description" | "author" | "homepage" | "icon" | "tagline" | "categories" | "screenshots"
  | "support" | "privacyPolicyUrl" | "documentationUrl" | "changelogUrl" | "countries" | "minPlatformVersion";

/** The manifest's listing, as the catalog carries it. */
export type PluginListingManifest = Pick<PluginManifest, ListingFields> & {
  translations?: Record<string, Pick<PluginTranslation, "name" | "tagline" | "description">>;
};

/** A first-party plugin this deployment does not bundle. */
export interface PluginCatalogEntry {
  id: string;
  /** The `pnpm plugin add` argument (`plugins/<dir>`). */
  source: string;
  /** The packed bundle's SHA-256: the images' cache fingerprint. */
  sha256: string;
  listing: PluginListingManifest;
}

/** `icon`, `screenshot-1` to `screenshot-6`, or `provider-<provider id>` (a provider's own icon). */
export const PLUGIN_ASSET_NAME = /^(?:icon|screenshot-[1-6]|provider-[a-z][a-z0-9_-]{0,47})$/;

export function pluginAssetUrl(pluginId: string, asset: string, fingerprint: string): string {
  return `/api/v1/admin/apps/${pluginId}/assets/${asset}?v=${fingerprint.slice(0, 16)}`;
}

/** The manifest path an asset name stands for, with the check it gets; null when the app has none. */
export function pluginAssetPath(
  listing: Pick<PluginManifest, "icon" | "screenshots"> & { providers?: PluginManifest["providers"] },
  asset: string,
): { path: string; role: PluginAssetRole } | null {
  if (asset === "icon") return listing.icon ? { path: listing.icon, role: "icon" } : null;
  if (asset.startsWith("provider-")) {
    const id = asset.slice("provider-".length);
    const icon = listing.providers?.find((provider) => provider.id === id)?.icon;
    return icon ? { path: icon, role: "icon" } : null;
  }
  const index = Number(asset.slice("screenshot-".length)) - 1;
  const path = asset.startsWith("screenshot-") ? listing.screenshots[index] : undefined;
  return path ? { path, role: "screenshot" } : null;
}

/** A provider's own icon (its brand mark), else the app's icon, else null. */
export function providerIconUrl(
  pluginId: string,
  manifest: Pick<PluginManifest, "icon" | "providers">,
  providerId: string,
  fingerprint: string,
): string | null {
  const own = manifest.providers.find((provider) => provider.id === providerId)?.icon;
  if (own) return pluginAssetUrl(pluginId, `provider-${providerId}`, fingerprint);
  return manifest.icon ? pluginAssetUrl(pluginId, "icon", fingerprint) : null;
}

/** The listing fields every app card shows. */
export function listingSummary(pluginId: string, listing: PluginListingManifest, fingerprint: string) {
  return {
    tagline: listing.tagline ?? null,
    icon: listing.icon ? pluginAssetUrl(pluginId, "icon", fingerprint) : null,
    categories: [...listing.categories] as PluginCategory[],
    countries: listing.countries ? [...listing.countries] : null,
  };
}

/** The listing fields an app's page adds. */
export function listingDetail(pluginId: string, listing: PluginListingManifest, fingerprint: string) {
  return {
    screenshots: listing.screenshots.map((_path, index) => pluginAssetUrl(pluginId, `screenshot-${index + 1}`, fingerprint)),
    support: listing.support ? { url: listing.support.url ?? null, email: listing.support.email ?? null } : null,
    privacyPolicyUrl: listing.privacyPolicyUrl ?? null,
    documentationUrl: listing.documentationUrl ?? null,
    changelogUrl: listing.changelogUrl ?? null,
    minPlatformVersion: listing.minPlatformVersion ?? null,
  };
}

function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A compiled-in image (bundled or catalogued plugin), or null. */
export async function compiledPluginAsset(pluginId: string, path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const { PLUGIN_ASSETS } = await import("./assets.gen");
  const files = Object.hasOwn(PLUGIN_ASSETS, pluginId) ? PLUGIN_ASSETS[pluginId]! : undefined;
  const file = files && Object.hasOwn(files, path) ? files[path] : undefined;
  return file ? base64Bytes(file.data) : null;
}

/** Where a sandboxed app's image is stored: beside its bundle, under the private prefix. */
export function pluginAssetKey(pluginId: string, version: string, sha256: string, path: string): string {
  return `private/plugins/${pluginId}/${version}/${sha256}/assets/${path}`;
}

/**
 * The response for one listing image after its check, or null when the bytes
 * fail it. `immutable` when the address named the current fingerprint.
 */
export function pluginAssetResponse(bytes: Uint8Array<ArrayBuffer>, path: string, role: PluginAssetRole, immutable: boolean): Response | null {
  const contentType = pluginAssetContentType(path);
  if (!contentType || checkPluginAsset(path, bytes, role) !== null) return null;
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
      // An SVG may style itself; nothing in it may run or load.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
