import { getRuntimeStorefrontUrl } from "@/lib/api/runtime";
import {
  normalizeResourceCanonicalPath,
  type CanonicalResourceKind,
} from "@scalius/shared/seo-canonical";
import { normalizeAbsoluteStorefrontOriginUrl } from "./storefront-origin";
import { serverPagePath } from "./server-presence";

/** The absolute Store URL origin (Platform settings), or null when it is not one. */
export function getAbsoluteStorefrontSeoBaseUrl(): string | null {
  return normalizeAbsoluteStorefrontOriginUrl(getRuntimeStorefrontUrl());
}

/** An absolute URL on the store's origin for an asset or file path, never under a presence. */
function buildAbsoluteStorefrontAssetUrl(path: string): string | null {
  const baseUrl = getAbsoluteStorefrontSeoBaseUrl();
  if (!baseUrl) return null;

  return new URL(path, `${baseUrl}/`).toString();
}

/**
 * The absolute URL of a page: under the request's subfolder presence when it
 * has one (`/en-in/products/x`), so canonical links, Open Graph URLs and
 * JSON-LD URLs of a presence page name that presence's page. Root pages are
 * unchanged.
 */
export function buildAbsoluteStorefrontSeoUrl(path: string): string | null {
  return buildAbsoluteStorefrontAssetUrl(serverPagePath(path));
}

export function buildResourceCanonicalSeoUrl(
  kind: CanonicalResourceKind,
  fallbackPath: string,
  canonicalPath?: string | null,
): string | null {
  return buildAbsoluteStorefrontSeoUrl(
    normalizeResourceCanonicalPath(kind, canonicalPath) ?? fallbackPath,
  );
}

/** An absolute image or file URL (logos, share images): relative values resolve on the store's origin. */
export function toAbsoluteStorefrontSeoUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code <= 0x1f || code === 0x7f) return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return buildAbsoluteStorefrontAssetUrl(trimmed);
  }
}
