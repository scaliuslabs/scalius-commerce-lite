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
