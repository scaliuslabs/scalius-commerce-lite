import { getRuntimeStorefrontUrl } from "@/lib/api/runtime-env";
import {
  normalizeResourceCanonicalPath,
  type CanonicalResourceKind,
} from "@scalius/shared/seo-canonical";
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
  kind: CanonicalResourceKind,
  fallbackPath: string,
  canonicalPath?: string | null,
): string | null {
  return buildAbsoluteStorefrontSeoUrl(
    normalizeResourceCanonicalPath(kind, canonicalPath) ?? fallbackPath,
  );
}

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
    return buildAbsoluteStorefrontSeoUrl(trimmed);
  }
}
