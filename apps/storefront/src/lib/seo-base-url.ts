import { getRuntimeStorefrontUrl } from "@/lib/api/runtime-env";
import { normalizeCanonicalPath } from "@scalius/shared/seo-canonical";
import { normalizeAbsoluteStorefrontOriginUrl } from "./storefront-origin";

export function getAbsoluteStorefrontSeoBaseUrl(): string | null {
  return normalizeAbsoluteStorefrontOriginUrl(getRuntimeStorefrontUrl());
}

export function buildAbsoluteStorefrontSeoUrl(path: string): string | null {
  const baseUrl = getAbsoluteStorefrontSeoBaseUrl();
  if (!baseUrl) return null;

  return new URL(path, `${baseUrl}/`).toString();
}

export function buildResourceCanonicalSeoUrl(
  fallbackPath: string,
  canonicalPath?: string | null,
): string | null {
  return buildAbsoluteStorefrontSeoUrl(
    normalizeCanonicalPath(canonicalPath) ?? fallbackPath,
  );
}

export function toAbsoluteStorefrontSeoUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return buildAbsoluteStorefrontSeoUrl(trimmed);
  }
}
