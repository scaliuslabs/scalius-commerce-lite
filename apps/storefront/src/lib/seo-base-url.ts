import { getRuntimeStorefrontUrl } from "@/lib/api/runtime-env";

export function getAbsoluteStorefrontSeoBaseUrl(): string | null {
  const rawUrl = getRuntimeStorefrontUrl().trim();
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function buildAbsoluteStorefrontSeoUrl(path: string): string | null {
  const baseUrl = getAbsoluteStorefrontSeoBaseUrl();
  if (!baseUrl) return null;

  return new URL(path, `${baseUrl}/`).toString();
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
