import { sanitizeFtsQuery } from "@scalius/core/search";

export function normalizePublicSearchQuery(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizePublicFtsSearchQuery(value: string | null | undefined): string {
  const normalized = normalizePublicSearchQuery(value);
  return sanitizeFtsQuery(normalized) ? normalized : "";
}

export function normalizePublicListingSearchParam(value: string | null | undefined): string | undefined {
  return normalizePublicSearchQuery(value) || undefined;
}

export function readRepeatedPublicQueryValues(url: string): Record<string, string[]> {
  const params = new URL(url).searchParams;
  const values: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    values[key] = params.getAll(key);
  }
  return values;
}
